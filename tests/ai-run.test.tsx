/**
 * AI 호출 화면 (v0.12.0) — 호출 중 진행 표시·취소, 설정의 모델 목록(이 키에서 열린 모델).
 * main(실제 API)은 가짜 reportApi로 대신한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import type { AiCompleteRequest, AiCompleteResult, AiModelMeta, AiModelsResult, AiProgress } from '../electron/ai-types';
import { elapsedText, progressText } from '../src/ai/client';
import { useAiTidy } from '../src/ai/useAiTidy';
import { AiSettings } from '../src/components/AiSettings';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

/** 가짜 main — aiComplete는 테스트가 끝내 줄 때까지 기다리고, aiCancel은 main처럼 canceled로 끝낸다 */
function stubApi(over: Record<string, Mock> = {}) {
  const calls: AiCompleteRequest[] = [];
  let finish: (r: AiCompleteResult) => void = () => {};
  let progress: (p: AiProgress) => void = () => {};
  const off = vi.fn();
  const api: Record<string, Mock> = {
    aiComplete: vi.fn((req: AiCompleteRequest) => {
      calls.push(req);
      return new Promise<AiCompleteResult>((resolve) => {
        finish = resolve;
      });
    }),
    aiCancel: vi.fn(async (_id: string) => {
      finish({ ok: false, code: 'canceled', message: '요청을 취소했습니다.' });
      return { ok: true };
    }),
    onAiProgress: vi.fn((handler: (p: AiProgress) => void) => {
      progress = handler;
      return off;
    }),
    ...over,
  };
  (window as unknown as { reportApi: unknown }).reportApi = api;
  return { api, calls, off, finish: (r: AiCompleteResult) => finish(r), progress: (p: AiProgress) => progress(p) };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  (window as unknown as { reportApi: unknown }).reportApi = undefined;
});

const okResult: AiCompleteResult = { ok: true, json: { x: 1 }, model: 'claude-fable-5-2', usage: { input: 10, output: 5, cacheRead: 0 }, fallbackUsed: false, ms: 1200 };

function TidyHarness({ onReview }: { onReview: (res: unknown) => void }) {
  const tidy = useAiTidy();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void tidy.run({
            title: 't',
            empty: 'e',
            plan: () => ({}),
            request: () => ({ model: 'claude-fable-5-2', system: 's', user: 'u', schema: {} }),
            review: (_p, res) => {
              onReview(res);
              return { changes: [], notes: [], model: res.model, usage: res.usage, usd: 0, ms: res.ms, fallbackUsed: res.fallbackUsed, masked: {} };
            },
            apply: () => {},
          })
        }
      >
        실행
      </button>
      {tidy.view}
    </>
  );
}

describe('호출 중 표시', () => {
  it('진행 문구', () => {
    expect(progressText(null)).toBe('연결하는 중');
    expect(progressText({ phase: 'thinking', chars: 0 })).toBe('생각하는 중');
    expect(progressText({ phase: 'writing', chars: 3120 })).toBe('쓰는 중 · 3,120자');
    expect(progressText({ phase: 'retry', chars: 0 })).toBe('응답이 길어 한도를 올려 다시 요청하는 중');
    expect(progressText({ phase: 'fallback', chars: 10, model: 'claude-opus-4-8' })).toBe('Claude Opus 4.8(대체 모델) 이어 받는 중');
    expect(progressText({ phase: 'writing', chars: 10, model: 'claude-opus-4-8' })).toBe('Claude Opus 4.8(대체 모델) 쓰는 중 · 10자');
    expect(elapsedText(42_900)).toBe('42초');
    expect(elapsedText(125_000)).toBe('2분 05초');
  });

  it('고른 모델로 부르고, main이 알려 주는 단계(생각 → 쓰는 중)를 보여 준 뒤 확인 창으로 넘어간다', async () => {
    const main = stubApi();
    const onReview = vi.fn();
    render(<TidyHarness onReview={onReview} />);
    await act(async () => screen.getByText('실행').click());
    expect(screen.getByText('Claude Fable 5.2로 정돈하는 중')).toBeTruthy();
    expect(screen.getByText(/연결하는 중 · 0초/)).toBeTruthy();
    const id = main.calls[0].id!;
    expect(id).toMatch(/^ai-/);

    act(() => main.progress({ id, phase: 'thinking', chars: 0 }));
    expect(screen.getByText(/생각하는 중/)).toBeTruthy();
    // 다른 요청의 알림은 무시한다
    act(() => main.progress({ id: 'ai-other', phase: 'writing', chars: 99 }));
    expect(screen.queryByText(/99자/)).toBeNull();
    act(() => main.progress({ id, phase: 'writing', chars: 1234 }));
    expect(screen.getByText(/쓰는 중 · 1,234자/)).toBeTruthy();

    await act(async () => main.finish(okResult));
    expect(screen.queryByText('Claude Fable 5.2로 정돈하는 중')).toBeNull();
    expect(onReview).toHaveBeenCalledWith(okResult);
    expect(main.off).toHaveBeenCalledTimes(1); // 진행 알림 구독을 푼다
  });

  it('취소 — main의 요청을 실제로 멈추고, 오류가 아니라 안내로 끝낸다', async () => {
    const main = stubApi();
    const onReview = vi.fn();
    render(<TidyHarness onReview={onReview} />);
    await act(async () => screen.getByText('실행').click());
    await act(async () => screen.getByRole('button', { name: '취소' }).click());
    expect(main.api.aiCancel).toHaveBeenCalledWith(main.calls[0].id);
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('정돈을 취소했습니다.');
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull();
  });

  it('실패는 문구 그대로 알린다', async () => {
    const main = stubApi();
    render(<TidyHarness onReview={() => {}} />);
    await act(async () => screen.getByText('실행').click());
    await act(async () => main.finish({ ok: false, code: 'rate', message: '요청 한도를 넘었습니다.' }));
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('요청 한도를 넘었습니다.', { duration: 8000 });
  });
});

