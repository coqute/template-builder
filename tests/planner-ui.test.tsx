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
import type { CalendarStatus, NotionPage, NotionSource, PlannerLogEntry, PlannerOp, PlannerState, RawEvent, TaskDraft } from '../src/planner/types';

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
  /** Notion — 주면 키가 있는 것으로 치고, 이 DB들을 고른 설정으로 시작한다 */
  notion?: { sources: NotionSource[]; meetings?: string; pages: NotionPage[]; fail?: string };
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
  if (o.notion) state = applyOp(state, { type: 'settings', patch: { notion: { sources: o.notion.sources, meetings: o.notion.meetings ?? '', loose: true, days: 7 } } }, ctx()).state;
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
    notionStatus: vi.fn(async () => ({ connected: !!o.notion, stored: !!o.notion, encryption: true })),
    notionSetKey: vi.fn(async () => ({ ok: true as const })),
    notionClearKey: vi.fn(async () => ({ ok: true })),
    notionSources: vi.fn(async () => ({ ok: true as const, sources: o.notion?.sources ?? [] })),
    notionResolve: vi.fn(),
    notionRecent: vi.fn(async (_req: { sources: string[]; since: string; loose?: boolean; force?: boolean }) =>
      o.notion?.fail
        ? { ok: false as const, code: 'not-found' as const, message: o.notion.fail }
        : { ok: true as const, pages: o.notion?.pages ?? [], readAt: Date.now(), fromCache: false, failed: [] as string[] },
    ),
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

