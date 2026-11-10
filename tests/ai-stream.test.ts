// @vitest-environment node
/**
 * AI 호출 — 실제 SDK(@anthropic-ai/sdk)의 스트림을 로컬 가짜 서버(SSE)에 붙여 본다.
 * ai-core.test.ts는 스트림까지 가짜라 SDK가 실제로 어떻게 동작하는지는 보지 못한다. 여기서 확인하는 것:
 * 보내는 본문·헤더, 스트림 이벤트 → 진행 단계, 응답이 시간 제한(timeout)보다 길어도 한 번만 요청하는지,
 * 취소가 연결을 실제로 끊는지, 대체 모델·끊김 재요청·오류가 SDK를 거쳐도 같은 결과인지.
 * (서버가 각 모델에서 이 파라미터를 받아 주는지는 `npm run ai:live` 실측으로만 확인된다.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { runCompletion, type StartStream } from '../electron/ai-core';
import type { AiCompleteRequest, AiProgress } from '../electron/ai-types';

type Json = Record<string, unknown>;
interface Seen {
  body: Json;
  beta: string | undefined;
  path: string;
  /** 응답을 다 보내기 전에 클라이언트가 연결을 끊었다 */
  aborted: boolean;
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen, nth: number) => void | Promise<void>;

let server: http.Server;
let baseURL = '';
let handler: Handler = () => {};
const requests: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const seen: Seen = { body: raw ? (JSON.parse(raw) as Json) : {}, beta: req.headers['anthropic-beta'] as string | undefined, path: req.url ?? '', aborted: false };
      res.on('close', () => {
        if (!res.writableEnded) seen.aborted = true;
      });
      requests.push(seen);
      void handler(req, res, seen, requests.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sse = (res: http.ServerResponse, ev: Json) => res.write(`event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`);
const open = (res: http.ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

const startMsg = (model: string): Json => ({
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const blockStart = (index: number, content_block: Json): Json => ({ type: 'content_block_start', index, content_block });
const textDelta = (index: number, text: string): Json => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index: number): Json => ({ type: 'content_block_stop', index });
const end = (stop_reason: string, usage: Json, stop_details: Json | null = null): Json[] => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details }, usage },
  { type: 'message_stop' },
];

/** 생각 블록 → 글 블록(조각 여럿) → 끝. 실제 응답의 이벤트 순서와 같다 */
function sendAnswer(res: http.ServerResponse, model: string, chunks: string[], usage: Json = { output_tokens: 500, output_tokens_details: { thinking_tokens: 120 } }) {
  open(res);
  sse(res, startMsg(model));
  sse(res, blockStart(0, { type: 'thinking', thinking: '', signature: '' }));
  sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
  sse(res, blockStop(0));
  sse(res, blockStart(1, { type: 'text', text: '' }));
  for (const c of chunks) sse(res, textDelta(1, c));
  sse(res, blockStop(1));
  for (const ev of end('end_turn', usage)) sse(res, ev);
  res.end();
}

/** ai.ts의 completeJson과 같은 방식으로 실제 SDK 스트림을 연다 */
function sdk(opts: { timeout?: number; maxRetries?: number } = {}): StartStream {
  const client = new Anthropic({ apiKey: 'sk-ant-test', baseURL, maxRetries: opts.maxRetries ?? 0, timeout: opts.timeout ?? 5000 });
  return (body, o) => client.beta.messages.stream(body, o);
}

const req = (over: Partial<AiCompleteRequest> = {}): AiCompleteRequest => ({
  model: 'claude-fable-5-2',
  system: 'S',
  user: 'U',
  schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
  effort: 'high',
  maxTokens: 4000,
  ...over,
});

