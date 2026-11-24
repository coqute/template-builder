/**
 * 웹 미리보기(vite dev)용 가짜 통로 — main이 없을 때 홈 화면을 합성 데이터로 띄운다.
 * 오늘을 기준으로 날짜를 만들고, 고친 것은 메모리에만 남는다(새로 고치면 처음으로). 값은 모두 합성이다.
 */
import type { WorklogFileText } from '../../../electron/worklog-types';
import type { PlannerApi } from '../api';
import { addDays, mondayOf, todayIso } from '../dates';
import { applyOp, emptyState, newTaskId, PlannerError } from '../ops';
import type { PlannerLogEntry, PlannerState, RawEvent, TaskDraft } from '../types';

const FOLDER = 'AB Z+ 작업';

function seedLogs(today: string): WorklogFileText[] {
  const file = (date: string, title: string, body: string): WorklogFileText => {
    const text = `[${date}] ${title}\n\n${body}\n`;
    return { folder: FOLDER, name: `[${date}] ${title}.txt`, date, title, size: text.length, mtimeMs: 1, text };
  };
  return [
    file(addDays(today, -5), '수집 점검', '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 에이전트 로그 회수 후 원인 확인\n- 대상: 수집 서버 2대\n- 원인 확인 중 — 제조사 회신 대기'),
    file(addDays(today, -11), '웹훅 점검', '■ (담당A/메신저) 웹훅 연동 설정 전수 확인\n※ event DB 접속 불가로 담당B 대리님에게 조회 요청 예정'),
    file(addDays(today, -18), '패치 안내', '■ (담당C/메일) v2.1 패치 안내\n※ 현장 적용 여부 확인 필요'),
    file(addDays(today, -3), '주간 미팅', '■ MX 주간 미팅 회의 (캘린더 일정)\n▶ 회의 참석 — 알림 분류 개선 일정 협의'),
  ];
}

function seedEvents(today: string): RawEvent[] {
  const mon = mondayOf(today);
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const ev = (id: string, summary: string, date: string, start: string, end: string, location: string, extra: Partial<RawEvent> = {}): RawEvent => ({
    calendarId: 'primary',
    id,
    summary,
    location,
    allDay: false,
    start: at(date, start),
    end: at(date, end),
    status: 'confirmed',
    eventType: 'default',
    htmlLink: '',
    meet: false,
    declined: false,
    holiday: false,
    canWrite: true,
    updated: at(today, '09:00'),
    ...extra,
  });
  const allDay = (id: string, summary: string, date: string, extra: Partial<RawEvent> = {}): RawEvent =>
    ev(id, summary, date, '00:00', '00:00', '', { allDay: true, start: date, end: addDays(date, 1), ...extra });
  return [
    ev('p1', 'MX 주간 미팅', addDays(mon, 1), '14:00', '15:00', '온라인', { meet: true }),
    ev('p2', '사무실', addDays(mon, 2), '09:00', '10:00', ''),
    ev('p3', 'AB Z+ 수집 서버 패치', addDays(mon, 3), '10:00', '12:00', '누리사옥 4층'),
    ev('p4', '가나스토어 정기점검', addDays(mon, 8), '10:00', '11:00', '동산사옥'),
    ev('p5', '분기 리뷰 회의', addDays(mon, 10), '15:00', '16:00', '본사 3층'),
    allDay('p6', '휴가', addDays(mon, 11)),
    allDay('p7', '예시 공휴일', addDays(mon, 9), { calendarId: 'holiday', holiday: true, canWrite: false }),
    ev('p8', 'MX 알림 설정 회의', addDays(today, -2), '10:00', '11:00', '온라인', { meet: true }),
  ];
}

function seedState(today: string): PlannerState {
  const mon = mondayOf(today);
  const drafts: TaskDraft[] = [
    { title: '에이전트 로그 회수 후 원인 정리', client: 'MX', due: addDays(today, -3) },
    { title: '알림 분류 개선 요청 회신', client: 'AB Z+', who: '홍길동', due: today },
    { title: '정기점검 체크리스트 갱신', client: '가나스토어', due: today },
    { title: '패치 적용 전 백업 절차 확인', client: 'AB Z+', due: addDays(mon, 2) < today ? addDays(today, 1) : addDays(mon, 2) },
    { title: '저장소 증설 용량 산정', client: '예시IT', due: addDays(mon, 9) },
    { title: '대시보드 템플릿 정리', client: '사내' },
    { title: '방화벽 정책 신청', client: 'MX', state: 'waiting', waitingOn: '담당B' },
  ];
  let state = emptyState();
  const ctx = { now: new Date().toISOString(), today, by: 'app' as const, newId: newTaskId };
  for (const draft of drafts) state = applyOp(state, { type: 'task.add', draft }, ctx).state;
  return state;
}