describe('홈 화면 — 달력 일정의 동작 (2026-11-24 점검)', () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    cleanup();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });
  const WRITABLE: CalendarStatus = { connected: true, canRead: true, canList: true, canWrite: true };
  const LINK = 'https://www.google.com/calendar/event?eid=ZTEgaG9uZ0BleGFtcGxlLmNvbQ';
  const TOMORROW = addDays(TODAY, 1);
  const rowOf = (id: string) => document.querySelector(`[data-event="primary/${id}"]`) as HTMLElement;
  /** 그 일정의 줄 묶음 — 줄 + 바로 가는 길 + 펼친 단추 */
  const wrapOf = (id: string) => rowOf(id).closest('.hm-agw') as HTMLElement;
  /** 그 일정 줄을 펼친다 — 이미 펼쳐져 있으면 그대로 둔다(고친 뒤에도 줄은 펼쳐진 채다) */
  const openRow = async (id: string) => {
    await waitFor(() => expect(rowOf(id)).not.toBeNull());
    if (rowOf(id).getAttribute('aria-expanded') !== 'true') fireEvent.click(rowOf(id));
  };

  it('[달력에서 열기] — 그 일정의 링크를 바깥 브라우저로 열고, 열지 못하면 알린다', async () => {
    const { api } = fakeApi({ events: [{ ...event('e1', 'MX 주간 미팅', TOMORROW, '14:00', '15:00'), htmlLink: LINK }] });
    renderHome(api);
    // 설계 §6.4 — 줄을 펼치지 않아도 `달력 ↗`가 줄에 바로 있다
    await waitFor(() => expect(rowOf('e1')).not.toBeNull());
    expect(rowOf('e1').getAttribute('aria-expanded')).toBe('false');
    const link = within(wrapOf('e1')).getByRole('button', { name: /달력에서 열기/ });
    expect(link.textContent).toBe('달력 ↗');
    fireEvent.click(link);
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith(LINK));
    expect(screen.queryByText(/열지 못했습니다/)).toBeNull();
    expect(rowOf('e1').getAttribute('aria-expanded')).toBe('false'); // 여는 것만으로 줄이 펼쳐지지 않는다

    api.openExternal.mockResolvedValueOnce({ ok: false, error: '열 수 없는 주소입니다' } as never);
    fireEvent.click(screen.getByRole('button', { name: /달력에서 열기/ }));
    expect(await screen.findByText(/달력에서 이 일정을 열지 못했습니다 — 열 수 없는 주소입니다/)).toBeTruthy();
  });

  it('링크가 없는 일정에는 [달력에서 열기]가 없고, 남이 만든 일정에는 고치기·지우기가 없다', async () => {
    const { api } = fakeApi({
      status: WRITABLE,
      events: [event('e1', '링크 없는 일정', TOMORROW, '10:00', '11:00'), { ...event('e2', '초대받은 회의', TOMORROW, '14:00', '15:00'), htmlLink: LINK, canWrite: false }],
    });
    renderHome(api);
    await openRow('e1');
    expect(within(wrapOf('e1')).queryByRole('button', { name: /달력에서 열기/ })).toBeNull();
    expect(within(wrapOf('e1')).getByRole('button', { name: '고치기·옮기기' })).toBeTruthy();
    fireEvent.click(rowOf('e1')); // 접는다
    await openRow('e2');
    expect(within(wrapOf('e2')).getByRole('button', { name: /달력에서 열기/ })).toBeTruthy();
    expect(within(wrapOf('e2')).queryByRole('button', { name: '고치기·옮기기' })).toBeNull();
    expect(within(wrapOf('e2')).queryByRole('button', { name: '지우기' })).toBeNull();
    expect(within(wrapOf('e2')).getByRole('button', { name: '이 일정 숨기기' })).toBeTruthy();
  });

  it('[고치기·옮기기] — 바뀐 칸만 달력에 보낸다. 밤을 넘기는 일정은 길이를 지킨다', async () => {
    const overnight: RawEvent = { ...event('e1', '', TOMORROW, '22:00', '23:00'), end: new Date(`${addDays(TOMORROW, 1)}T01:00:00`).toISOString(), htmlLink: LINK };
    const { api } = fakeApi({ status: WRITABLE, events: [overnight] });
    api.calendarPatch.mockImplementation(async () => ({ ok: true, event: overnight }));
    renderHome(api);

    // 장소만 고친다 — 제목이 없던 일정의 자리 글과 시각은 보내지 않는다
    await openRow('e1');
    fireEvent.click(screen.getByRole('button', { name: '고치기·옮기기' }));
    let dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('제목') as HTMLInputElement).value).toBe('(제목 없음)');
    fireEvent.change(within(dialog).getByLabelText('장소 (선택)'), { target: { value: '본사 3층' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '고치기' }));
    await waitFor(() => expect(api.calendarPatch).toHaveBeenCalledTimes(1));
    expect(api.calendarPatch).toHaveBeenLastCalledWith({ ref: { calendarId: 'primary', eventId: 'e1' }, patch: { location: '본사 3층' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 시작만 한 시간 당긴다 — 끝은 다음 날 01:00 그대로
    await openRow('e1');
    fireEvent.click(screen.getByRole('button', { name: '고치기·옮기기' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('시작'), { target: { value: '21:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '고치기' }));
    await waitFor(() => expect(api.calendarPatch).toHaveBeenCalledTimes(2));
    expect(api.calendarPatch).toHaveBeenLastCalledWith({
      ref: { calendarId: 'primary', eventId: 'e1' },
      patch: { allDay: false, start: `${TOMORROW}T21:00`, end: `${addDays(TOMORROW, 1)}T01:00` },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 아무것도 고치지 않으면 달력에 쓰지 않는다
    await openRow('e1');
    fireEvent.click(screen.getByRole('button', { name: '고치기·옮기기' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '고치기' }));
    expect(await screen.findByText('바뀐 것이 없어 달력에 쓰지 않았습니다.')).toBeTruthy();
    expect(api.calendarPatch).toHaveBeenCalledTimes(2);
  });

  it('[지우기] — 한 번 더 확인하고, 그 일정으로 달력에 올려 둔 할 일의 표시를 지운다', async () => {
    const { api, state } = fakeApi({
      status: WRITABLE,
      tasks: [{ title: '달력에 올린 일', due: TOMORROW, event: { calendarId: 'primary', eventId: 'e1' } }],
      events: [{ ...event('e1', '달력에 올린 일', TOMORROW, '10:00', '11:00'), htmlLink: LINK, recurring: true }],
    });
    api.calendarDelete.mockImplementation(async () => ({ ok: true }));
    renderHome(api);
    // 할 일을 펼치면 "달력에 올림" 표시가 있다
    fireEvent.click(await within(await screen.findByTestId('home-tasks')).findByRole('button', { name: '달력에 올린 일' }));
    expect(within(tasksBox()).getByText('달력에 올림')).toBeTruthy();
    expect(within(tasksBox()).queryByRole('button', { name: '달력에 올리기' })).toBeNull();
    await openRow('e1');
    // 할 일 상자에도 [지우기]가 있다 — 일정 줄 아래의 것을 누른다
    fireEvent.click(within(wrapOf('e1')).getByRole('button', { name: '지우기' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.calendarDelete).not.toHaveBeenCalled(); // 확인 전에는 지우지 않는다
    expect(dialog.textContent).toContain('반복 일정의 이번 회차만');
    fireEvent.click(within(dialog).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(api.calendarDelete).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'e1' }));
    await waitFor(() => expect(state().tasks[0].event).toBeNull());
    await waitFor(() => expect(within(tasksBox()).queryByText('달력에 올림')).toBeNull());
    expect(within(tasksBox()).getByRole('button', { name: '달력에 올리기' })).toBeTruthy();
  });
  it('앱에서 고친 일정이 나중에 밖에서 또 바뀌면 "바뀜"으로 알린다 (한 번 고쳤다고 계속 가리지 않는다)', async () => {
    const at = (time: string) => event('e1', 'MX 주간 미팅', TOMORROW, time, '18:00');
    let current: RawEvent[] = [at('14:00')];
    let baseline: RawEvent[] | null = null;
    const { api } = fakeApi({ status: WRITABLE });
    api.calendarEvents.mockImplementation(async () => ({ ok: true as const, events: current, readAt: Date.now(), fromCache: false, baseline }) as never);
    api.calendarAck.mockImplementation(async () => {
      baseline = current;
      return { ok: true };
    });
    api.calendarPatch.mockImplementation(async () => {
      current = [{ ...current[0], location: '본사 3층' }];
      return { ok: true, event: current[0] };
    });
    renderHome(api);
    baseline = current; // 처음 읽은 일정이 견줄 기준이 된다

    // 앱에서 장소를 고친다 — 내가 고친 것은 "바뀜"으로 띄우지 않는다
    await openRow('e1');
    fireEvent.click(screen.getByRole('button', { name: '고치기·옮기기' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('장소 (선택)'), { target: { value: '본사 3층' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '고치기' }));
    await waitFor(() => expect(api.calendarAck).toHaveBeenCalled());
    expect(screen.queryByText(/지난번 본 뒤 바뀐 일정/)).toBeNull();

    // 그 뒤 밖에서(다른 기기·달력 도구) 같은 일정의 시각이 바뀐다
    current = [{ ...at('16:00'), location: '본사 3층' }];
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText('지난번 본 뒤 바뀐 일정 1건')).toBeTruthy();
    expect(rowOf('e1').textContent).toContain('바뀜');
  });

  it('일지 사안과 이어진 일정은 줄에 `일지 ↗`가 있고, 누르면 작업일지 탭의 그 사안으로 간다', async () => {
    const anchor = { folder: FOLDER, name: '[2026-11-18] 점검.txt', date: '2026-11-18', caseKey: '수집누락원인문의', nth: 0, line: 3, title: '수집 누락 원인 문의', source: '홍길동/메일' };
    const { api, outside } = fakeApi({ events: [{ ...event('e1', 'AB Z+ 수집 서버 패치', TOMORROW, '10:00', '12:00'), htmlLink: LINK }, event('e2', '이어지지 않은 일정', TOMORROW, '15:00', '16:00')] });
    outside({ type: 'link.set', link: { calendarId: 'primary', eventId: 'e1', anchor } });
    const { navigate } = renderHome(api);
    await waitFor(() => expect(rowOf('e1')).not.toBeNull());
    const go = await within(wrapOf('e1')).findByRole('button', { name: /이어진 일지 사안 열기/ });
    expect(go.textContent).toBe('일지 ↗');
    expect(within(wrapOf('e2')).queryByRole('button', { name: /이어진 일지 사안 열기/ })).toBeNull();
    fireEvent.click(go);
    expect(navigate).toHaveBeenCalledWith('worklog', expect.objectContaining({ kind: 'worklog-open', anchor: expect.objectContaining({ caseKey: '수집누락원인문의' }) }));
  });

  it('남의 달력의 일정은 2주 띠에만 옅게 나오고, 확정 일정 목록과 다음 일정에는 없다', async () => {
    const theirs: RawEvent = { ...event('t1', '가나스토어 정기점검', TODAY, '23:00', '23:30'), calendarId: 'damdang-a@example.com', other: true, calendarName: '담당A', canWrite: false };
    const { api } = fakeApi({ events: [theirs, event('e1', 'MX 주간 미팅', TOMORROW, '14:00', '15:00')] });
    renderHome(api);
    await waitFor(() => expect(rowOf('e1')).not.toBeNull());
    const dim = document.querySelector('.hm-ev.is-other') as HTMLElement;
    // 제목이 먼저, 누구 것인지는 뒤에 — 이름이 앞에 오면 좁은 칸에서 제목이 잘려 무슨 일정인지 알 수 없다
    expect(dim.querySelector('b')?.textContent).toBe('가나스토어 정기점검');
    expect(dim.querySelector('em')?.textContent).toBe('담당A');
    expect(dim.textContent?.indexOf('가나스토어')).toBeLessThan(dim.textContent?.indexOf('담당A') ?? -1);
    expect(document.querySelector('[data-event="damdang-a@example.com/t1"]')).toBeNull(); // 목록에는 없다
    expect(screen.getByTestId('home-next').textContent).toContain('MX 주간 미팅');
    expect(screen.getByTestId('home-next').textContent).not.toContain('가나스토어');
  });

  it('남의 달력의 일정이 한 날에 많으면 셋까지만 보이고 나머지는 "외 n건"으로 접는다', async () => {
    const theirs = Array.from({ length: 5 }, (_, i): RawEvent => ({ ...event(`t${i}`, `동료 일정 ${i + 1}`, TODAY, `1${i}:00`, `1${i}:30`), calendarId: 'damdang-a@example.com', other: true, calendarName: '담당A', canWrite: false }));
    const { api } = fakeApi({ events: [...theirs, event('e1', 'MX 주간 미팅', TOMORROW, '14:00', '15:00')] });
    renderHome(api);
    await waitFor(() => expect(rowOf('e1')).not.toBeNull());
    const dim = [...document.querySelectorAll('.hm-day.is-today .hm-ev.is-other')].map((x) => x.textContent);
    expect(dim).toHaveLength(4);
    expect(dim[3]).toBe('외 2건');
  });

  it('읽을 달력 설정이 바뀌면 그 설정으로 달력을 다시 읽는다 (새로 고침을 누르지 않아도)', async () => {
    const { api, outside } = fakeApi({ status: WRITABLE, events: [event('e1', 'MX 주간 미팅', TOMORROW, '14:00', '15:00')] });
    renderHome(api);
    await waitFor(() => expect(rowOf('e1')).not.toBeNull());
    const lastRequest = () => (api.calendarEvents.mock.calls.at(-1) as unknown as [unknown] | undefined)?.[0];
    const first = api.calendarEvents.mock.calls.length;
    expect(lastRequest()).toMatchObject({ calendars: ['primary'] });
    // 설정(F1)이나 밖에서 설정을 고친 것처럼
    outside({ type: 'settings', patch: { calendars: ['primary', 'damdang-a@example.com'] } });
    await waitFor(() => expect(api.calendarEvents.mock.calls.length).toBeGreaterThan(first), { timeout: 6000 });
    expect(lastRequest()).toMatchObject({ calendars: ['primary', 'damdang-a@example.com'] });
  }, 10000);
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

describe('홈 화면 — 날을 고르면 그날의 미리보기가 가운데에 열린다', () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    cleanup();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });
  const dayCell = (date: string) => document.querySelector(`.hm-day[data-date="${date}"]`) as HTMLElement;
  const preview = () => screen.getByTestId('home-day');

  it('그날의 일정·다른 달력·할 일을 한데 보여 주고, 닫기·Esc·바깥을 눌러 닫는다', async () => {
    // 동료 달력의 이름은 대개 메일 주소다 — 골뱅이는 공개 검사가 실제 주소로 읽지 않게 이어 붙인다
    const mail = ['damdang-b', 'example.com'].join('@');
    const events: RawEvent[] = [
      { ...event('e1', 'AB Z+ 수집 서버 패치 사전 점검과 작업 순서 협의', TODAY, '10:00', '12:00'), location: '누리사옥 4층', htmlLink: 'https://www.google.com/calendar/event?eid=ZTE' },
      event('e2', 'MX 주간 미팅', TODAY, '14:00', '15:00'),
      { ...event('t1', '가나스토어 현장 점검', TODAY, '13:00', '17:00'), calendarId: 'team', other: true, calendarName: mail, canWrite: false },
    ];
    const { api } = fakeApi({ events, tasks: [{ title: '정기점검 체크리스트 갱신', client: '가나스토어', due: TODAY }, { title: '로그 회수 후 원인 정리', due: addDays(TODAY, -3) }, { title: '다음 주 할 일', due: addDays(TODAY, 9) }] });
    renderHome(api);
    await waitFor(() => expect(dayCell(TODAY)).not.toBeNull());
    expect(screen.queryByTestId('home-day')).toBeNull();
    // 띠의 동료 일정 — 제목이 먼저, 메일 주소는 골뱅이 앞만
    const other = dayCell(TODAY).querySelector('.hm-ev.is-other') as HTMLElement;
    expect(other.querySelector('b')?.textContent).toBe('가나스토어 현장 점검');
    expect(other.querySelector('em')?.textContent).toBe('damdang-b');

    fireEvent.click(dayCell(TODAY));
    const box = preview();
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toContain('미리보기');
    // 일정 — 시각·긴 제목 전체·장소
    const mine = box.querySelector('[data-group="events"]') as HTMLElement;
    expect(within(mine).getByText('AB Z+ 수집 서버 패치 사전 점검과 작업 순서 협의')).toBeTruthy();
    expect(mine.textContent).toContain('10:00');
    expect(mine.textContent).toContain('~ 12:00');
    expect(mine.textContent).toContain('누리사옥 4층');
    expect(within(mine).getByText('MX 주간 미팅')).toBeTruthy();
    // 다른 달력 — 누구 것인지와 제목
    const theirs = box.querySelector('[data-group="others"]') as HTMLElement;
    expect(theirs.textContent).toContain('가나스토어 현장 점검');
    expect(theirs.textContent).toContain('damdang-b');
    // 할 일 — 오늘이 기한인 것과 기한이 지난 것(오늘 칸에서만), 앞날 것은 없다
    const todo = box.querySelector('[data-group="tasks"]') as HTMLElement;
    expect(within(todo).getByText('정기점검 체크리스트 갱신')).toBeTruthy();
    expect(todo.textContent).toContain('3일 지남');
    expect(within(todo).queryByText('다음 주 할 일')).toBeNull();
    expect(box.textContent).toContain('일정 2 · 다른 달력 1 · 할 일 2');

    // 달력으로, 할 일 줄로
    fireEvent.click(within(mine).getByRole('button', { name: '달력에서 열기 — AB Z+ 수집 서버 패치 사전 점검과 작업 순서 협의' }));
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://www.google.com/calendar/event?eid=ZTE'));
    // 할 일 줄을 누르면 창을 닫고 아래 목록의 그 줄로 간다
    fireEvent.click(within(todo).getByRole('button', { name: '할 일로 가기 — 정기점검 체크리스트 갱신' }));
    expect(screen.queryByTestId('home-day')).toBeNull();
    await waitFor(() => expect(document.querySelector('.is-flash')).not.toBeNull());

    // 닫는 세 가지 — [닫기], Esc, 창 바깥
    fireEvent.click(dayCell(TODAY));
    fireEvent.click(within(preview()).getByRole('button', { name: '닫기 (Esc)' }));
    expect(screen.queryByTestId('home-day')).toBeNull();
    fireEvent.click(dayCell(TODAY));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('home-day')).toBeNull();
    fireEvent.click(dayCell(TODAY));
    fireEvent.mouseDown(preview()); // 창 안을 눌러서는 닫히지 않는다
    expect(screen.queryByTestId('home-day')).not.toBeNull();
    fireEvent.mouseDown(preview().parentElement as HTMLElement);
    expect(screen.queryByTestId('home-day')).toBeNull();
  });

  it('창을 닫지 않고 옆 날로 넘어간다 — ‹ ›, 그 주의 날 줄, ← → 키', async () => {
    const mon = mondayOf(TODAY);
    const { api } = fakeApi({ events: [event('e1', 'MX 주간 미팅', addDays(mon, 2), '14:00', '15:00'), event('e2', '가나스토어 정기점검', addDays(mon, 3), '10:00', '11:00')], tasks: [{ title: '수요일 기한', due: addDays(mon, 2) }] });
    renderHome(api);
    await waitFor(() => expect(dayCell(mon)).not.toBeNull());
    fireEvent.click(dayCell(addDays(mon, 2)));
    const shown = () => preview().getAttribute('data-date');
    expect(shown()).toBe(addDays(mon, 2));
    expect(within(preview()).getByText('MX 주간 미팅')).toBeTruthy();
    // 그 주의 날 줄 — 월~일 일곱, 고른 날이 눌린 모양, 날마다 건수(일정 1 + 할 일 1 = 2)
    const pills = [...preview().querySelectorAll('.hm-pk-d')] as HTMLElement[];
    expect(pills).toHaveLength(7);
    expect(pills.map((x) => x.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false', 'false']);
    expect(pills[2].querySelector('i')?.textContent).toBe('2');
    expect(pills[3].querySelector('i')?.textContent).toBe('1');
    expect(pills[0].querySelector('i')?.textContent).toBe('');
    // › 로 다음 날
    fireEvent.click(within(preview()).getByRole('button', { name: '뒷 날' }));
    expect(shown()).toBe(addDays(mon, 3));
    expect(within(preview()).getByText('가나스토어 정기점검')).toBeTruthy();
    // ← 키로 두 번 앞
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(shown()).toBe(addDays(mon, 1));
    // 날 줄에서 일요일로
    fireEvent.click([...preview().querySelectorAll('.hm-pk-d')][6] as HTMLElement);
    expect(shown()).toBe(addDays(mon, 6));
    // 띠의 처음에서는 ‹ 가, 끝에서는 › 가 꺼진다
    fireEvent.click(preview().querySelector('.hm-pk-d') as HTMLElement);
    expect(shown()).toBe(mon);
    expect((within(preview()).getByRole('button', { name: '앞 날' }) as HTMLButtonElement).disabled).toBe(true);
    for (let k = 0; k < 13; k++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(shown()).toBe(addDays(mon, 13));
    expect((within(preview()).getByRole('button', { name: '뒷 날' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('달력에 쓸 수 있으면 [이 날에 일정 추가]가 그날 날짜로 일정 창을 연다 — 쓸 수 없으면 단추가 없다', async () => {
    const day = addDays(mondayOf(TODAY), 9);
    const ro = fakeApi();
    renderHome(ro.api);
    await waitFor(() => expect(dayCell(day)).not.toBeNull());
    fireEvent.click(dayCell(day));
    expect(within(preview()).queryByRole('button', { name: /이 날에 일정 추가/ })).toBeNull();
    cleanup();

    const rw = fakeApi({ status: { connected: true, canRead: true, canList: true, canWrite: true } });
    renderHome(rw.api);
    await waitFor(() => expect(dayCell(day)).not.toBeNull());
    fireEvent.click(dayCell(day));
    fireEvent.click(within(preview()).getByRole('button', { name: /이 날에 일정 추가/ }));
    // 미리보기는 물러나고 일정 창이 그 날짜로 열린다
    expect(screen.queryByTestId('home-day')).toBeNull();
    await waitFor(() => expect((document.querySelector('input[type="date"]') as HTMLInputElement | null)?.value).toBe(day));
  });

  it('아무것도 없는 날은 없다고 알린다', async () => {
    const { api } = fakeApi();
    renderHome(api);
    await waitFor(() => expect(dayCell(TODAY)).not.toBeNull());
    fireEvent.click(dayCell(addDays(mondayOf(TODAY), 13)));
    expect(preview().textContent).toContain('이 날에는 일정·할 일·Notion 작성이 없습니다.');
  });
});

describe('홈 화면 — Notion (읽기만): 어느 날에 무엇을 썼는가', () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    cleanup();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });
  const DBS: NotionSource[] = [
    { id: 'ds-meet', name: '회의', url: 'https://www.notion.so/00000000000000000000000000000001' },
    { id: 'ds-support', name: 'SR', url: 'https://www.notion.so/00000000000000000000000000000002' },
  ];
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const page = (id: string, sourceId: string, title: string, created: string, edited = created): NotionPage => ({ id, sourceId, title, createdAt: created, editedAt: edited, url: `https://www.notion.so/${id}` });
  const dayCell = (date: string) => document.querySelector(`.hm-day[data-date="${date}"]`) as HTMLElement;
  const weekLabels = () => [...document.querySelectorAll('.hm-wk-l')].map((x) => x.textContent);
  const YESTERDAY = addDays(TODAY, -1);

  it('키가 없으면 띠는 이번 주·다음 주 그대로이고 Notion을 읽지 않는다', async () => {
    const { api } = fakeApi();
    renderHome(api);
    await screen.findByTestId('home-status');
    await waitFor(() => expect(api.notionStatus).toHaveBeenCalled());
    expect(weekLabels()).toEqual(['이번 주', '다음 주']);
    expect(document.querySelector('.hm-ev.is-notion')).toBeNull();
    expect(screen.queryByTestId('home-notion-status')).toBeNull();
    expect(screen.queryByTestId('home-notion-note')).toBeNull();
    expect(api.notionRecent).not.toHaveBeenCalled();
  });

  it('띠에 지난 주 줄이 붙고, 날 칸에 그날 쓴 페이지가 표지와 함께 나온다 — 날을 누르면 미리보기에서 전부 읽고 연다', async () => {
    const pages = [
      page('s1', 'ds-support', '수집 누락 원인 문의', at(addDays(TODAY, -6), '11:00'), at(TODAY, '00:10')),
      page('s2', 'ds-support', '알림 분류 개선 요청', at(YESTERDAY, '15:30')),
      page('s3', 'ds-support', '에이전트 재기동 절차 문의', at(YESTERDAY, '13:10')),
      page('s4', 'ds-support', '대시보드 권한 문의', at(YESTERDAY, '10:40')),
      page('m1', 'ds-meet', '분기 정리 회의', at(YESTERDAY, '09:00')),
    ];
    const { api } = fakeApi({ notion: { sources: DBS, meetings: 'ds-meet', pages } });
    renderHome(api);
    await waitFor(() => expect(dayCell(YESTERDAY)?.querySelector('.hm-ev.is-notion')).not.toBeNull());
    expect(weekLabels()).toEqual(['지난 주', '이번 주', '다음 주']);
    // 읽는 범위 = 지난 주 월요일부터
    const since = new Date(`${addDays(mondayOf(TODAY), -7)}T00:00:00`).toISOString();
    expect(api.notionRecent).toHaveBeenCalledWith(expect.objectContaining({ sources: ['ds-meet', 'ds-support'], since, loose: true }));
    // 날 칸 — 둘까지 제목, 나머지는 "외 n건". 늦게 쓴 것부터
    const chips = [...dayCell(YESTERDAY).querySelectorAll('.hm-ev.is-notion')].map((c) => c.textContent);
    expect(chips).toEqual(['알림 분류 개선 요청', '에이전트 재기동 절차 문의', '외 2건']);
    expect(dayCell(YESTERDAY).querySelectorAll('.hm-ev.is-notion .hm-nm')).toHaveLength(3);
    expect(dayCell(YESTERDAY).getAttribute('aria-label')).toContain('Notion 작성 4건');
    // 6일 전에 만들고 오늘 고친 페이지 — 만든 날과 고친 날 두 곳에
    expect(dayCell(TODAY).querySelector('.hm-ev.is-notion')?.textContent).toBe('수집 누락 원인 문의');
    expect(dayCell(addDays(TODAY, -6)).querySelector('.hm-ev.is-notion')?.textContent).toBe('수집 누락 원인 문의');

    fireEvent.click(dayCell(YESTERDAY));
    const group = screen.getByTestId('home-day').querySelector('[data-group="notion"]') as HTMLElement;
    expect([...group.querySelectorAll('.hm-pk-n b')].map((b) => b.textContent)).toEqual(['알림 분류 개선 요청', '에이전트 재기동 절차 문의', '대시보드 권한 문의', '분기 정리 회의']);
    expect(group.textContent).toContain('SR · 새로 만듦');
    expect(group.textContent).toContain('회의 · 새로 만듦');
    fireEvent.click(within(group).getByRole('button', { name: 'Notion에서 열기 — 대시보드 권한 문의' }));
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://www.notion.so/s4'));
    // 오늘 칸의 것은 만든 날이 아니라 고친 날이다 — 창 안에서 다음 날로 넘어가 본다
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('home-day').querySelector('[data-group="notion"]')?.textContent).toContain('SR · 고침');
    expect(screen.getByTestId('home-notion-status').textContent).toContain('Notion 연결됨');
  });

  it('회의록은 만든 시각이 맞는 본인 일정 줄에 이어진다 — 누르면 Notion이 열리고 줄은 펼쳐지지 않는다', async () => {
    const events = [event('e1', 'AB Z+ 현장 지원', TODAY, '10:00', '12:00'), event('e2', 'MX 주간 미팅', TODAY, '14:00', '15:00')];
    const pages = [page('m1', 'ds-meet', '예시 고객사 협의', at(TODAY, '10:05'))];
    const { api } = fakeApi({ events, notion: { sources: DBS, meetings: 'ds-meet', pages } });
    renderHome(api);
    const link = await screen.findByRole('button', { name: 'Notion 회의록 열기 — AB Z+ 현장 지원' });
    expect(screen.queryByRole('button', { name: 'Notion 회의록 열기 — MX 주간 미팅' })).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://www.notion.so/m1'));
    expect(document.querySelector('[data-event="primary/e1"]')?.getAttribute('aria-expanded')).toBe('false');
    // 2주 띠의 그 일정 조각에도 표지가 붙는다
    const chips = [...document.querySelectorAll('.hm-strip .hm-ev:not(.is-notion)')].filter((c) => c.querySelector('.hm-nm'));
    expect(chips.map((c) => c.querySelector('b')?.textContent)).toEqual(['AB Z+ 현장 지원']);
    // 그날 미리보기의 일정 줄에도 회의록 링크가 있다
    fireEvent.click(document.querySelector(`.hm-day[data-date="${TODAY}"]`) as HTMLElement);
    const mine = screen.getByTestId('home-day').querySelector('[data-group="events"]') as HTMLElement;
    expect(within(mine).getAllByRole('button', { name: 'Notion 회의록 열기 — AB Z+ 현장 지원' })).toHaveLength(1);
    // 달력에는 쓰지 않는다
    expect(api.calendarInsert).not.toHaveBeenCalled();
    expect(api.calendarPatch).not.toHaveBeenCalled();
  });

  it('읽지 못하면 까닭과 [다시 읽기] — 홈의 나머지는 그대로 뜬다', async () => {
    const { api } = fakeApi({ tasks: [{ title: '정기점검 체크리스트 갱신', due: TODAY }], notion: { sources: DBS, meetings: 'ds-meet', pages: [], fail: '찾지 못했습니다 — 연결을 더했는지 확인하세요.' } });
    renderHome(api);
    const note = await screen.findByTestId('home-notion-note');
    expect(note.textContent).toContain('Notion을 읽지 못했습니다');
    expect(within(tasksBox()).getByText('정기점검 체크리스트 갱신')).toBeTruthy();
    expect(screen.getByTestId('home-notion-status').textContent).toContain('읽지 못함');
    const before = api.notionRecent.mock.calls.length;
    fireEvent.click(within(note).getByRole('button', { name: '다시 읽기' }));
    await waitFor(() => expect(api.notionRecent.mock.calls.length).toBeGreaterThan(before));
    expect(api.notionRecent.mock.calls.at(-1)?.[0]).toMatchObject({ force: true });
  });

  it('키는 있는데 볼 DB를 고르지 않았으면 고르라고 안내한다', async () => {
    const { api } = fakeApi({ notion: { sources: [], pages: [] } });
    renderHome(api);
    const note = await screen.findByTestId('home-notion-note');
    expect(note.textContent).toContain('볼 DB를 아직 고르지 않았습니다');
    expect(api.notionRecent).not.toHaveBeenCalled();
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
