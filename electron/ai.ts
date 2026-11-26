/**
 * AI 기능 — Claude API 호출 (main 프로세스 전용).
 * API 키는 OS 암호화(safeStorage, Windows DPAPI)로 userData/ai-key.bin에 저장하고 renderer로 돌려주지 않는다.
 * 입력은 renderer가 마스킹을 마친 문자열이다 — 여기서는 보내고 받기만 한다. 요청·응답 해석은 ai-core.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { errMsg } from './util';
import { ipcMain } from 'electron';
import { mapApiError, runCompletion, toModelMeta, type ProgressSink } from './ai-core';
import { encryptionAvailable, makeKeyStore } from './secure-store';
import {
  AI_MODEL_RE,
  isKnownModel,
  type AiCompleteRequest,
  type AiCompleteResult,
  type AiKeyStatus,
  type AiModelMeta,
  type AiModelsResult,
  type AiProgress,
} from './ai-types';

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

const keys = makeKeyStore('ai-key.bin', 'ANTHROPIC_API_KEY');

function client(apiKey: string): Anthropic {
  // baseURL 고정 — 개발 셸의 ANTHROPIC_BASE_URL(다른 프록시)을 따라가지 않게.
  // timeout은 응답이 시작될 때까지만 잰다(스트리밍 본문에는 걸리지 않는다) — 전체 제한은 ai-core의 DEADLINE_MS
  return new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 2, timeout: 180_000 });
}

/** Models API로 확인한 모델 정보 — 앱이 떠 있는 동안 기억한다 */
const metaCache = new Map<string, AiModelMeta>();

/** 이 키에서 열린 모델 — Models API(토큰 비용 없음). 연결 확인을 겸한다 */
export async function availableModels(apiKey?: string | null): Promise<AiModelsResult> {
  const key = apiKey ?? (await keys.resolve());
  if (!key) return { ok: false, code: 'no-key', message: 'API 키가 없습니다.' };
  try {
    const models: AiModelMeta[] = [];
    for await (const m of client(key).models.list({ limit: 100 })) models.push(toModelMeta(m));
    for (const m of models) metaCache.set(m.id, m);
    return { ok: true, models, at: Date.now() };
  } catch (err) {
    return mapApiError(err);
  }
}

export interface CompleteJsonOptions {
  apiKey?: string | null;
  signal?: AbortSignal;
  onProgress?: ProgressSink;
}

export async function completeJson(req: AiCompleteRequest, opts: CompleteJsonOptions = {}): Promise<AiCompleteResult> {
  const key = opts.apiKey ?? (await keys.resolve());
  if (!key) {
    return { ok: false, code: 'no-key', message: 'API 키가 없습니다. 설정(F1) > AI에서 키를 저장하세요.' };
  }
  if (typeof req?.model !== 'string' || !AI_MODEL_RE.test(req.model)) {
    return { ok: false, code: 'bad-request', message: `모델 이름이 올바르지 않습니다: ${String(req?.model)}` };
  }
  const anthropic = client(key);
  let meta = metaCache.get(req.model) ?? null;
  if (!meta && !isKnownModel(req.model)) {
    // 목록 밖 모델은 보내기 전에 한 번 조회해 지원 범위를 확인한다(토큰 비용 없음)
    try {
      meta = toModelMeta(await anthropic.models.retrieve(req.model, undefined, { signal: opts.signal }));
      metaCache.set(meta.id, meta);
    } catch (err) {
      if (opts.signal?.aborted) return { ok: false, code: 'canceled', message: '요청을 취소했습니다.' };
      return mapApiError(err, req.model);
    }
  }
  return runCompletion((body, o) => anthropic.beta.messages.stream(body, o), req, {
    signal: opts.signal,
    onProgress: opts.onProgress,
    meta,
  });
}

/** 진행 중인 요청 — renderer가 준 id로 취소한다 */
const running = new Map<string, AbortController>();

export function registerAiIpc(): void {
  ipcMain.handle('ai:key-status', async (): Promise<AiKeyStatus> => ({
    stored: (await keys.read()) !== null,
    env: keys.env() !== null,
    encryption: await encryptionAvailable(),
  }));

  ipcMain.handle('ai:key-set', async (_evt, raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY_RE.test(key)) return { ok: false, error: 'sk-ant- 로 시작하는 API 키가 아닙니다.' };
    if (!(await encryptionAvailable())) return { ok: false, error: '이 PC에서는 키를 암호화해 저장할 수 없습니다.' };
    try {
      await keys.write(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('ai:key-clear', async (): Promise<{ ok: boolean }> => {
    await keys.clear();
    return { ok: true };
  });

  // 연결 확인 겸 모델 목록 — 이 키에서 열린 모델을 Models API로 조회한다(토큰 비용 없음)
  ipcMain.handle('ai:models', () => availableModels());

  ipcMain.handle('ai:complete', async (evt, req: AiCompleteRequest): Promise<AiCompleteResult> => {
    const id = typeof req?.id === 'string' && req.id ? req.id : null;
    const ctrl = new AbortController();
    if (id) running.set(id, ctrl);
    // 창이 닫히면 받을 곳이 없다 — 요청을 멈춰 그 뒤 생성분이 과금되지 않게 한다
    const onGone = () => ctrl.abort();
    evt.sender.once('destroyed', onGone);
    const onProgress: ProgressSink | undefined = id
      ? (p) => {
          if (!evt.sender.isDestroyed()) evt.sender.send('ai:progress', { id, ...p } satisfies AiProgress);
        }
      : undefined;
    try {
      return await completeJson(req, { signal: ctrl.signal, onProgress });
    } finally {
      if (id) running.delete(id);
      if (!evt.sender.isDestroyed()) evt.sender.removeListener('destroyed', onGone);
    }
  });

  ipcMain.handle('ai:cancel', (_evt, id: unknown): { ok: boolean } => {
    const ctrl = typeof id === 'string' ? running.get(id) : undefined;
    ctrl?.abort();
    return { ok: !!ctrl };
  });
}
