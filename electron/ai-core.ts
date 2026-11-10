/**
 * AI 호출의 순수 로직 — 요청 만들기, 스트림 진행 읽기, 응답·사용량·오류 해석.
 * electron을 import하지 않는다(테스트에서 가짜 스트림으로 돌린다). 키 저장·IPC는 ai.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  AI_MODEL_RE,
  isKnownModel,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiEffort,
  type AiModelMeta,
  type AiProgress,
  type AiUsage,
  type AiUsagePart,
} from './ai-types';

type BetaMessage = Anthropic.Beta.BetaMessage;
type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;
export type StreamBody = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** 스트림에서 이 모듈이 쓰는 면만 — 실제 BetaMessageStream과 테스트용 가짜가 함께 만족한다 */
export interface StreamLike {
  on(event: 'streamEvent', listener: (event: StreamEvent) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}
export type StartStream = (body: StreamBody, options: { signal: AbortSignal }) => StreamLike;

type Fail = Extract<AiCompleteResult, { ok: false }>;
export type ProgressSink = (p: Omit<AiProgress, 'id'>) => void;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * 거부(refusal) 시 서버가 대체 모델로 이어 받는 모델. 그 밖의 모델에 'default'를 보내면 대체 없이 그 모델만 돌기 때문에
 * 확인된 모델에만 붙인다(Haiku 5.5는 서버 대체가 없다).
 */
const FALLBACK_MODELS = new Set<string>(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']);

/** max_tokens 상한 — 스트리밍이라 시간 제한 없이 받을 수 있다(현재 모델의 출력 한도는 128K) */
export const MAX_TOKENS_CEILING = 64000;
/** 생각(thinking)도 max_tokens에 들어간다 — effort가 높을수록 여유를 더 둔다. 상한일 뿐이라 쓰지 않은 만큼은 과금되지 않는다 */
const THINKING_HEADROOM: Record<AiEffort, number> = { low: 2000, medium: 8000, high: 24000 };
/** 응답이 끝없이 이어질 때 멈추는 전체 제한 */
export const DEADLINE_MS = 15 * 60_000;
const PROGRESS_EVERY_MS = 250;

export function tokenCaps(req: AiCompleteRequest, meta?: AiModelMeta | null): { first: number; ceiling: number } {
  const ceiling = Math.max(1024, Math.min(meta?.maxOutput ?? MAX_TOKENS_CEILING, MAX_TOKENS_CEILING));
  const want = Math.max(req.maxTokens ?? 16000, 1024) + THINKING_HEADROOM[req.effort ?? 'medium'];
  return { first: Math.min(want, ceiling), ceiling };
}

export function buildBody(req: AiCompleteRequest, maxTokens: number, meta?: AiModelMeta | null): StreamBody {
  // 지금 주력 4종은 모두 adaptive thinking — 목록 밖 모델은 Models API가 지원한다고 한 경우에만 붙인다
  const adaptive = meta ? meta.adaptive : isKnownModel(req.model);
  return {
    model: req.model,
    max_tokens: maxTokens,
    ...(FALLBACK_MODELS.has(req.model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    ...(adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
    output_config: {
      effort: req.effort ?? 'medium',
      format: { type: 'json_schema', schema: req.schema },
    },
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  };
}

/** 청구 단위별 사용량 — 대체 모델이 이어 받았으면 usage.iterations에 시도마다 한 줄씩 있다(최상위 usage는 마지막 시도만) */
export function usageParts(msg: BetaMessage): AiUsagePart[] {
  const u = msg.usage;
  const parts: AiUsagePart[] = [];
  for (const it of Array.isArray(u.iterations) ? u.iterations : []) {
    const r = it as {
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
    if (typeof r.input_tokens !== 'number' || typeof r.output_tokens !== 'number') continue;
    parts.push({
      model: r.model ?? msg.model,
      input: r.input_tokens,
      output: r.output_tokens,
      cacheRead: r.cache_read_input_tokens ?? 0,
      cacheWrite: r.cache_creation_input_tokens ?? 0,
    });
  }
  if (parts.length) return parts;
  return [
    {
      model: msg.model,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
  ];
}

export function sumUsage(parts: AiUsagePart[], thinking: number): AiUsage {
  const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => parts.reduce((n, p) => n + p[k], 0);
  return { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), thinking, parts };
}

/** 대체 모델이 응답을 만들었는가 — 신호는 usage.iterations의 fallback_message(본문의 fallback 블록은 보조) */
export function servedByFallback(msg: BetaMessage): boolean {
  if (msg.stop_reason === 'refusal') return false;
  const its = Array.isArray(msg.usage.iterations) ? msg.usage.iterations : [];
  return its.some((it) => (it as { type?: string }).type === 'fallback_message') || msg.content.some((b) => b.type === 'fallback');
}

/**
 * 응답 본문 → JSON. 스트리밍 중 대체 모델로 넘어가면 앞 모델이 쓰던 글을 이어 쓰므로 text 블록을 모두 잇는다.
 * 대체 모델이 처음부터 다시 쓴 경우에는 마지막 fallback 블록 뒤의 글만 읽는다.
 */
export function extractJson(msg: BetaMessage): { ok: true; json: unknown } | { ok: false } {
  const texts = (blocks: BetaMessage['content']) =>
    blocks
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  const tries = [texts(msg.content)];
  const lastFallback = msg.content.map((b) => b.type).lastIndexOf('fallback');
  if (lastFallback >= 0) tries.push(texts(msg.content.slice(lastFallback + 1)));
  for (const t of tries) {
    if (!t.trim()) continue;
    try {
      return { ok: true, json: JSON.parse(t) };
    } catch {
      // 다음 후보
    }
  }
  return { ok: false };
}

const REFUSAL_WHY: Record<string, string> = {
  cyber: '보안(해킹·취약점) 관련 내용으로 분류됐습니다',
  bio: '생물·화학 위험 관련 내용으로 분류됐습니다',
  frontier_llm: 'AI 모델 개발 관련 내용으로 분류됐습니다',
  reasoning_extraction: '모델의 내부 추론을 그대로 쓰게 하는 요청으로 분류됐습니다',
  general_harms: '유해할 수 있는 내용으로 분류됐습니다',
};

export function refusalFail(msg: BetaMessage, requested: string): Fail {
  const cat = msg.stop_details?.category ?? null;
  const why = cat && REFUSAL_WHY[cat] ? ` — ${REFUSAL_WHY[cat]}(업무 기록도 걸릴 수 있습니다)` : '';
  const next = requested.startsWith('claude-fable')
    ? 'Fable은 보안·AI 관련 내용에 더 엄격합니다. 도움말(F1) > AI 정돈에서 Opus 5.5로 바꿔 다시 실행하세요.'
    : requested.startsWith('claude-haiku')
      ? 'Haiku는 대체 모델로 이어 받지 않습니다. 도움말(F1) > AI 정돈에서 Opus 5.5나 Sonnet 5.5로 바꿔 다시 실행하세요.'
      : '걸릴 만한 줄을 빼거나 다른 모델로 다시 실행하세요.';
  return { ok: false, code: 'refusal', message: `Claude가 이 요청을 처리하지 않았습니다${why}. ${next}` };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SDK 오류 → 사용자에게 보일 코드·문구 (좁은 것부터) */
export function mapApiError(err: unknown, model = ''): Fail {
  const fable = model.startsWith('claude-fable');
  if (err instanceof Anthropic.APIUserAbortError) {
    return { ok: false, code: 'canceled', message: '요청을 취소했습니다.' };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { ok: false, code: 'timeout', message: 'Claude API가 응답을 시작하지 않았습니다(3분). 잠시 뒤 다시 실행하세요.' };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { ok: false, code: 'auth', message: 'API 키가 올바르지 않습니다(만료·삭제됐을 수 있음). 도움말(F1) > AI 정돈에서 키를 다시 저장하세요.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { ok: false, code: 'auth', message: '이 키로는 이 모델을 쓸 권한이 없습니다. 다른 모델을 고르거나 키 권한을 확인하세요.' };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return {
      ok: false,
      code: 'no-model',
      message: `이 키에서 ${model || '이 모델'}을(를) 찾지 못했습니다. 도움말(F1) > AI 정돈에서 [연결 확인]으로 쓸 수 있는 모델을 확인하세요.`,
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      ok: false,
      code: 'rate',
      message: fable
        ? '요청 한도를 넘었습니다. Fable은 한도가 따로(더 낮게) 잡혀 있습니다 — 잠시 뒤 다시 실행하거나 Opus 5.5로 바꾸세요.'
        : '요청 한도를 넘었습니다. 잠시 뒤 다시 실행하세요.',
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) {
      return { ok: false, code: 'bad-request', message: 'API 크레딧이 부족합니다. Claude Console의 결제(Billing)에서 잔액을 확인하세요.' };
    }
    const hint = fable ? ' (Fable은 조직의 데이터 보관 30일 설정이 필요합니다 — 보관 0일(ZDR) 조직이면 Opus 5.5를 쓰세요.)' : '';
    return { ok: false, code: 'bad-request', message: `요청이 거절됐습니다: ${err.message}${hint}` };
  }
  if (err instanceof Anthropic.APIError && err.status === 413) {
    return { ok: false, code: 'bad-request', message: '보낼 내용이 너무 큽니다. 범위를 줄여 다시 실행하세요.' };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { ok: false, code: 'overloaded', message: 'Claude 서버가 바쁩니다. 잠시 뒤 다시 실행하세요.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { ok: false, code: 'network', message: 'Claude API에 연결하지 못했습니다. 네트워크를 확인하세요.' };
  }
  if (err instanceof Anthropic.APIError) {
    // 스트림 도중 온 오류 이벤트는 status 없이 온다 — overloaded_error는 다시 실행하면 된다
    if (/overloaded/i.test(err.message)) {
      return { ok: false, code: 'overloaded', message: 'Claude 서버가 바쁩니다. 잠시 뒤 다시 실행하세요.' };
    }
    return { ok: false, code: 'error', message: `Claude API 오류 ${err.status ?? ''}: ${err.message}`.trim() };
  }
  // 응답을 받는 도중 연결이 끊기면 SDK가 API 오류가 아닌 일반 오류('terminated' 등)를 던진다 — 자동으로 다시 보내지 않는다
  if (/terminated|ECONNRESET|socket|fetch failed|network|other side closed|premature/i.test(errMsg(err))) {
    return { ok: false, code: 'network', message: '응답을 받는 중 연결이 끊겼습니다. 네트워크를 확인하고 다시 실행하세요.' };
  }
  return { ok: false, code: 'error', message: errMsg(err) };
}

/** Models API 응답 → 이 앱이 쓰는 값 */
export function toModelMeta(m: Anthropic.ModelInfo): AiModelMeta {
  const cap = m.capabilities;
  const known = isKnownModel(m.id);
  return {
    id: m.id,
    name: m.display_name || m.id,
    createdAt: m.created_at,
    line: m.line ?? null,
    maxOutput: m.max_tokens ?? null,
    // 능력 정보가 비어 오면 주력 4종은 문서 기준(모두 adaptive·구조화 출력·effort 지원)으로 본다
    adaptive: cap ? !!cap.thinking?.types?.adaptive?.supported : known,
    usable: m.lifecycle !== 'retired' && (cap ? !!cap.structured_outputs?.supported && !!cap.effort?.supported : known),
  };
}

export interface CompleteOptions {
  signal?: AbortSignal;
  onProgress?: ProgressSink;
  meta?: AiModelMeta | null;
  /** 전체 제한 시간 — 테스트에서 줄인다 */
  deadlineMs?: number;
}

/** 한 번의 스트리밍 요청 — 진행 상황을 흘리고 끝난 메시지를 돌려준다 */
function streamOnce(start: StartStream, body: StreamBody, signal: AbortSignal, emit: ProgressSink): Promise<BetaMessage> {
  const stream = start(body, { signal });
  let chars = 0;
  let model: string | undefined;
  let last = 0;
  stream.on('streamEvent', (ev) => {
    if (ev.type === 'content_block_start') {
      const block = ev.content_block;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') emit({ phase: 'thinking', chars, model });
      else if (block.type === 'fallback') {
        model = block.to.model;
        emit({ phase: 'fallback', chars, model });
      } else if (block.type === 'text') emit({ phase: 'writing', chars, model });
    } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      chars += ev.delta.text.length;
      const now = Date.now();
      if (now - last >= PROGRESS_EVERY_MS) {
        last = now;
        emit({ phase: 'writing', chars, model });
      }
    }
  });
  return stream.finalMessage();
}

/**
 * 구조화 출력(JSON) 한 건을 받는다.
 * - 스트리밍으로 받는다: 응답이 길어도 HTTP 시간 제한에 걸려 같은 요청을 다시 보내는(이중 과금) 일이 없다.
 * - max_tokens에서 끊기면 상한까지 올려 한 번만 다시 요청한다.
 * - 대체 모델이 이어 받은 경우와 다시 요청한 경우의 사용량을 청구 단위별로 모은다.
 */
export async function runCompletion(start: StartStream, input: AiCompleteRequest, opts: CompleteOptions = {}): Promise<AiCompleteResult> {
  if (typeof input?.model !== 'string' || !AI_MODEL_RE.test(input.model)) {
    return { ok: false, code: 'bad-request', message: `모델 이름이 올바르지 않습니다: ${String(input?.model)}` };
  }
  // IPC로 넘어온 값이다 — 모양이 틀린 effort·maxTokens는 기본값으로 돌린다
  const req: AiCompleteRequest = {
    ...input,
    effort: input.effort && input.effort in THINKING_HEADROOM ? input.effort : 'medium',
    maxTokens: typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) ? input.maxTokens : undefined,
  };
  if (opts.meta && !opts.meta.usable) {
    return { ok: false, code: 'bad-request', message: `${opts.meta.name}은(는) 이 기능에 필요한 구조화 출력·effort를 지원하지 않습니다. 다른 모델을 고르세요.` };
  }
  const started = Date.now();
  const emit: ProgressSink = (p) => {
    try {
      opts.onProgress?.(p);
    } catch {
      // 진행 알림 실패가 요청을 깨지 않게
    }
  };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.deadlineMs ?? DEADLINE_MS);

  const { first, ceiling } = tokenCaps(req, opts.meta);
  const parts: AiUsagePart[] = [];
  let thinking = 0;
  let cap = first;
  try {
    for (let attempt = 1; ; attempt++) {
      emit({ phase: attempt === 1 ? 'connecting' : 'retry', chars: 0 });
      const msg = await streamOnce(start, buildBody(req, cap, opts.meta), ctrl.signal, emit);
      parts.push(...usageParts(msg));
      thinking += msg.usage.output_tokens_details?.thinking_tokens ?? 0;
      if (msg.stop_reason === 'refusal') return refusalFail(msg, req.model);
      if (msg.stop_reason === 'max_tokens') {
        if (attempt === 1 && cap < ceiling) {
          cap = ceiling;
          continue;
        }
        return {
          ok: false,
          code: 'truncated',
          message: `응답이 한도(${cap.toLocaleString()}토큰)에서 끊겼습니다. 범위를 줄여 다시 실행하세요.`,
        };
      }
      const parsed = extractJson(msg);
      if (!parsed.ok) {
        return { ok: false, code: 'bad-json', message: '응답을 읽지 못했습니다(JSON 아님). 다시 실행하세요.' };
      }
      return {
        ok: true,
        json: parsed.json,
        model: msg.model,
        usage: sumUsage(parts, thinking),
        fallbackUsed: servedByFallback(msg),
        ms: Date.now() - started,
      };
    }
  } catch (err) {
    if (timedOut) {
      const min = Math.round((opts.deadlineMs ?? DEADLINE_MS) / 60_000);
      return { ok: false, code: 'timeout', message: `${min}분 안에 끝나지 않아 멈췄습니다. 범위를 줄이거나 더 빠른 모델로 다시 실행하세요.` };
    }
    if (opts.signal?.aborted) return { ok: false, code: 'canceled', message: '요청을 취소했습니다.' };
    return mapApiError(err, req.model);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
