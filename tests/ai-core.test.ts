/**
 * AI 호출 로직 (v0.12.0) — 요청 만들기·스트림 진행·사용량·대체 모델·끊김 재요청·취소·오류 문구·단가.
 * 실제 API는 `npm run ai:live`로 실측한다 — 여기서는 가짜 스트림으로 규칙을 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  MAX_TOKENS_CEILING,
  buildBody,
  mapApiError,
  runCompletion,
  toModelMeta,
  tokenCaps,
  type StartStream,
  type StreamBody,
} from '../electron/ai-core';
import { AI_MODELS, type AiCompleteRequest, type AiModelMeta, type AiProgress } from '../electron/ai-types';
import { DEFAULT_MODEL, estimateUsd, loadAiModel, modelChoices, modelLabel, priceOf, priceText, saveAiModel } from '../src/ai/settings';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const req = (over: Partial<AiCompleteRequest> = {}): AiCompleteRequest => ({
  model: 'claude-opus-5-5',
  system: 'S',
  user: 'U',
  schema: { type: 'object' },
  ...over,
});

const usage = (over: Record<string, unknown> = {}) => ({
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  iterations: null,
  output_tokens_details: { thinking_tokens: 120 },
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: '{"a":1}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: usage(),
  ...over,
});

interface Step {
  events?: unknown[];
  message?: unknown;
  /** 끝나지 않는 요청 — 취소·시간 제한 확인용 */
  hang?: boolean;
  error?: unknown;
}

/** 가짜 스트림 — 요청 본문을 기록하고, 정해 둔 이벤트를 흘린 뒤 메시지를 돌려준다. signal이 끊기면 SDK처럼 APIUserAbortError */
function fakeStart(script: Step[]) {
  const bodies: StreamBody[] = [];
  const start: StartStream = (body, { signal }) => {
    const step = script[bodies.length];
    bodies.push(body);
    let listener: ((ev: never) => void) | undefined;
    return {
      on: (_event, l) => {
        listener = l as (ev: never) => void;
      },
      finalMessage: () =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Anthropic.APIUserAbortError());
          if (signal.aborted) return abort();
          signal.addEventListener('abort', abort, { once: true });
          if (step.hang) return;
          queueMicrotask(() => {
            if (step.error) return reject(step.error);
            for (const ev of step.events ?? []) listener?.(ev as never);
            resolve(step.message as never);
          });
        }),
    };
  };
  return { start, bodies };
}

describe('요청 만들기', () => {
  it('지금 모델 4종 — 모두 adaptive thinking·구조화 출력·effort, 대체 모델은 Fable·Opus·Sonnet만', () => {
    expect([...AI_MODELS]).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    for (const model of AI_MODELS) {
      const body = buildBody(req({ model, effort: 'high' }), 4096) as unknown as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } });
      expect(body.max_tokens).toBe(4096);
      const fallback = model !== 'claude-haiku-5-5';
      expect(body.fallbacks).toBe(fallback ? 'default' : undefined);
      expect(body.betas).toEqual(fallback ? ['server-side-fallback-2026-07-01'] : undefined);
      // 최신 모델이 거절하는 값은 보내지 않는다
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('tool_choice');
    }
  });

  it('목록 밖 모델 — Models API가 adaptive를 지원한다고 한 경우에만 thinking을 붙인다', () => {
    const meta: AiModelMeta = { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', createdAt: '2025-11-01T00:00:00Z', line: 'opus', maxOutput: 64000, adaptive: false, usable: true };
    const body = buildBody(req({ model: 'claude-opus-4-5' }), 4096, meta) as unknown as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(buildBody(req({ model: 'claude-opus-6' }), 4096, { ...meta, id: 'claude-opus-6', adaptive: true })).toHaveProperty('thinking', { type: 'adaptive' });
  });

  it('max_tokens — 본문 예산에 생각 여유를 더하고 상한에서 자른다', () => {
    expect(tokenCaps(req())).toEqual({ first: 16000 + 8000, ceiling: MAX_TOKENS_CEILING });
    expect(tokenCaps(req({ effort: 'low', maxTokens: 500 })).first).toBe(1024 + 2000);
    expect(tokenCaps(req({ effort: 'high', maxTokens: 32000 })).first).toBe(56000);
    expect(tokenCaps(req({ effort: 'high', maxTokens: 60000 })).first).toBe(MAX_TOKENS_CEILING);
    // 모델의 출력 한도가 더 낮으면 그 값이 상한
    const small = { id: 'm', name: 'm', createdAt: '', line: null, maxOutput: 32000, adaptive: false, usable: true };
    expect(tokenCaps(req({ effort: 'high', maxTokens: 32000 }), small)).toEqual({ first: 32000, ceiling: 32000 });
  });
});

