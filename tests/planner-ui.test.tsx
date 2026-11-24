/**
 * 홈 화면 — 요약 줄·2주 띠·할 일 입력·끝냄과 되돌리기·후보·빈 상태·달력 미연결·시작 화면.
 * main 대신 메모리 통로로 같은 계약을 흉내 낸다. 값은 모두 합성이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from 'sonner';
import type { WorklogFileText } from '../electron/worklog-types';
import { DocTypeHostProvider, type DocIntent, type DocTypeHostValue } from '../src/doctypes/DocTypeHost';
import { homeModule } from '../src/doctypes/home';
import { DOC_TYPE_MODULES } from '../src/doctypes';
import { saveStartMode, useDocType } from '../src/hooks/useDocType';
import { addDays, mondayOf, todayIso } from '../src/planner/dates';
import { applyOp, emptyState, newTaskId, PlannerError } from '../src/planner/ops';
import type { CalendarStatus, PlannerLogEntry, PlannerOp, PlannerState, RawEvent, TaskDraft } from '../src/planner/types';

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

const TODAY = todayIso();
const FOLDER = 'AB Z+ 작업';

function log(date: string, body: string): WorklogFileText {
  const text = `[${date}] 점검\n\n${body}\n`;
  return { folder: FOLDER, name: `[${date}] 점검.txt`, date, title: '점검', size: text.length, mtimeMs: 1, text };
}

function event(id: string, summary: string, date: string, start: string, end: string): RawEvent {
  const at = (t: string) => new Date(`${date}T${t}:00`).toISOString();
  return { calendarId: 'primary', id, summary, location: '', allDay: false, start: at(start), end: at(end), status: 'confirmed', eventType: 'default', htmlLink: '', meet: false, declined: false, holiday: false, canWrite: true, updated: '' };
}

interface FakeOptions {
  tasks?: TaskDraft[];
  logs?: WorklogFileText[];
  events?: RawEvent[];
  status?: CalendarStatus;
}

function fakeApi(o: FakeOptions = {}) {
  let state: PlannerState = emptyState();
  const entries: PlannerLogEntry[] = [];
  /** 저장 파일의 시각 — 고칠 때마다 오른다 */
  let stamp = 1;
  const ctx = (by: 'app' | 'claude' = 'app') => ({ now: new Date().toISOString(), today: TODAY, by, newId: newTaskId });
  const run = (op: PlannerOp, by: 'app' | 'claude') => {
    const done = applyOp(state, op, ctx(by));
    state = done.state;
    entries.push(done.log);
    stamp++;
  };
  for (const draft of o.tasks ?? []) state = applyOp(state, { type: 'task.add', draft }, ctx()).state;
  const ok = () => ({ ok: true as const, state, path: 'C:/store/planner.json' });
  const api = {
    plannerGet: vi.fn(async () => ok()),
    plannerApply: vi.fn(async (op: PlannerOp) => {
      try {
        run(op, 'app');
        return ok();
      } catch (err) {
        return { ok: false as const, error: err instanceof PlannerError ? err.message : String(err) };
      }
    }),
    plannerStat: vi.fn(async () => ({ ok: true as const, mtimeMs: stamp, size: 1 })),
    plannerLog: vi.fn(async (limit = 50) => ({ ok: true as const, entries: [...entries].reverse().slice(0, limit) })),
    plannerReveal: vi.fn(async () => ({ ok: true })),
    calendarStatus: vi.fn(async () => o.status ?? { connected: true, canRead: true, canList: true, canWrite: false }),
    calendarList: vi.fn(async () => ({ ok: true as const, calendars: [] })),
    calendarEvents: vi.fn(async () => ({ ok: true as const, events: o.events ?? [], readAt: Date.now(), fromCache: false, baseline: null })),
    calendarAck: vi.fn(async () => ({ ok: true })),
    calendarInsert: vi.fn(),
    calendarPatch: vi.fn(),
    calendarDelete: vi.fn(),
    worklogConfig: vi.fn(async () => ({ root: 'C:/wl', folders: [{ name: FOLDER, count: (o.logs ?? []).length }] })),
    worklogList: vi.fn(async () => ({ ok: true as const, files: [] })),
    worklogRead: vi.fn(),
    worklogSave: vi.fn(),
    worklogCreate: vi.fn(),
    worklogReadAll: vi.fn(async () => ({ ok: true as const, files: o.logs ?? [] })),
    worklogWeeklyHistory: vi.fn(async () => []),
    openExternal: vi.fn(async () => ({ ok: true })),
  };
  /** 앱 밖(명령줄·MCP 도구)에서 저장소를 고친 것처럼 — 화면은 저장 파일의 시각을 보고 알아챈다 */
  const outside = (op: PlannerOp) => run(op, 'claude');
  return { api, state: () => state, outside };
}