describe('실제 SDK 스트림 + 가짜 서버', () => {
  it('보내는 본문·헤더 — 스트리밍, adaptive thinking, 구조화 출력, effort, 대체 모델(베타 헤더)', async () => {
    handler = (_q, res) => sendAnswer(res, 'claude-fable-5-2', ['{"a"', ':1}']);
    const phases: AiProgress['phase'][] = [];
    const res = await runCompletion(sdk(), req(), { onProgress: (p) => phases.push(p.phase) });
    expect(res).toMatchObject({ ok: true, json: { a: 1 }, model: 'claude-fable-5-2', fallbackUsed: false });
    if (!res.ok) throw new Error('unreachable');
    expect(res.usage).toMatchObject({ input: 1000, output: 500, thinking: 120 });
    expect(phases.slice(0, 3)).toEqual(['connecting', 'thinking', 'writing']);

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.path).toBe('/v1/messages?beta=true');
    expect(sent.beta).toContain('server-side-fallback-2026-07-01');
    expect(sent.body).toMatchObject({
      model: 'claude-fable-5-2',
      stream: true,
      max_tokens: 4000 + 24000,
      thinking: { type: 'adaptive' },
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      system: 'S',
      messages: [{ role: 'user', content: 'U' }],
    });
    // 최신 모델이 400으로 거절하는 값은 본문에 없다
    for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'betas']) expect(sent.body).not.toHaveProperty(k);
  });

  it('Haiku 5.5 — 대체 모델 설정·베타 헤더를 붙이지 않는다', async () => {
    handler = (_q, res) => sendAnswer(res, 'claude-haiku-5-5', ['{"a":2}']);
    const res = await runCompletion(sdk(), req({ model: 'claude-haiku-5-5', effort: 'medium' }));
    expect(res).toMatchObject({ ok: true, json: { a: 2 } });
    expect(requests[0].beta ?? '').not.toContain('server-side-fallback');
    expect(requests[0].body).not.toHaveProperty('fallbacks');
    expect(requests[0].body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
  });

  it('응답이 시간 제한(timeout)보다 오래 걸려도 끊기지 않고, 요청은 한 번만 나간다', async () => {
    handler = async (_q, res) => {
      open(res);
      sse(res, startMsg('claude-opus-5-5'));
      sse(res, blockStart(0, { type: 'text', text: '' }));
      for (const c of ['{"a"', ':', '3', '}']) {
        await sleep(150);
        sse(res, textDelta(0, c));
      }
      sse(res, blockStop(0));
      for (const ev of end('end_turn', { output_tokens: 10 })) sse(res, ev);
      res.end();
    };
    // timeout 200ms · 재시도 2회 허용 — 본문에 시간 제한이 걸리면 여기서 재요청(이중 과금)이 생긴다
    const res = await runCompletion(sdk({ timeout: 200, maxRetries: 2 }), req({ model: 'claude-opus-5-5' }));
    expect(res).toMatchObject({ ok: true, json: { a: 3 } });
    expect(requests).toHaveLength(1);
  });

  it('취소 — 스트림 도중 끊으면 서버 연결이 실제로 닫히고 canceled로 끝난다', async () => {
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-fable-5-2'));
      sse(res, blockStart(0, { type: 'thinking', thinking: '', signature: '' }));
      // 생각이 길게 이어지는 상황 — 응답을 끝내지 않는다
    };
    const ctrl = new AbortController();
    const res = await runCompletion(sdk(), req(), { signal: ctrl.signal, onProgress: (p) => p.phase === 'thinking' && ctrl.abort() });
    expect(res).toEqual({ ok: false, code: 'canceled', message: '요청을 취소했습니다.' });
    for (let i = 0; i < 50 && !requests[0].aborted; i++) await sleep(10);
    expect(requests[0].aborted).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('전체 제한 시간 — 끝나지 않는 응답은 끊고 timeout', async () => {
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-opus-5-5'));
    };
    const res = await runCompletion(sdk(), req({ model: 'claude-opus-5-5' }), { deadlineMs: 150 });
    expect(res).toMatchObject({ ok: false, code: 'timeout' });
    for (let i = 0; i < 50 && !requests[0].aborted; i++) await sleep(10);
    expect(requests[0].aborted).toBe(true);
  });

  it('스트림 도중 대체 모델로 넘어감 — 글이 이어 붙고, 응답 모델·시도별 사용량이 바뀐다', async () => {
    const hop = { type: 'fallback', from: { model: 'claude-fable-5-2' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } };
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-fable-5-2'));
      sse(res, blockStart(0, { type: 'text', text: '' }));
      sse(res, textDelta(0, '{"a":'));
      sse(res, blockStop(0));
      sse(res, blockStart(1, hop));
      sse(res, blockStop(1));
      sse(res, blockStart(2, { type: 'text', text: '' }));
      sse(res, textDelta(2, '4}'));
      sse(res, blockStop(2));
      for (const ev of end('end_turn', {
        input_tokens: 1200,
        output_tokens: 700,
        iterations: [
          { type: 'message', model: 'claude-fable-5-2', input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1200, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      }))
        sse(res, ev);
      res.end();
    };
    const seen: Array<[string, string | undefined]> = [];
    const res = await runCompletion(sdk(), req(), { onProgress: (p) => seen.push([p.phase, p.model]) });
    if (!res.ok) throw new Error(res.message);
    expect(res).toMatchObject({ json: { a: 4 }, model: 'claude-opus-4-8', fallbackUsed: true });
    expect(res.usage.parts).toEqual([
      { model: 'claude-fable-5-2', input: 1000, output: 300, cacheRead: 0, cacheWrite: 0 },
      { model: 'claude-opus-4-8', input: 1200, output: 700, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(seen).toContainEqual(['fallback', 'claude-opus-4-8']);
    expect(seen.at(-1)).toEqual(['writing', 'claude-opus-4-8']);
  });

  it('max_tokens에서 끊기면 상한(64,000)으로 한 번 더 요청한다', async () => {
    handler = (_q, res, _seen, nth) => {
      if (nth === 1) {
        open(res);
        sse(res, startMsg('claude-opus-5-5'));
        sse(res, blockStart(0, { type: 'text', text: '' }));
        sse(res, textDelta(0, '{"a":'));
        sse(res, blockStop(0));
        for (const ev of end('max_tokens', { output_tokens: 12000 })) sse(res, ev);
        res.end();
      } else sendAnswer(res, 'claude-opus-5-5', ['{"a":5}'], { output_tokens: 15000 });
    };
    const phases: string[] = [];
    const res = await runCompletion(sdk(), req({ model: 'claude-opus-5-5', effort: 'medium' }), { onProgress: (p) => phases.push(p.phase) });
    if (!res.ok) throw new Error(res.message);
    expect(res.json).toEqual({ a: 5 });
    expect(requests.map((r) => r.body.max_tokens)).toEqual([12000, 64000]);
    expect(phases).toContain('retry');
    expect(res.usage).toMatchObject({ input: 2000, output: 27000 });
    expect(res.usage.parts).toHaveLength(2);
  });

  it('거부(HTTP 200 · stop_reason refusal) — 분류를 읽어 알려 준다', async () => {
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-fable-5-2'));
      for (const ev of end('refusal', { output_tokens: 3 }, { type: 'refusal', category: 'frontier_llm', explanation: null })) sse(res, ev);
      res.end();
    };
    const res = await runCompletion(sdk(), req());
    expect(res).toMatchObject({ ok: false, code: 'refusal' });
    expect(res.ok ? '' : res.message).toMatch(/AI 모델 개발 관련 내용으로 분류됐습니다.*Opus 5\.5로 바꿔/);
  });

  it('HTTP 오류 — 401 키 오류, 404 모델 없음, 400 Fable 안내, 529 과부하', async () => {
    const fail = (status: number, type: string, message: string): Handler => (_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    };
    handler = fail(401, 'authentication_error', 'invalid x-api-key');
    expect(await runCompletion(sdk(), req())).toMatchObject({ ok: false, code: 'auth' });
    handler = fail(404, 'not_found_error', 'model: claude-fable-5-2');
    expect(await runCompletion(sdk(), req())).toMatchObject({ ok: false, code: 'no-model' });
    handler = fail(400, 'invalid_request_error', 'This model requires 30-day data retention.');
    const bad = await runCompletion(sdk(), req());
    expect(bad).toMatchObject({ ok: false, code: 'bad-request' });
    expect(bad.ok ? '' : bad.message).toMatch(/30-day data retention.*보관 0일\(ZDR\) 조직이면 Opus 5\.5/);
    handler = fail(529, 'overloaded_error', 'Overloaded');
    expect(await runCompletion(sdk(), req())).toMatchObject({ ok: false, code: 'overloaded' });
  });

  it('스트림 도중 오류 이벤트(overloaded) — 다시 실행하라고 알린다', async () => {
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-opus-5-5'));
      sse(res, blockStart(0, { type: 'text', text: '' }));
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
      res.end();
    };
    const res = await runCompletion(sdk(), req({ model: 'claude-opus-5-5' }));
    expect(res).toMatchObject({ ok: false, code: 'overloaded' });
  });

  it('연결이 중간에 끊기면(본문 미완성) network 오류로 알리고, 스스로 다시 보내지 않는다', async () => {
    handler = (_q, res) => {
      open(res);
      sse(res, startMsg('claude-opus-5-5'));
      sse(res, blockStart(0, { type: 'text', text: '' }));
      sse(res, textDelta(0, '{"a":'));
      setTimeout(() => res.destroy(), 50); // 헤더·앞부분이 나간 뒤에 끊는다
    };
    const res = await runCompletion(sdk({ maxRetries: 2 }), req({ model: 'claude-opus-5-5' }));
    expect(res).toEqual({ ok: false, code: 'network', message: '응답을 받는 중 연결이 끊겼습니다. 네트워크를 확인하고 다시 실행하세요.' });
    expect(requests).toHaveLength(1);
  });
});