describe('스트리밍 호출', () => {
  it('진행 단계를 흘리고 JSON·사용량(생각 토큰 포함)을 돌려준다', async () => {
    const { start, bodies } = fakeStart([
      {
        events: [
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"a"' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ':1}' } },
        ],
        message: message(),
      },
    ]);
    const seen: Array<Omit<AiProgress, 'id'>> = [];
    const res = await runCompletion(start, req(), { onProgress: (p) => seen.push(p) });
    expect(res).toMatchObject({ ok: true, json: { a: 1 }, model: 'claude-opus-5-5', fallbackUsed: false });
    if (!res.ok) throw new Error('unreachable');
    expect(res.usage).toMatchObject({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 120 });
    expect(res.usage.parts).toEqual([{ model: 'claude-opus-5-5', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }]);
    expect(seen.map((p) => p.phase)).toEqual(['connecting', 'thinking', 'writing', 'writing']);
    expect(seen.at(-1)!.chars).toBe(4); // 글자 수 알림은 0.25초에 한 번 — 첫 조각만 나간다
    expect(bodies).toHaveLength(1);
  });

  it('max_tokens에서 끊기면 상한으로 한 번만 다시 요청하고, 두 요청의 사용량을 모두 센다', async () => {
    const { start, bodies } = fakeStart([
      { message: message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }], usage: usage({ output_tokens: 24000 }) }) },
      { message: message({ usage: usage({ output_tokens: 30000 }) }) },
    ]);
    const seen: string[] = [];
    const res = await runCompletion(start, req(), { onProgress: (p) => seen.push(p.phase) });
    expect(bodies.map((b) => b.max_tokens)).toEqual([24000, MAX_TOKENS_CEILING]);
    expect(seen).toEqual(['connecting', 'retry']);
    if (!res.ok) throw new Error(res.message);
    expect(res.usage.parts).toHaveLength(2);
    expect(res.usage).toMatchObject({ input: 2000, output: 54000, thinking: 240 });
    // Opus 5.5: 입력 2,000 × $4 + 출력 54,000 × $20
    expect(estimateUsd(res.model, res.usage)).toBeCloseTo((2000 * 4 + 54000 * 20) / 1e6, 9);
  });

  it('상한에서도 끊기면 다시 요청하지 않고 알린다', async () => {
    const { start, bodies } = fakeStart([{ message: message({ stop_reason: 'max_tokens' }) }, { message: message({ stop_reason: 'max_tokens' }) }]);
    const res = await runCompletion(start, req({ effort: 'high', maxTokens: 60000 }));
    expect(bodies).toHaveLength(1);
    expect(res).toMatchObject({ ok: false, code: 'truncated' });
    const two = fakeStart([{ message: message({ stop_reason: 'max_tokens' }) }, { message: message({ stop_reason: 'max_tokens' }) }]);
    expect(await runCompletion(two.start, req())).toMatchObject({ ok: false, code: 'truncated' });
    expect(two.bodies).toHaveLength(2);
  });

  it('대체 모델이 이어 받음 — 앞 모델이 쓰던 글에 이어 붙고, 시도마다 그 모델 단가로 센다', async () => {
    const hop = { type: 'fallback', from: { model: 'claude-fable-5-2' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal' } };
    const { start } = fakeStart([
      {
        events: [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_start', index: 1, content_block: hop },
          { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        ],
        message: message({
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: '{"a":1,' }, hop, { type: 'text', text: '"b":2}' }],
          usage: usage({
            input_tokens: 1200,
            output_tokens: 700,
            iterations: [
              { type: 'message', model: 'claude-fable-5-2', input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1200, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            ],
          }),
        }),
      },
    ]);
    const seen: Array<Omit<AiProgress, 'id'>> = [];
    const res = await runCompletion(start, req({ model: 'claude-fable-5-2' }), { onProgress: (p) => seen.push(p) });
    if (!res.ok) throw new Error(res.message);
    expect(res).toMatchObject({ json: { a: 1, b: 2 }, model: 'claude-opus-4-8', fallbackUsed: true });
    expect(seen.map((p) => [p.phase, p.model])).toEqual([
      ['connecting', undefined],
      ['writing', undefined],
      ['fallback', 'claude-opus-4-8'],
      ['writing', 'claude-opus-4-8'],
    ]);
    // Fable 5.2 ($8/$40) 시도 + Opus 4.8 ($5/$25) 시도
    expect(estimateUsd(res.model, res.usage)).toBeCloseTo((1000 * 8 + 300 * 40 + 1200 * 5 + 700 * 25) / 1e6, 9);
  });

  it('대체 모델이 처음부터 다시 쓴 경우 — 마지막 fallback 블록 뒤의 글만 읽는다', async () => {
    const hop = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } };
    const { start } = fakeStart([{ message: message({ model: 'claude-opus-5', content: [{ type: 'text', text: '{"a":' }, hop, { type: 'text', text: '{"a":9}' }] }) }]);
    expect(await runCompletion(start, req())).toMatchObject({ ok: true, json: { a: 9 }, fallbackUsed: true });
  });

  it('JSON이 아니면 bad-json', async () => {
    const { start } = fakeStart([{ message: message({ content: [{ type: 'text', text: '죄송합니다' }] }) }]);
    expect(await runCompletion(start, req())).toMatchObject({ ok: false, code: 'bad-json' });
  });

  it('거부 — 분류와 다음에 할 일을 알려 준다(모델마다 다르다)', async () => {
    const refused = (category: string | null) => message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category, explanation: null } });
    const fable = await runCompletion(fakeStart([{ message: refused('cyber') }]).start, req({ model: 'claude-fable-5-2' }));
    expect(fable).toMatchObject({ ok: false, code: 'refusal' });
    expect(fable.ok ? '' : fable.message).toMatch(/보안\(해킹·취약점\).*Opus 5\.5로 바꿔/);
    const haiku = await runCompletion(fakeStart([{ message: refused(null) }]).start, req({ model: 'claude-haiku-5-5' }));
    expect(haiku.ok ? '' : haiku.message).toMatch(/Haiku는 대체 모델로 이어 받지 않습니다/);
    expect(haiku.ok ? '' : haiku.message).not.toMatch(/분류됐습니다/);
  });

  it('취소 — signal을 끊으면 요청을 멈추고 canceled로 끝난다', async () => {
    const { start } = fakeStart([{ hang: true }]);
    const ctrl = new AbortController();
    const p = runCompletion(start, req(), { signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toEqual({ ok: false, code: 'canceled', message: '요청을 취소했습니다.' });
    // 이미 끊긴 signal로 시작해도 같다
    expect(await runCompletion(fakeStart([{ hang: true }]).start, req(), { signal: ctrl.signal })).toMatchObject({ code: 'canceled' });
  });

  it('전체 제한 시간을 넘기면 멈추고 timeout', async () => {
    const { start } = fakeStart([{ hang: true }]);
    const res = await runCompletion(start, req(), { deadlineMs: 20 });
    expect(res).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('보내기 전에 막는 것 — 모델 이름 모양, 이 기능을 못 쓰는 모델', async () => {
    const { start, bodies } = fakeStart([{ message: message() }]);
    expect(await runCompletion(start, req({ model: 'gpt-x; rm' }))).toMatchObject({ ok: false, code: 'bad-request' });
    const meta: AiModelMeta = { id: 'claude-old-1', name: 'Claude Old 1', createdAt: '', line: null, maxOutput: 4096, adaptive: false, usable: false };
    const res = await runCompletion(start, req({ model: 'claude-old-1' }), { meta });
    expect(res.ok ? '' : res.message).toMatch(/Claude Old 1.*구조화 출력·effort를 지원하지 않습니다/);
    expect(bodies).toHaveLength(0);
  });

  it('스트림 도중 오류는 사용자 문구로 바꾼다', async () => {
    const { start } = fakeStart([{ error: Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()) }]);
    expect(await runCompletion(start, req())).toMatchObject({ ok: false, code: 'overloaded' });
  });
});

describe('오류 문구', () => {
  const api = (status: number, msg: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: msg } }, msg, new Headers());

  it('상태별 코드', () => {
    expect(mapApiError(api(401, 'invalid x-api-key'))).toMatchObject({ code: 'auth' });
    expect(mapApiError(api(403, 'forbidden'))).toMatchObject({ code: 'auth' });
    expect(mapApiError(api(404, 'model: claude-x'), 'claude-x')).toMatchObject({ code: 'no-model' });
    expect(mapApiError(api(429, 'rate'))).toMatchObject({ code: 'rate' });
    expect(mapApiError(api(413, 'too large'))).toMatchObject({ code: 'bad-request' });
    expect(mapApiError(api(500, 'oops'))).toMatchObject({ code: 'overloaded' });
    expect(mapApiError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ code: 'timeout' });
    expect(mapApiError(new Anthropic.APIConnectionError({ message: 'x' }))).toMatchObject({ code: 'network' });
    expect(mapApiError(new Anthropic.APIUserAbortError())).toMatchObject({ code: 'canceled' });
    expect(mapApiError(new Error('boom'))).toEqual({ ok: false, code: 'error', message: 'boom' });
  });

  it('Fable — 한도가 따로 잡혀 있고, 400이면 데이터 보관 조건을 알려 준다', () => {
    expect(mapApiError(api(429, 'rate'), 'claude-fable-5-2').message).toMatch(/Fable은 한도가 따로/);
    expect(mapApiError(api(400, 'invalid_request_error'), 'claude-fable-5-2').message).toMatch(/데이터 보관 30일/);
    expect(mapApiError(api(400, 'invalid_request_error'), 'claude-opus-5-5').message).not.toMatch(/데이터 보관/);
    expect(mapApiError(api(400, 'Your credit balance is too low to access the Anthropic API.')).message).toMatch(/크레딧이 부족/);
  });
});