function renderHome(api: unknown, intent: DocIntent | null = null) {
  (window as unknown as { reportApi: unknown }).reportApi = api;
  const navigate = vi.fn();
  const host: DocTypeHostValue = { toolbarSlot: null, registerHandlers: () => () => undefined, navigate, intent, clearIntent: vi.fn() };
  const Workspace = homeModule.Workspace;
  render(
    <DocTypeHostProvider value={host}>
      <Workspace theme="paper" profile={{ name: '홍길동', email: 'hong@example.com', company: '예시IT' }} zoom="fit" onZoomChange={() => undefined} templatesVersion={0} />
      <Toaster />
    </DocTypeHostProvider>,
  );
  return { navigate };
}

const tasksBox = () => screen.getByTestId('home-tasks');

describe('홈 화면', () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    cleanup();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });

  it('할 일을 기한별로 묶고 요약 줄에 다음 일정과 숫자를 보여 준다', async () => {
    const tomorrow = addDays(TODAY, 1);
    const { api } = fakeApi({
      tasks: [{ title: '지난 일', due: addDays(TODAY, -3) }, { title: '오늘 할 일', due: TODAY, client: 'AB Z+' }, { title: '기한 없는 일' }, { title: '기다리는 일', state: 'waiting', waitingOn: '고객' }],
      events: [event('e1', 'MX 주간 미팅', tomorrow, '14:00', '15:00')],
    });
    renderHome(api);
    await screen.findByText('오늘 할 일', { selector: 'button' });
    const box = tasksBox();
    expect([...box.querySelectorAll('[data-bucket]')].map((s) => s.getAttribute('data-bucket'))).toEqual(['late', 'today', 'none', 'waiting']);
    expect(within(box).getByText('AB Z+')).toBeTruthy();
    expect(within(box).getByText('고객 회신')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-next').textContent).toContain('MX 주간 미팅'));
    expect(screen.getByTestId('home-next').textContent).toContain('14:00');
    expect(screen.getByRole('group', { name: '요약' }).textContent).toBe('1기한 지남1오늘 할 일0이번 주 할 일' + (tomorrow <= addDays(mondayOf(TODAY), 6) ? '1' : '0') + '이번 주 일정1기다리는 중');
    expect(screen.getByTestId('home-status').textContent).toContain('할 일 3 · 기다림 1');
  });

  it('입력칸에 적고 Enter — 끝의 M/D는 기한이 되고, 체크하면 끝남·되돌리기', async () => {
    const { api, state } = fakeApi();
    renderHome(api);
    const input = await screen.findByLabelText('할 일 추가');
    const d = new Date();
    d.setDate(d.getDate() + 2);
    fireEvent.change(input, { target: { value: `백업 절차 확인 ${d.getMonth() + 1}/${d.getDate()}` } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await within(await screen.findByTestId('home-tasks')).findByText('백업 절차 확인');
    expect(state().tasks[0]).toMatchObject({ title: '백업 절차 확인', due: addDays(TODAY, 2), state: 'todo' });
    expect((input as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /백업 절차 확인 — 끝냄으로/ }));
    await waitFor(() => expect(state().tasks[0].doneAt).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('home-tasks')).toBeNull()); // 열린 일이 없어 빈 상태로
    fireEvent.click(await screen.findByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(state().tasks[0].doneAt).toBeNull());
    await within(await screen.findByTestId('home-tasks')).findByText('백업 절차 확인');
  });

  it('제목을 누르면 상자가 펼쳐지고, 상태를 기다리는 중으로 바꾸면 그 묶음으로 간다', async () => {
    const { api, state } = fakeApi({ tasks: [{ title: '방화벽 정책 신청', client: 'MX' }] });
    renderHome(api);
    fireEvent.click(await screen.findByRole('button', { name: '방화벽 정책 신청' }));
    const editor = screen.getByRole('group', { name: '방화벽 정책 신청 고치기' });
    fireEvent.click(within(editor).getByRole('button', { name: '기다리는 중' }));
    await waitFor(() => expect(state().tasks[0].state).toBe('waiting'));
    await waitFor(() => expect(tasksBox().querySelector('[data-bucket="waiting"]')).not.toBeNull());
    expect(state().tasks[0].waitingSince).toBe(TODAY);
  });

  it('작업일지의 열린 사안이 후보로 올라오고, [할 일로]·[무시]가 된다', async () => {
    const { api, state } = fakeApi({
      logs: [
        log(addDays(TODAY, -5), '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 로그 회수\n- 원인 확인 중 — 제조사 회신 대기'),
        log(addDays(TODAY, -9), '■ (담당A/메신저) 웹훅 연동 설정 전수 확인\n※ 조회 요청 예정'),
        log(addDays(TODAY, -2), '■ (담당C/유선) 알림 설정 문의\n▶ 안내\n- 안내 완료'),
      ],
    });
    const { navigate } = renderHome(api);
    const section = await waitFor(() => {
      const el = tasksBox().querySelector('[data-bucket="candidates"]');
      if (!el) throw new Error('후보 없음');
      return el as HTMLElement;
    });
    expect([...section.querySelectorAll('[data-candidate]')]).toHaveLength(2);
    expect(section.textContent).toContain('제조사 회신 대기');
    expect(section.textContent).not.toContain('알림 설정 문의');

    // 출처를 누르면 작업일지 탭의 그 사안으로
    fireEvent.click(within(section).getAllByRole('button', { name: /^일지 / })[0]);
    expect(navigate).toHaveBeenCalledWith('worklog', expect.objectContaining({ kind: 'worklog-open', anchor: expect.objectContaining({ folder: FOLDER, title: '수집 누락 원인 문의' }) }));

    fireEvent.click(within(section).getAllByRole('button', { name: '할 일로' })[0]);
    await waitFor(() => expect(state().tasks).toHaveLength(1));
    expect(state().tasks[0]).toMatchObject({ title: '수집 누락 원인 문의', state: 'waiting', waitingOn: '제조사', who: '홍길동', origin: { kind: 'worklog' } });
    await waitFor(() => expect(tasksBox().querySelectorAll('[data-candidate]')).toHaveLength(1));

    fireEvent.click(within(tasksBox()).getByRole('button', { name: '무시' }));
    await waitFor(() => expect(state().hiddenCandidates).toHaveLength(1));
    await waitFor(() => expect(tasksBox().querySelectorAll('[data-candidate]')).toHaveLength(0));
  });

  it('빈 상태 — 할 일도 일정도 없을 때', async () => {
    const { api } = fakeApi();
    renderHome(api);
    expect(await screen.findByText('남은 할 일이 없습니다')).toBeTruthy();
    expect(await screen.findByText('이번 주와 다음 주에 잡힌 일정이 없습니다')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-next').textContent).toBe('오늘과 앞으로 2주 동안 정해진 일정이 없습니다'));
  });

  it('달력 권한이 없으면 안내를 보여 주고 일정 쓰기 단추는 없다 — 할 일은 그대로 쓴다', async () => {
    const { api } = fakeApi({ tasks: [{ title: '오늘 할 일', due: TODAY }], status: { connected: false, canRead: false, canList: false, canWrite: false, reason: 'scope-missing' } });
    renderHome(api);
    expect(await screen.findByText('Google 달력이 연결되지 않았습니다')).toBeTruthy();
    expect(screen.getByTestId('home-next').textContent).toContain('달력이 연결되지 않아');
    expect(api.calendarEvents).not.toHaveBeenCalled();
    expect(screen.queryByText(/일정 추가/)).toBeNull();
    expect(await within(await screen.findByTestId('home-tasks')).findByText('오늘 할 일')).toBeTruthy();
    expect(screen.getByTestId('home-status').textContent).toContain('Google 달력 미연결');
  });

  it('달력에 쓸 수 있을 때만 일정 추가가 나온다', async () => {
    const { api } = fakeApi({ status: { connected: true, canRead: true, canList: true, canWrite: true } });
    renderHome(api);
    expect(await screen.findByText(/일정 추가/)).toBeTruthy();
  });

  it('날 칸을 누르면 그날이 기한인 것만 또렷이 남는다', async () => {
    const { api } = fakeApi({ tasks: [{ title: '오늘 할 일', due: TODAY }, { title: '기한 없는 일' }] });
    renderHome(api);
    await within(await screen.findByTestId('home-tasks')).findByText('기한 없는 일');
    const todayCell = screen.getAllByRole('button', { pressed: false }).find((b) => b.classList.contains('is-today'))!;
    fireEvent.click(todayCell);
    const rows = [...tasksBox().querySelectorAll('[data-task]')];
    expect(rows.map((r) => r.classList.contains('is-dim'))).toEqual([false, true]);
  });
});

