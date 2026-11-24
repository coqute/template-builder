/**
 * 웹 미리보기(vite dev)용 가짜 통로 — main이 없을 때 홈 화면을 합성 데이터로 띄운다.
 * 오늘을 기준으로 날짜를 만들고, 고친 것은 메모리에만 남는다(새로 고치면 처음으로). 값은 모두 합성이다.
 */
import type { WorklogFileText } from '../../../electron/worklog-types';
import type { PlannerApi } from '../api';
import { addDays, mondayOf, todayIso } from '../dates';
import { applyOp, emptyState, newTaskId, PlannerError } from '../ops';
import type { NotionPage, NotionSource, PlannerLogEntry, PlannerState, RawEvent, TaskDraft } from '../types';

const FOLDER = 'AB Z+ 작업';
/** 동료 달력 — 이름은 메일 주소 모양, 색은 달력마다 다르다(Google 달력에서 달력에 정해 두는 색) */
const TEAM = ['damdang-a', 'damdang-b', 'damdang-c', 'damdang-d'].map((id, i) => ({
  id: `team-${i}`,
  name: [id, 'example.com'].join('@'),
  color: ['#b99aff', '#f83a22', '#4986e7', '#16a765'][i],
}));

function seedLogs(today: string): WorklogFileText[] {
  const file = (date: string, title: string, body: string): WorklogFileText => {
    const text = `[${date}] ${title}\n\n${body}\n`;
    return { folder: FOLDER, name: `[${date}] ${title}.txt`, date, title, size: text.length, mtimeMs: 1, text };
  };
  return [
    file(addDays(today, -5), '수집 점검', '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 에이전트 로그 회수 후 원인 확인\n- 대상: 수집 서버 2대\n- 원인 확인 중 — 제조사 회신 대기'),
    file(addDays(today, -11), '웹훅 점검', '■ (담당A/메신저) 웹훅 연동 설정 전수 확인\n※ event DB 접속 불가로 담당B 대리님에게 조회 요청 예정'),
    file(addDays(today, -18), '패치 일정', '■ (담당C/유선) v2.1 패치 적용 일정 문의\n▶ 적용 가능 일정 확인\n- 적용 전 백업 절차 확인 필요'),
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
    htmlLink: 'https://calendar.google.com/calendar/',
    meet: false,
    declined: false,
    holiday: false,
    canWrite: true,
    updated: at(today, '09:00'),
    ...extra,
  });
  const allDay = (id: string, summary: string, date: string, extra: Partial<RawEvent> = {}): RawEvent =>
    ev(id, summary, date, '00:00', '00:00', '', { allDay: true, start: date, end: addDays(date, 1), ...extra });
  // 동료 달력 — 실제 모양을 닮게 만든다: 달력 이름은 메일 주소이고, 하루에 여러 건이 겹치며, 종일 일정(현장·재택·휴가)이 많고 제목이 길다.
  // 짧은 이름·하루 한 건으로만 보면 날 칸에서 제목이 잘리는 문제가 보이지 않는다.
  const dayLong = ['AB Z+ 누리사옥 현장 지원', '재택', '가나스토어 물류센터 상주', '휴가', '예시IT 정기점검 방문'];
  const timed = ['가나스토어 물류센터 서버 증설 사전 점검과 일정 협의', 'MX 모니터링 대시보드 개편 회의', '분기 보안 점검 준비 회의', 'AB Z+ 수집 서버 패치 리허설'];
  const team: RawEvent[] = [];
  for (let d = -8; d <= 12; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) continue;
    TEAM.forEach(({ id, name, color }, i) => {
      const k = (d + 24 + i * 3) % 7;
      if (k === 6) return; // 그날은 일정이 없다
      const extra = { calendarId: id, other: true, calendarName: name, calendarColor: color, canWrite: false };
      if (k % 3 === 0) {
        const h = 9 + ((d + 24 + i) % 7);
        team.push(ev(`t${d}-${i}`, timed[(d + 24 + i) % timed.length], date, `${String(h).padStart(2, '0')}:00`, `${String(h + 1).padStart(2, '0')}:30`, '', extra));
      } else team.push(allDay(`t${d}-${i}`, dayLong[(d + 24 + i * 2) % dayLong.length], date, extra));
    });
  }
  return [
    ev('p1', 'MX 주간 미팅', addDays(mon, 1), '14:00', '15:00', '온라인', { meet: true }),
    ev('p2', '사무실', addDays(mon, 2), '09:00', '10:00', ''),
    ev('p3', 'AB Z+ 수집 서버 패치', addDays(mon, 3), '10:00', '12:00', '누리사옥 4층'),
    ev('p4', '가나스토어 정기점검', addDays(mon, 8), '10:00', '11:00', '동산사옥'),
    ev('p5', '분기 리뷰 회의', addDays(mon, 10), '15:00', '16:00', '본사 3층'),
    allDay('p6', '휴가', addDays(mon, 11)),
    allDay('p7', '예시 공휴일', addDays(mon, 9), { calendarId: 'holiday', holiday: true, canWrite: false }),
    ev('p8', 'MX 알림 설정 회의', addDays(today, -2), '10:00', '11:00', '온라인', { meet: true }),
    // 반차(시각이 있는 휴가)와 동료 달력의 일정 — 띠에서 어떻게 보이는지
    ev('p9', '오후 반차', addDays(mon, 4), '14:00', '18:00', ''),
    ...team,
  ];
}