describe('설정 — 모델', () => {
  const meta = (id: string, name: string, createdAt: string, usable = true): AiModelMeta => ({ id, name, createdAt, line: null, maxOutput: 128000, adaptive: true, usable });
  const live: AiModelsResult = {
    ok: true,
    at: Date.UTC(2026, 10, 10, 5, 0),
    models: [
      meta('claude-fable-5-2', 'Claude Fable 5.2', '2026-11-09'),
      meta('claude-opus-5-5', 'Claude Opus 5.5', '2026-09-22'),
      meta('claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-28'),
      meta('claude-haiku-5-5', 'Claude Haiku 5.5', '2026-10-07'),
      meta('claude-opus-4-8', 'Claude Opus 4.8', '2026-04-01'),
      meta('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '2025-10-01', false),
    ],
  };
  const settingsApi = (models: AiModelsResult, stored = true) =>
    stubApi({
      aiKeyStatus: vi.fn(async () => ({ stored, env: false, encryption: true })),
      aiSetKey: vi.fn(async () => ({ ok: true })),
      aiClearKey: vi.fn(async () => ({ ok: true })),
      aiModels: vi.fn(async () => models),
    });
  const options = () => [...(screen.getByRole('combobox') as HTMLSelectElement).options].map((o) => o.value);

  it('Fable 5.2를 포함한 지금 모델 4종이 항상 보이고, 열 때 이 키의 모델 목록을 조회해 그 밖의 모델을 덧붙인다', async () => {
    const main = settingsApi(live);
    await act(async () => {
      render(<AiSettings mono={false} open />);
    });
    expect(main.api.aiModels).toHaveBeenCalledTimes(1); // 저장된 목록이 없어 조용히 조회
    expect(options()).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8']);
    expect(screen.getByText(/Claude Fable 5\.2 — 가장 깊게 생각 · 느림 \(\$8 \/ \$40 per 1M\)/)).toBeTruthy();
    expect(screen.getByText(/Claude Haiku 5\.5 — 가장 빠르고 저렴 \(\$0\.1 \/ \$0\.5 per 1M\)/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull(); // 조용한 조회는 알리지 않는다

    // 모델을 바꾸면 저장되고 그 모델의 주의점이 보인다
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-fable-5-2' } });
    expect(JSON.parse(store.get('tb:ai:v1')!)).toEqual({ model: 'claude-fable-5-2' });
    expect(screen.getByText(/데이터 보관 0일\(ZDR\) 조직에서는 쓸 수 없습니다/)).toBeTruthy();
  });

  it('[연결 확인] — 쓸 수 있는 모델을 알려 주고, 고른 모델이 이 키에서 안 열려 있으면 경고한다', async () => {
    const noFable: AiModelsResult = { ...live, models: live.models.filter((m) => m.id !== 'claude-fable-5-2') };
    store.set('tb:ai:v1', JSON.stringify({ model: 'claude-fable-5-2' }));
    const main = settingsApi(noFable);
    await act(async () => {
      render(<AiSettings mono={false} open />);
    });
    await act(async () => screen.getByRole('button', { name: '연결 확인' }).click());
    expect(screen.getByRole('status').textContent).toBe('연결됐지만 이 키에서는 Claude Fable 5.2을(를) 쓸 수 없습니다. 쓸 수 있는 모델: Opus 5.5 · Sonnet 5.5 · Haiku 5.5');
    expect(screen.getByText(/Claude Fable 5\.2 — .* · 이 키에서 사용 불가/)).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-opus-5-5' } });
    await act(async () => screen.getByRole('button', { name: '연결 확인' }).click());
    expect(screen.getByRole('status').textContent).toBe('연결됨 — 쓸 수 있는 모델: Opus 5.5 · Sonnet 5.5 · Haiku 5.5 외 1개');
    expect(main.api.aiModels).toHaveBeenCalledTimes(3);
  });

  it('키가 틀리면 [연결 확인]이 그 문구를 보여 주고, 목록 없이도 4종은 고를 수 있다', async () => {
    settingsApi({ ok: false, code: 'auth', message: 'API 키가 올바르지 않습니다.' });
    await act(async () => {
      render(<AiSettings mono={false} open />);
    });
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => screen.getByRole('button', { name: '연결 확인' }).click());
    expect(screen.getByRole('status').textContent).toBe('API 키가 올바르지 않습니다.');
    expect(options()).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('새 키를 저장하면 바로 연결을 확인한다', async () => {
    const main = settingsApi(live, false);
    await act(async () => {
      render(<AiSettings mono={false} open />);
    });
    expect(main.api.aiModels).not.toHaveBeenCalled(); // 키가 없으면 조회하지 않는다
    fireEvent.change(screen.getByPlaceholderText('sk-ant-…'), { target: { value: 'sk-ant-test-0000000000000000000000' } });
    await act(async () => screen.getByRole('button', { name: '키 저장' }).click());
    expect(main.api.aiSetKey).toHaveBeenCalledWith('sk-ant-test-0000000000000000000000');
    expect(main.api.aiModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/^연결됨 — 쓸 수 있는 모델: Fable 5\.2 · Opus 5\.5 · Sonnet 5\.5 · Haiku 5\.5 외 1개$/);
  });
});