describe('홈 화면 — 앱 밖에서 바뀐 것 (명령줄·MCP 도구)', () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    cleanup();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });

  it('밖에서 더한 할 일을 다시 읽어 보여 주고 "Claude가 바꾼 할 일"로 알린다 — [확인]하면 사라진다', async () => {
    const { api, outside } = fakeApi({ tasks: [{ title: '내가 적은 일' }] });
    renderHome(api);
    await within(await screen.findByTestId('home-tasks')).findByText('내가 적은 일');
    expect(screen.queryByText(/Claude가 바꾼 할 일/)).toBeNull();

    outside({ type: 'task.add', draft: { title: '밖에서 더한 일', due: TODAY } });
    // 저장 파일의 시각을 3초마다 본다
    await within(tasksBox()).findByText('밖에서 더한 일', {}, { timeout: 6000 });
    const banner = screen.getByText('Claude가 바꾼 할 일 1건').closest('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain('밖에서 더한 일');
    const rows = [...tasksBox().querySelectorAll('[data-task]')];
    expect(rows.map((r) => r.textContent?.includes('바뀜'))).toEqual([true, false]);

    fireEvent.click(within(banner).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(screen.queryByText(/Claude가 바꾼 할 일/)).toBeNull());
    expect(tasksBox().textContent).not.toContain('바뀜');
    expect(store.get('tb:home:seen-claude:v1')).toBeTruthy();
  }, 10000);

  it('[기록 보기] — 누가 무엇을 고쳤는지 보고 되돌린다', async () => {
    const { api, state, outside } = fakeApi();
    outside({ type: 'task.add', draft: { title: '밖에서 더한 일' } });
    const id = state().tasks[0].id;
    outside({ type: 'task.update', id, patch: { due: addDays(TODAY, 3) } });
    renderHome(api);
    fireEvent.click(await screen.findByRole('button', { name: '기록 보기' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('바뀐 기록')).toBeTruthy();
    // 같은 할 일의 기록은 가장 최근 것(기한을 고친 기록)만 되돌릴 수 있다
    const undo = await within(dialog).findAllByRole('button', { name: '되돌리기' });
    expect(undo).toHaveLength(1);
    expect(within(dialog).getAllByText('Claude')).toHaveLength(2);
    expect(dialog.textContent).toContain('고침');
    expect(dialog.textContent).toContain('더함');
    expect(undo[0].closest('.hm-row')?.textContent).toContain('고침');

    // 되돌리면 기한이 없던 모양으로
    fireEvent.click(undo[0]);
    await waitFor(() => expect(state().tasks[0].due).toBeNull());
    expect(state().tasks[0].id).toBe(id);
    await screen.findByText('되돌렸습니다.');
    // 되돌린 것도 기록에 남는다(앱이 고친 것으로)
    await waitFor(() => expect(within(dialog).getAllByText('앱').length).toBeGreaterThan(0));
  });
});

describe('시작 화면 (useDocType)', () => {
  beforeEach(() => store.clear());
  const IDS = DOC_TYPE_MODULES.map((m) => m.id);

  it('홈이 맨 앞에 등록돼 있고, 켜면 늘 홈으로 연다', () => {
    expect(IDS[0]).toBe('home');
    store.set('tb:doc-type', 'email');
    expect(renderHook(() => useDocType(IDS)).result.current.docType).toBe('home');
  });

  it('설정에서 마지막 화면을 고르면 예전처럼 마지막 탭으로 연다', () => {
    store.set('tb:doc-type', 'email');
    act(() => saveStartMode('last'));
    expect(renderHook(() => useDocType(IDS)).result.current.docType).toBe('email');
    // 저장된 탭이 없거나 모르는 값이면 홈
    store.set('tb:doc-type', 'ghost');
    expect(renderHook(() => useDocType(IDS)).result.current.docType).toBe('home');
  });

  it('홈이 없는 목록에서는 예전 규칙 그대로', () => {
    store.set('tb:doc-type', 'email');
    expect(renderHook(() => useDocType(['weekly', 'email'])).result.current.docType).toBe('email');
  });
});
