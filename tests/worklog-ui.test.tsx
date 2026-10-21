/**
 * 작업일지 저장·병합 (useWorklog) — 메모장처럼 루틴이 덧붙인 내용이 사라지지 않아야 한다.
 * main 프로세스 대신 메모리 파일 시스템으로 같은 계약(base가 다르면 저장 거부)을 흉내 낸다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorklogEntry, WorklogSaveRequest } from '../electron/worklog-types';
import { useWorklog } from '../src/worklog/useWorklog';
import { isoToday } from '../src/worklog/format';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const FOLDER = 'AB Z+ 작업';
const TODAY = isoToday();
const NAME = `[${TODAY}] 오늘 작업.txt`;
const BASE = `[${TODAY}] 오늘 작업\n\n■ (홍길동/메신저) 이벤트 설정 문의\n▶ 설정 방법 안내`;

function fakeFs(initial: string) {
  let text = initial;
  let mtime = 1;
  const entry = (): WorklogEntry => ({ folder: FOLDER, name: NAME, date: TODAY, title: '오늘 작업', size: text.length, mtimeMs: mtime });
  const api = {
    setDirty: vi.fn(),
    worklogConfig: vi.fn(async () => ({ root: 'C:/wl', folders: [{ name: FOLDER, count: 1 }] })),
    worklogList: vi.fn(async () => ({ ok: true as const, files: [entry()] })),
    worklogReadAll: vi.fn(async () => ({ ok: true as const, files: [{ ...entry(), text }] })),
    worklogRead: vi.fn(async () => ({ ok: true as const, text, mtimeMs: mtime, size: text.length, bom: false, crlf: false, legacyEncoding: false })),
    worklogStat: vi.fn(async () => ({ ok: true as const, mtimeMs: mtime, size: text.length })),
    worklogSave: vi.fn(async (req: WorklogSaveRequest) => {
      if (!req.force && text !== req.base) return { ok: false as const, code: 'changed' as const, disk: text, mtimeMs: mtime, size: text.length };
      text = req.text;
      mtime++;
      return { ok: true as const, mtimeMs: mtime, size: text.length };
    }),
  };
  return {
    api,
    disk: () => text,
    /** 바깥 프로그램(루틴·메모장)이 파일을 바꿈 */
    external: (next: string) => {
      text = next;
      mtime++;
    },
  };
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('작업일지 저장·병합', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });

  async function mount(fs: ReturnType<typeof fakeFs>) {
    (window as unknown as { reportApi: unknown }).reportApi = fs.api;
    const hook = renderHook(() => useWorklog());
    await tick(10);
    expect(hook.result.current.current?.name).toBe(NAME);
    expect(hook.result.current.text).toBe(BASE);
    return hook;
  }

  it('쓰기를 멈추면 1.5초 뒤 저장한다 — 마지막으로 읽은 본문을 base로', async () => {
    const fs = fakeFs(BASE);
    const { result } = await mount(fs);
    act(() => result.current.setText(`${BASE}\n- 수신 그룹 추가`));
    expect(result.current.dirty).toBe(true);
    await tick(1000);
    expect(fs.api.worklogSave).not.toHaveBeenCalled();
    await tick(700);
    expect(fs.api.worklogSave).toHaveBeenCalledTimes(1);
    expect(fs.api.worklogSave.mock.calls[0][0]).toMatchObject({ base: BASE, text: `${BASE}\n- 수신 그룹 추가` });
    expect(fs.disk()).toBe(`${BASE}\n- 수신 그룹 추가`);
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe('saved');
  });

  it('편집 중에 루틴이 덧붙이면 그 꼬리를 내 내용 끝에 합쳐 저장한다 (어느 쪽도 사라지지 않음)', async () => {
    const fs = fakeFs(BASE);
    const { result } = await mount(fs);
    act(() => result.current.setText(`${BASE}\n- 내가 쓴 줄`));
    fs.external(`${BASE}\n\n■ (김철수/메일) 루틴이 붙인 사안\n▶ 회신 확인\n`);
    await tick(1600); // 저장 시도 → 디스크가 base+꼬리 → 합침
    expect(result.current.text).toBe(`${BASE}\n- 내가 쓴 줄\n\n■ (김철수/메일) 루틴이 붙인 사안\n▶ 회신 확인\n`);
    await tick(1600); // 합친 본문 저장
    expect(fs.disk()).toBe(result.current.text);
    expect(result.current.status).toBe('saved');
  });

  it('편집하지 않을 때 바깥 변경은 3초 안에 그대로 불러온다', async () => {
    const fs = fakeFs(BASE);
    const { result } = await mount(fs);
    fs.external(`${BASE}\n\n■ 루틴 사안`);
    await tick(3100);
    expect(result.current.text).toBe(`${BASE}\n\n■ 루틴 사안`);
    expect(result.current.dirty).toBe(false);
    expect(fs.api.worklogSave).not.toHaveBeenCalled();
  });

  it('덧붙이기가 아닌 바깥 변경(메모장에서 고침) + 내 편집 → 충돌로 멈추고, 고르면 진행', async () => {
    const fs = fakeFs(BASE);
    const { result } = await mount(fs);
    act(() => result.current.setText(`${BASE}\n- 내 편집`));
    fs.external(`[${TODAY}] 오늘 작업\n\n■ 메모장에서 고친 내용`);
    await tick(1600);
    expect(result.current.status).toBe('conflict');
    expect(result.current.conflict?.disk).toContain('메모장에서 고친 내용');
    await tick(5000); // 충돌 중에는 자동 저장하지 않는다
    expect(fs.disk()).toContain('메모장에서 고친 내용');
    // 저장하지 못한 내용은 앱에 보관
    expect(localStorage.getItem('tb:worklog:unsaved:v1')).toContain('내 편집');
    await act(async () => {
      result.current.keepMine();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fs.api.worklogSave.mock.calls.at(-1)?.[0]).toMatchObject({ force: true });
    expect(fs.disk()).toBe(`${BASE}\n- 내 편집`);
    expect(result.current.conflict).toBeNull();
  });

  it('충돌에서 파일 내용을 고르면 내 내용은 되돌리기용으로 남는다', async () => {
    const fs = fakeFs(BASE);
    const { result } = await mount(fs);
    act(() => result.current.setText(`${BASE}\n- 내 편집`));
    fs.external('바뀐 파일');
    await tick(1600);
    act(() => result.current.takeDisk());
    expect(result.current.text).toBe('바뀐 파일');
    expect(result.current.dirty).toBe(false);
    expect(localStorage.getItem('tb:worklog:unsaved:v1')).toContain('내 편집');
  });

  it('형식 제안 고치기 — 같은 사안 합치기는 되돌릴 수 있다', async () => {
    const fs = fakeFs(`${BASE}\n\n■ (홍길동/메신저) 이벤트 설정 문의 (후속)\n▶ 수신 확인`);
    (window as unknown as { reportApi: unknown }).reportApi = fs.api;
    const { result } = renderHook(() => useWorklog());
    await tick(10);
    act(() => result.current.applyFix({ kind: 'merge-case', keep: 0, drop: 1 }));
    expect(result.current.text).toBe(`${BASE}\n\n▶ 수신 확인`);
  });
});
