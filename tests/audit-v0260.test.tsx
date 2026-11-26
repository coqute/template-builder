/**
 * v0.26.0 — 전체 점검에서 확인한 것의 재발 방지 (화면의 단축키·툴바). 값은 모두 합성이다.
 *  · 주간보고에 오류가 있어 [HTML 복사] 버튼이 꺼져 있어도 Ctrl+Shift+C·메뉴는 복사했다
 *  · 작업일지 툴바 — [AI 정돈]은 없애고, ⋯ 더보기의 "이 사안에 일정·할 일 달기"를 버튼으로 올렸다
 */
import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DocTypeHostProvider, type DocTypeHandlers, type DocTypeHostValue } from '../src/doctypes/DocTypeHost';
import { weeklyModule } from '../src/doctypes/weekly';
import { worklogModule } from '../src/doctypes/worklog';
import { copyHtmlToClipboard } from '../src/hooks/useClipboard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));
import { toast } from 'sonner';

vi.mock('../src/hooks/useClipboard', async (orig) => ({
  ...(await orig<typeof import('../src/hooks/useClipboard')>()),
  copyHtmlToClipboard: vi.fn(async () => undefined),
}));

// 미리보기 iframe은 이 테스트가 보는 것이 아니다 (happy-dom이 iframe·외부 글꼴을 읽지 못해 기록만 어지럽힌다)
vi.mock('../src/components/HtmlPreview', () => ({ HtmlPreview: () => null, ZoomToggle: () => null }));

// Node 22+의 실험적 localStorage가 happy-dom 것을 가린다 — 인메모리 스텁
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

const setApi = (api: unknown) => {
  (window as unknown as { reportApi: unknown }).reportApi = api;
};
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  setApi(undefined);
});
afterEach(() => cleanup());

// ── 화면의 단축키·툴바 ───────────────────────────────────────────────────
function renderModule(Workspace: typeof weeklyModule.Workspace) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  let handlers: MutableRefObject<DocTypeHandlers> | null = null;
  const host: DocTypeHostValue = {
    toolbarSlot: slot,
    registerHandlers: (ref) => {
      handlers = ref;
      return () => undefined;
    },
    navigate: vi.fn(),
    intent: null,
    clearIntent: vi.fn(),
  };
  render(
    <DocTypeHostProvider value={host}>
      <Workspace theme="paper" profile={{ name: '홍길동', email: 'hong@example.com', company: '예시IT' }} zoom="fit" onZoomChange={() => undefined} templatesVersion={0} />
    </DocTypeHostProvider>,
  );
  const button = (label: string) => [...slot.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
  return { slot, button, handlers: () => handlers!.current };
}

const WEEK_OK = `@PREV 2026-10-12 ~ 2026-10-18
@CURRENT 2026-10-19 ~ 2026-10-25

# 2026-10-12(월)
@LOC 예시IT
@CUS MX
@SUM [MX] (담당A/메일) 대시보드 미반영 문의
- 설정 확인 안내
`;

describe('주간보고 — 메뉴·단축키도 버튼과 같은 조건으로 내보낸다', () => {
  it('오류가 있으면 Ctrl+Shift+C·메뉴의 HTML 복사가 복사하지 않고 이유를 알린다', async () => {
    store.set('tb:md-draft:v1', WEEK_OK.replace('@PREV 2026-10-12', '@PREV 2026-13-45'));
    const ui = renderModule(weeklyModule.Workspace);
    await act(async () => {
      await flush();
    });
    expect(ui.button('HTML 복사')!.disabled).toBe(true);
    await act(async () => {
      expect(ui.handlers().shortcut!('shift+c')).toBe(true);
      ui.handlers().menu['menu:copy-html']!();
      await flush();
    });
    expect(copyHtmlToClipboard).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('고쳐야 내보낼 수 있습니다'))).toHaveLength(2);
  });

  it('오류가 없으면 전처럼 복사한다', async () => {
    store.set('tb:md-draft:v1', WEEK_OK);
    const ui = renderModule(weeklyModule.Workspace);
    await act(async () => {
      await flush();
    });
    expect(ui.button('HTML 복사')!.disabled).toBe(false);
    await act(async () => {
      ui.handlers().shortcut!('shift+c');
      await flush();
    });
    expect(copyHtmlToClipboard).toHaveBeenCalledTimes(1);
  });
});

describe('작업일지 툴바', () => {
  it('[일정·할 일 달기]가 버튼으로 있고 [AI 정돈]은 없다 — Ctrl+Shift+A는 더 이상 잡지 않는다', async () => {
    const ui = renderModule(worklogModule.Workspace);
    await act(async () => {
      await flush();
    });
    const labels = [...ui.slot.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['오늘 일지', '저장', '대화 → 블록', '일정·할 일 달기', '더보기']);
    expect(ui.button('일정·할 일 달기')!.title).toContain('Ctrl+Shift+D');
    expect(ui.handlers().shortcut!('shift+a')).toBe(false);
    // 일지를 열기 전에는 꺼져 있고, 단축키는 이유를 알린다
    expect(ui.button('일정·할 일 달기')!.disabled).toBe(true);
    act(() => {
      expect(ui.handlers().shortcut!('shift+d')).toBe(true);
    });
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('일지를 먼저 여세요.');
  });
});