export function createPreviewApi(): PlannerApi {
  const today = todayIso();
  let state = seedState(today);
  let events = seedEvents(today);
  const logs = seedLogs(today);
  const changes: PlannerLogEntry[] = [];
  let stamp = 1;
  const ok = () => ({ ok: true as const, state, path: '(미리보기 — 저장되지 않음)' });
  return {
    preview: true,
    plannerGet: async () => ok(),
    plannerApply: async (op) => {
      try {
        const done = applyOp(state, op, { now: new Date().toISOString(), today: todayIso(), by: 'app', newId: newTaskId });
        state = done.state;
        changes.push(done.log);
        stamp++;
        return ok();
      } catch (err) {
        return { ok: false, error: err instanceof PlannerError ? err.message : String(err) };
      }
    },
    plannerStat: async () => ({ ok: true, mtimeMs: stamp, size: 0 }),
    plannerLog: async (limit = 50) => ({ ok: true, entries: [...changes].reverse().slice(0, limit) }),
    plannerReveal: async () => ({ ok: false, error: '미리보기에서는 저장 폴더가 없습니다.' }),
    calendarStatus: async () => ({ connected: true, canRead: true, canList: true, canWrite: true }),
    calendarList: async () => ({
      ok: true,
      calendars: [
        { id: 'primary', summary: '내 달력', primary: true, canWrite: true, holiday: false },
        { id: 'holiday', summary: '예시 공휴일 달력', primary: false, canWrite: false, holiday: true },
      ],
    }),
    calendarEvents: async () => ({ ok: true, events, readAt: Date.now(), fromCache: false, baseline: null }),
    calendarAck: async () => ({ ok: true }),
    calendarInsert: async (input) => {
      const id = `p${Date.now()}`;
      const event: RawEvent = {
        calendarId: 'primary',
        id,
        summary: input.summary,
        location: input.location ?? '',
        allDay: input.allDay,
        start: input.allDay ? input.start : new Date(`${input.start}:00`).toISOString(),
        end: input.allDay ? addDays(input.end, 1) : new Date(`${input.end}:00`).toISOString(),
        status: 'confirmed',
        eventType: 'default',
        htmlLink: '',
        meet: false,
        declined: false,
        holiday: false,
        canWrite: true,
        updated: new Date().toISOString(),
      };
      events = [...events, event];
      return { ok: true, event };
    },
    calendarPatch: async ({ ref, patch }) => {
      const cur = events.find((e) => e.id === ref.eventId);
      if (!cur) return { ok: false, code: 'api-error', message: '일정을 찾지 못했습니다.' };
      const allDay = patch.allDay ?? cur.allDay;
      const next: RawEvent = {
        ...cur,
        summary: patch.summary ?? cur.summary,
        location: patch.location ?? cur.location,
        allDay,
        start: patch.start ? (allDay ? patch.start : new Date(`${patch.start}:00`).toISOString()) : cur.start,
        end: patch.end ? (allDay ? addDays(patch.end, 1) : new Date(`${patch.end}:00`).toISOString()) : cur.end,
      };
      events = events.map((e) => (e.id === ref.eventId ? next : e));
      return { ok: true, event: next };
    },
    calendarDelete: async (ref) => {
      events = events.filter((e) => e.id !== ref.eventId);
      return { ok: true };
    },
    worklogConfig: async () => ({ root: '(미리보기)', folders: [{ name: FOLDER, count: logs.length }] }),
    worklogList: async () => ({ ok: true, files: logs.map(({ text: _t, ...e }) => e) }),
    worklogRead: async () => ({ ok: false, error: '미리보기에서는 일지 파일을 열 수 없습니다.' }),
    worklogSave: async () => ({ ok: false, code: 'error', error: '미리보기에서는 일지에 쓸 수 없습니다.' }),
    worklogCreate: async () => ({ ok: false, code: 'error', error: '미리보기에서는 일지를 만들 수 없습니다.' }),
    worklogReadAll: async () => ({ ok: true, files: logs }),
    worklogWeeklyHistory: async () => [],
    openExternal: async () => ({ ok: false, error: '미리보기' }),
  };
}