describe('모델 목록(Models API)', () => {
  const info = (over: Record<string, unknown>) =>
    ({
      id: 'claude-opus-4-8',
      display_name: 'Claude Opus 4.8',
      created_at: '2026-04-01T00:00:00Z',
      line: 'opus',
      lifecycle: 'active',
      max_tokens: 128000,
      capabilities: {
        structured_outputs: { supported: true },
        effort: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      },
      ...over,
    }) as unknown as Anthropic.ModelInfo;

  it('구조화 출력·effort를 모두 지원하는 모델만 쓸 수 있다', () => {
    expect(toModelMeta(info({}))).toEqual({ id: 'claude-opus-4-8', name: 'Claude Opus 4.8', createdAt: '2026-04-01T00:00:00Z', line: 'opus', maxOutput: 128000, adaptive: true, usable: true });
    expect(toModelMeta(info({ capabilities: { structured_outputs: { supported: true }, effort: { supported: false }, thinking: { supported: false, types: {} } } }))).toMatchObject({ usable: false, adaptive: false });
    expect(toModelMeta(info({ lifecycle: 'retired' })).usable).toBe(false);
    // 능력 정보가 비어 오면 — 주력 모델은 문서 기준으로 쓸 수 있고, 모르는 모델은 쓰지 않는다
    expect(toModelMeta(info({ id: 'claude-fable-5-2', capabilities: null }))).toMatchObject({ usable: true, adaptive: true });
    expect(toModelMeta(info({ id: 'claude-new-9', capabilities: null }))).toMatchObject({ usable: false, adaptive: false });
  });

  it('고르기 목록 — 주력 4종은 항상, 그 밖에는 이 키에서 열려 있고 쓸 수 있는 모델만 최신순', () => {
    const meta = (id: string, createdAt: string, usable = true): AiModelMeta => ({ id, name: modelLabel(id), createdAt, line: null, maxOutput: 64000, adaptive: true, usable });
    const before = modelChoices(null, DEFAULT_MODEL);
    expect(before.current.map((c) => [c.id, c.available])).toEqual(AI_MODELS.map((id) => [id, null]));
    expect(before.others).toEqual([]);

    const list = {
      at: 1,
      models: [meta('claude-opus-5-5', '2026-09-22'), meta('claude-sonnet-5-5', '2026-09-28'), meta('claude-haiku-5-5', '2026-10-07'), meta('claude-opus-4-8', '2026-04-01'), meta('claude-opus-5', '2026-06-01'), meta('claude-haiku-4-5', '2025-10-01', false)],
    };
    const after = modelChoices(list, 'claude-fable-5-2');
    // 이 키에는 Fable 5.2가 아직 열리지 않았다
    expect(after.current.map((c) => c.available)).toEqual([false, true, true, true]);
    expect(after.others.map((c) => c.id)).toEqual(['claude-opus-5', 'claude-opus-4-8']);
    // 고른 모델이 목록에 없어도 선택이 사라지지 않는다
    expect(modelChoices(list, 'claude-fable-6').others[0]).toEqual({ id: 'claude-fable-6', label: 'Claude Fable 6', available: false });
  });
});

