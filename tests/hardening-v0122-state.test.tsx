/**
 * v0.12.2 회귀 고정 — 코드베이스 심층 분석(데이터 흐름·상태·계약)에서 검증된 결함의 재발 방지 (저장·상태 쪽).
 * 각 it 제목의 [A-n]/[B-n]은 분석 리포트의 발견 번호.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorklogEntry, WorklogFileRef, WorklogSaveRequest } from '../electron/worklog-types';
import { useWorklog } from '../src/worklog/useWorklog';
import { isoToday } from '../src/worklog/format';
import { useEmailDoc } from '../src/email/useEmailDoc';
import { useEmailExport } from '../src/email/useEmailExport';
import { useWeeklyState } from '../src/hooks/useWeeklyState';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));
import { toast } from 'sonner';

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
type Action = { label: string; onClick: () => void };
const lastAction = (fn: unknown): Action => (vi.mocked(fn as typeof toast.success).mock.calls.at(-1)![1] as { action: Action }).action;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});
afterEach(() => setApi(undefined));

// ── 작업일지 ────────────────────────────────────────────────────────────────
const FOLDER = '작업';
const TODAY = isoToday();
const A = `[${TODAY}] 오늘 작업.txt`;
const B = '[2026-01-05] 지난 작업.txt';
const A_TEXT = `[${TODAY}] 오늘 작업\n\n■ (홍길동/메신저) 이벤트 설정 문의\n▶ 설정 방법 안내\n\n■ (홍길동/메신저) 이벤트 설정 문의 (후속)\n▶ 수신 확인`;
const B_TEXT = '[2026-01-05] 지난 작업\n\n■ 지난 사안\n▶ 처리';
const DRAFTS = 'tb:worklog:unsaved:v1';

function fakeFs() {
  const text = new Map<string, string>([
    [A, A_TEXT],
    [B, B_TEXT],
  ]);
  let mtime = 1;
  const state = { failSave: false, hold: null as Promise<void> | null };
  const entry = (name: string): WorklogEntry => ({ folder: FOLDER, name, date: name.slice(1, 11), title: name.slice(13, -4), size: text.get(name)!.length, mtimeMs: mtime });
  const api = {
    setDirty: vi.fn(),
    worklogConfig: vi.fn(async () => ({ root: 'C:/wl', folders: [{ name: FOLDER, count: 2 }] })),
    worklogList: vi.fn(async () => ({ ok: true as const, files: [entry(A), entry(B)] })),
    worklogReadAll: vi.fn(async () => ({ ok: true as const, files: [A, B].map((n) => ({ ...entry(n), text: text.get(n)! })) })),
    worklogRead: vi.fn(async (ref: WorklogFileRef) => ({ ok: true as const, text: text.get(ref.name)!, mtimeMs: mtime, size: text.get(ref.name)!.length, bom: false, crlf: false, legacyEncoding: false })),
    worklogStat: vi.fn(async (ref: WorklogFileRef) => ({ ok: true as const, mtimeMs: mtime, size: text.get(ref.name)!.length })),
    worklogSave: vi.fn(async (req: WorklogSaveRequest) => {
      if (state.hold) await state.hold;
      if (state.failSave) return { ok: false as const, code: 'error' as const, error: '디스크 오류' };
      const cur = text.get(req.name)!;
      if (!req.force && cur !== req.base) return { ok: false as const, code: 'changed' as const, disk: cur, mtimeMs: mtime, size: cur.length };
      text.set(req.name, req.text);
      mtime++;
      return { ok: true as const, mtimeMs: mtime, size: req.text.length };
    }),
  };
  return {
    api,
    state,
    entry,
    disk: (name: string) => text.get(name)!,
    external: (name: string, next: string) => {
      text.set(name, next);
      mtime++;
    },
  };
}

const drafts = (): Array<{ name: string; text: string }> => JSON.parse(store.get(DRAFTS) ?? '[]');

describe('작업일지 — 저장 전 내용을 잃지 않는다', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  async function mount(fs: ReturnType<typeof fakeFs>) {
    setApi(fs.api);
    const hook = renderHook(() => useWorklog());
    await tick(10);
    expect(hook.result.current.current?.name).toBe(A);
    return hook;
  }

  it('[B-2] 이미 열려 있는 파일을 다시 열어도(Ctrl+N 오늘 일지) 저장 전 편집이 디스크 내용으로 덮이지 않는다', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    const reads = fs.api.worklogRead.mock.calls.length;
    act(() => result.current.setText(`${A_TEXT}\n- 방금 쓴 줄`));
    await act(async () => {
      expect(await result.current.open(fs.entry(A))).toBe(true);
    });
    expect(result.current.text).toBe(`${A_TEXT}\n- 방금 쓴 줄`);
    expect(fs.api.worklogRead.mock.calls.length).toBe(reads); // 다시 읽지 않는다
    await tick(1600);
    expect(fs.disk(A)).toBe(`${A_TEXT}\n- 방금 쓴 줄`);
  });

  it('[A-3] 다른 파일을 연 뒤 누른 [되돌리기]는 지금 파일의 본문을 바꾸지 않는다 (옛 파일 내용이 자동 저장되지 않게)', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    act(() => result.current.applyFix({ kind: 'merge-case', keep: 0, drop: 1 }));
    const undo = lastAction(toast.success);
    expect(undo.label).toBe('되돌리기');
    await act(async () => {
      await result.current.open(fs.entry(B));
    });
    expect(result.current.current?.name).toBe(B);
    act(() => undo.onClick());
    expect(result.current.text).toBe(B_TEXT);
    expect(vi.mocked(toast.info)).toHaveBeenCalled();
    await tick(2000);
    expect(fs.disk(B)).toBe(B_TEXT);
  });

  it('같은 파일에서는 [되돌리기]가 그대로 동작한다', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    act(() => result.current.applyFix({ kind: 'merge-case', keep: 0, drop: 1 }));
    expect(result.current.text).not.toBe(A_TEXT);
    act(() => lastAction(toast.success).onClick());
    expect(result.current.text).toBe(A_TEXT);
  });

  it('[A-6] 저장하지 못한 내용의 보관본은 파일마다 따로 남는다 (다음 파일의 보관본이 앞 파일 것을 덮지 않는다)', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    fs.state.failSave = true;
    act(() => result.current.setText(`${A_TEXT}\n- A에서 쓴 줄`));
    await act(async () => {
      await result.current.open(fs.entry(B));
    });
    act(() => result.current.setText(`${B_TEXT}\n- B에서 쓴 줄`));
    await act(async () => {
      await result.current.open(fs.entry(A));
    });
    // A를 다시 열면 A의 보관본이 되살아나고, B의 보관본도 남아 있다
    expect(result.current.text).toBe(`${A_TEXT}\n- A에서 쓴 줄`);
    expect(drafts().find((d) => d.name === B)?.text).toBe(`${B_TEXT}\n- B에서 쓴 줄`);
  });

  it('[A-4] 충돌로 자동 저장이 멈춘 사이에 더 쓴 내용도 앱에 보관된다', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    act(() => result.current.setText(`${A_TEXT}\n- 내 편집`));
    fs.external(A, '메모장에서 고친 내용');
    await tick(1600);
    expect(result.current.status).toBe('conflict');
    act(() => result.current.setText(`${A_TEXT}\n- 내 편집\n- 충돌 뒤에 더 쓴 줄`));
    await tick(500);
    expect(drafts().find((d) => d.name === A)?.text).toContain('충돌 뒤에 더 쓴 줄');
  });

  it('[A-4] 창이 닫히는 순간(beforeunload) 마지막에 쓴 내용까지 보관한다', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    act(() => result.current.setText(`${A_TEXT}\n- 닫기 직전 줄`));
    act(() => void window.dispatchEvent(new Event('beforeunload')));
    expect(drafts().find((d) => d.name === A)?.text).toContain('닫기 직전 줄');
  });

  it('[B-6] 저장하는 사이 더 쓰고 남긴 보관본은 그 저장이 끝나도 지워지지 않는다', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    let release = () => {};
    fs.state.hold = new Promise<void>((r) => (release = r));
    act(() => result.current.setText(`${A_TEXT}\n- 첫 줄`));
    await tick(1600); // 자동 저장 시작 — 응답 대기
    expect(result.current.status).toBe('saving');
    act(() => result.current.setText(`${A_TEXT}\n- 첫 줄\n- 저장 중에 쓴 줄`));
    await tick(500); // 보관본 갱신
    release();
    fs.state.hold = null;
    await tick(10);
    expect(fs.disk(A)).toBe(`${A_TEXT}\n- 첫 줄`);
    expect(drafts().find((d) => d.name === A)?.text).toContain('저장 중에 쓴 줄');
    await tick(1600); // 이어지는 자동 저장이 나머지를 쓰고, 그때 보관본이 정리된다
    expect(fs.disk(A)).toContain('저장 중에 쓴 줄');
    expect(drafts().find((d) => d.name === A)).toBeUndefined();
  });

  it('고친 것을 손으로 되돌려 디스크와 같아지면 보관본을 지운다 (다시 열 때 되살아나지 않게)', async () => {
    const fs = fakeFs();
    const { result } = await mount(fs);
    fs.state.failSave = true;
    act(() => result.current.setText(`${A_TEXT}\n- 지울 줄`));
    await tick(500);
    expect(drafts().find((d) => d.name === A)).toBeDefined();
    act(() => result.current.setText(A_TEXT));
    await tick(10);
    expect(drafts().find((d) => d.name === A)).toBeUndefined();
  });

  it('예전 형식(보관본 하나짜리 객체)도 읽어 되살린다', async () => {
    store.set(DRAFTS, JSON.stringify({ folder: FOLDER, name: A, text: `${A_TEXT}\n- 예전 보관본`, base: A_TEXT, at: 1 }));
    const fs = fakeFs();
    const { result } = await mount(fs);
    expect(result.current.text).toBe(`${A_TEXT}\n- 예전 보관본`);
  });
});

// ── 이메일 ──────────────────────────────────────────────────────────────────
describe('이메일 — Gmail 초안 추적', () => {
  const RENDERED = { subject: '제목', html: '<p>본문</p>', plain: '본문' };
  function useEmail() {
    const d = useEmailDoc();
    const ex = useEmailExport(d.doc, RENDERED, d.loadDoc, d.docGen);
    return { d, ex };
  }
  function draftApi() {
    let n = 0;
    const createGmailDraft = vi.fn(async (p: { draftId?: string }) => ({ ok: true as const, draftId: p.draftId ?? `D${++n}`, updated: !!p.draftId }));
    setApi({ createGmailDraft, openExternal: vi.fn(async () => ({ ok: true })) });
    return createGmailDraft;
  }
  const sentIds = (fn: ReturnType<typeof draftApi>) => fn.mock.calls.map((c) => c[0].draftId);

  it('[B-5] [새 이메일] 뒤의 임시보관함은 앞 메일의 초안을 덮어쓰지 않는다', async () => {
    const create = draftApi();
    const { result } = renderHook(() => useEmail());
    await act(async () => result.current.ex.createDraft());
    await act(async () => result.current.ex.createDraft()); // 같은 메일 — 초안 갱신
    act(() => result.current.d.resetDoc()); // 새 이메일 (같은 템플릿)
    await act(async () => result.current.ex.createDraft());
    expect(sentIds(create)).toEqual([undefined, 'D1', undefined]);
  });

  it('같은 메일을 고치는 동작(AI 정돈 적용)에서는 초안 추적이 유지된다', async () => {
    const create = draftApi();
    const { result } = renderHook(() => useEmail());
    await act(async () => result.current.ex.createDraft());
    act(() => result.current.d.loadDoc({ ...result.current.d.doc, bodyHtml: '<p>다듬음</p>' }));
    await act(async () => result.current.ex.createDraft());
    expect(sentIds(create)).toEqual([undefined, 'D1']);
  });

  it('문서 세대는 다른 메일이 될 때만 오른다', () => {
    const { result } = renderHook(() => useEmailDoc());
    const g0 = result.current.gen();
    act(() => result.current.setField('topic', 'x'));
    act(() => result.current.loadDoc(result.current.doc));
    expect(result.current.gen()).toBe(g0);
    act(() => result.current.resetDoc());
    act(() => result.current.setTemplateId('license-delivery'));
    act(() => result.current.loadDoc(result.current.doc, { fresh: true }));
    expect(result.current.gen()).toBe(g0 + 3);
    expect(result.current.docGen).toBe(g0 + 3);
  });
});

// ── 주간보고 ────────────────────────────────────────────────────────────────
describe('주간보고 — 늦게 눌리는 토스트 액션', () => {
  const PATH_A = 'C:\\r\\a.md';
  const PATH_B = 'C:\\r\\b.md';
  const flush = () =>
    act(async () => {
      await Promise.resolve();
    });

  async function setup() {
    const disk = new Map([
      [PATH_A, 'A1'],
      [PATH_B, 'B1'],
    ]);
    const saveToPath = vi.fn(async (filePath: string, content: string) => {
      disk.set(filePath, content);
      return { ok: true, filePath };
    });
    setApi({
      setDirty: vi.fn(),
      save: vi.fn(async () => ({ canceled: true })),
      saveToPath,
      readPath: vi.fn(async (p: string) => ({ ok: true, content: disk.get(p) ?? '' })),
    });
    store.set('tb:md-file-path:v1', PATH_A);
    store.set('tb:md-draft:v1', 'A1');
    const hook = renderHook(() => useWeeklyState('김테스트'));
    await flush();
    act(() => hook.result.current.setMd('A2'));
    disk.set(PATH_A, '바깥에서 고침'); // 앱이 열려 있는 동안 외부 편집
    await act(async () => hook.result.current.saveFile());
    expect(saveToPath).not.toHaveBeenCalled();
    return { ...hook, disk, saveToPath, overwrite: lastAction(toast.warning) };
  }

  it('[A-2] "외부에서 변경됨 → 덮어쓰기"는 그 사이 다른 파일을 열었으면 쓰지 않는다 (지금 문서가 옛 경로에 저장되지 않게)', async () => {
    const { result, disk, saveToPath, overwrite } = await setup();
    expect(overwrite.label).toBe('덮어쓰기');
    await act(async () => result.current.openRecentFile(PATH_B));
    expect(result.current.md).toBe('B1');
    await act(async () => overwrite.onClick());
    expect(saveToPath).not.toHaveBeenCalled();
    expect(disk.get(PATH_A)).toBe('바깥에서 고침');
    expect(vi.mocked(toast.info)).toHaveBeenCalled();
  });

  it('같은 문서에서는 [덮어쓰기]가 지금 내용을 그 파일에 쓴다', async () => {
    const { saveToPath, overwrite } = await setup();
    await act(async () => overwrite.onClick());
    expect(saveToPath).toHaveBeenCalledWith(PATH_A, 'A2');
  });

  it('문서 세대는 문서를 통째로 바꿀 때 오르고, 편집으로는 오르지 않는다', async () => {
    const { result } = await setup();
    const g = result.current.docGen();
    act(() => result.current.setMd('A3'));
    expect(result.current.docGen()).toBe(g);
    await act(async () => result.current.openRecentFile(PATH_B));
    expect(result.current.docGen()).toBe(g + 1);
    await act(async () => result.current.loadTemplate());
    expect(result.current.docGen()).toBe(g + 2);
  });
});