const NOTION_DBS: NotionSource[] = [
  { id: 'ds-meet', name: '회의', url: 'https://www.notion.so/00000000000000000000000000000001' },
  { id: 'ds-support', name: 'SR', url: 'https://www.notion.so/00000000000000000000000000000002' },
  { id: 'ds-decision', name: 'DL', url: 'https://www.notion.so/00000000000000000000000000000003' },
];

function seedNotion(today: string): NotionPage[] {
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const page = (n: number, sourceId: string, title: string, created: string, edited = created): NotionPage => ({
    id: `pg-${n}`,
    sourceId,
    title,
    createdAt: created,
    editedAt: edited,
    url: `https://www.notion.so/${String(n).padStart(32, '0')}`,
  });
  // 지원 기록은 하루에 여러 건 생기고 제목이 길다 — 날 칸에 다 들어가지 않는 양을 보려고 지난 8일의 평일마다 2~4건을 만든다
  const topics = [
    '[AB Z+] 수집 에이전트 재기동 후 지표 누락 문의',
    '[MX] 알림 정책 분류 기준 변경 요청',
    '[가나스토어] 대시보드 공유 권한 설정 문의',
    '[예시IT] 저장소 사용량 경고 임계값 조정',
    '[AB Z+] 패치 적용 뒤 로그 수집 지연',
    '[MX] 웹훅 연동 실패 원인 확인',
  ];
  const many: NotionPage[] = [];
  for (let d = 8; d >= 1; d--) {
    const date = addDays(today, -d);
    const dow = new Date(`${date}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) continue;
    const count = 2 + (d % 3);
    for (let i = 0; i < count; i++) many.push(page(100 + d * 10 + i, 'ds-support', topics[(d + i * 2) % topics.length], at(date, `${String(9 + i * 2).padStart(2, '0')}:${i % 2 ? '40' : '10'}`)));
  }
  return [
    ...many,
    // 이틀 전 10:00 'MX 알림 설정 회의' 중에 만든 회의록 — 그 일정 줄에 이어진다
    page(11, 'ds-meet', 'MX 알림 설정 회의', at(addDays(today, -2), '10:05'), at(addDays(today, -1), '09:20')),
    page(21, 'ds-support', '수집 누락 원인 문의', at(addDays(today, -5), '11:00'), at(today, '09:10')),
    page(22, 'ds-support', '알림 분류 개선 요청', at(addDays(today, -1), '15:30')),
    page(23, 'ds-support', '에이전트 재기동 절차 문의', at(addDays(today, -2), '13:10')),
    page(24, 'ds-support', '대시보드 권한 문의', at(addDays(today, -3), '10:40')),
    page(25, 'ds-support', '저장소 사용량 경고 문의', at(addDays(today, -4), '16:00')),
    page(31, 'ds-decision', '수집 서버 패치 순서 결정', at(addDays(today, -20), '14:00'), at(addDays(today, -1), '17:40')),
    page(41, '', '예시 팀 온보딩 안내', at(addDays(today, -40), '09:00'), at(addDays(today, -3), '18:05')),
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
  state = applyOp(state, { type: 'settings', patch: { notion: { sources: NOTION_DBS, meetings: 'ds-meet', loose: true, days: 7 } } }, ctx).state;
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
        { id: 'primary', summary: '내 달력', primary: true, canWrite: true, holiday: false, mine: true },
        { id: 'holiday', summary: '예시 공휴일 달력', primary: false, canWrite: false, holiday: true, mine: false },
        ...TEAM.map(({ id, name, color }) => ({ id, summary: name, primary: false, canWrite: false, holiday: false, mine: false, color })),
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
    notionStatus: async () => ({ connected: true, stored: true, encryption: true }),
    notionSetKey: async () => ({ ok: false, error: '미리보기에서는 키를 저장하지 않습니다.' }),
    notionClearKey: async () => ({ ok: false }),
    notionSources: async () => ({ ok: true, sources: NOTION_DBS }),
    notionResolve: async () => ({ ok: false, code: 'not-found', message: '미리보기에서는 주소로 찾을 수 없습니다.' }),
    notionRecent: async (req) => ({
      ok: true,
      pages: seedNotion(todayIso()).filter((x) => (x.sourceId ? req.sources.includes(x.sourceId) : req.loose === true) && x.editedAt >= req.since),
      readAt: Date.now(),
      fromCache: false,
      failed: [],
    }),
    openExternal: async () => ({ ok: false, error: '미리보기' }),
  };
}