describe('단가·비용', () => {
  it('모델별 단가 — 캐시 읽기 배수가 모델마다 다르다', () => {
    const one = (model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) =>
      estimateUsd(model, { input: 0, output: 0, cacheRead: 0, ...u });
    expect(one('claude-fable-5-2', { input: 1e6, output: 1e5 })).toBeCloseTo(8 + 4, 9);
    expect(one('claude-opus-5-5', { input: 1e6, output: 1e5 })).toBeCloseTo(4 + 2, 9);
    expect(one('claude-sonnet-5-5', { input: 1e6, output: 1e5 })).toBeCloseTo(2 + 1, 9);
    expect(one('claude-haiku-5-5', { input: 1e5, output: 1e5 })).toBeCloseTo(0.01 + 0.05, 9);
    expect(one('claude-fable-5-2', { cacheRead: 1e6 })).toBeCloseTo(0.2, 9); // 0.025배
    expect(one('claude-opus-5-5', { cacheRead: 1e6 })).toBeCloseTo(0.2, 9); // 0.05배
    expect(one('claude-sonnet-5-5', { cacheRead: 1e6 })).toBeCloseTo(0.1, 9);
    expect(one('claude-opus-4-8', { cacheRead: 1e6 })).toBeCloseTo(0.5, 9); // 0.1배
    expect(one('claude-opus-5-5', { cacheWrite: 1e6 })).toBeCloseTo(5, 9); // 1.25배
  });

  it('Haiku 5.5 — 프롬프트(입력+캐시)가 10만 토큰을 넘는 요청은 높은 단가', () => {
    const u = { input: 90_000, output: 10_000, cacheRead: 20_000 };
    expect(estimateUsd('claude-haiku-5-5', u)).toBeCloseTo((90_000 * 0.5 + 20_000 * 0.5 * 0.1 + 10_000 * 2.5) / 1e6, 9);
    expect(estimateUsd('claude-haiku-5-5', { ...u, cacheRead: 10_000 })).toBeCloseTo((90_000 * 0.1 + 10_000 * 0.1 * 0.1 + 10_000 * 0.5) / 1e6, 9);
  });

  it('표에 없는 모델 — 날짜가 붙은 id는 같은 모델, 새 모델은 같은 계열로 어림, 모르는 계열은 미확인', () => {
    expect(priceOf('claude-opus-4-5-20251101')).toEqual({ price: priceOf('claude-opus-4-5')!.price, exact: true });
    expect(priceOf('claude-opus-5-7')).toEqual({ price: priceOf('claude-opus-5-5')!.price, exact: false });
    expect(priceOf('claude-nova-1')).toBeNull();
    expect(priceText('claude-fable-5-2')).toBe('$8 / $40');
    expect(priceText('claude-opus-5-7')).toBe('$4 / $20 추정');
    expect(priceText('claude-nova-1')).toBe('단가 미확인');
    expect(modelLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(modelLabel('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5');
    expect(modelLabel('claude-fable-5-2')).toBe('Claude Fable 5.2');
  });

  it('고른 모델 저장 — 목록 밖 모델도 남고, 모양이 틀리면 기본 모델', () => {
    expect(loadAiModel()).toBe('claude-opus-5-5');
    saveAiModel('claude-fable-5-2');
    expect(loadAiModel()).toBe('claude-fable-5-2');
    saveAiModel('claude-opus-6');
    expect(loadAiModel()).toBe('claude-opus-6');
    store.set('tb:ai:v1', JSON.stringify({ model: 'gpt-5' }));
    expect(loadAiModel()).toBe(DEFAULT_MODEL);
  });
});
