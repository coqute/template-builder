/**
 * 홈 — 묶음·2주 띠·요약·달력 분류·바뀐 일정·주간보고 표지·일지 덧붙이기. 값은 모두 합성이다.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorklogEntry, WorklogSaveRequest } from '../electron/worklog-types';
import type { PlannerApi } from '../src/planner/api';
import { classifyEvents, detectClient, diffEvents, eventsOn, kindOf } from '../src/planner/classify';
import { agendaDays, bucketOf, buildStrip, closedInWorklog, groupTasks, recentPastEvents, summarize, visibleCandidates, waitingDays } from '../src/planner/model';
import { applyOp, emptyState, newTaskId } from '../src/planner/ops';
import { insertPlanLines, plansFromEvents, scanWeekly } from '../src/planner/sources/weekly';
import type { Candidate } from '../src/planner/sources/worklog';
import type { PlannerState, RawEvent, Task, TaskDraft, WorklogAnchor } from '../src/planner/types';
import { appendToWorklog, doneBlock, eventBlock, hasEventBlock } from '../src/planner/worklogWrite';

// 2026-11-23은 월요일
const TODAY = '2026-11-23';
const ctx = { now: '2026-11-23T00:00:00.000Z', today: TODAY, by: 'app' as const, newId: newTaskId };

function stateOf(drafts: TaskDraft[]): PlannerState {
  return drafts.reduce((s, draft) => applyOp(s, { type: 'task.add', draft }, ctx).state, emptyState());
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
function raw(id: string, summary: string, date: string, start = '10:00', end = '11:00', extra: Partial<RawEvent> = {}): RawEvent {
  return {
    calendarId: 'primary',
    id,
    summary,
    location: '',
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
    updated: '',
    ...extra,
  };
}
const allDay = (id: string, summary: string, date: string, endExclusive: string, extra: Partial<RawEvent> = {}) =>
  raw(id, summary, date, '00:00', '00:00', { allDay: true, start: date, end: endExclusive, ...extra });

const ANCHOR: WorklogAnchor = { folder: 'AB Z+ 작업', name: '[2026-11-18] 점검.txt', date: '2026-11-18', caseKey: '수집누락원인문의', nth: 0, line: 3, title: '수집 누락 원인 문의', source: '홍길동/메일' };

describe('묶음 (model.ts)', () => {
  it('기한으로 묶음을 정한다 — 이번 주는 일요일까지', () => {
    expect(bucketOf({ due: null }, TODAY)).toBe('none');
    expect(bucketOf({ due: '2026-11-22' }, TODAY)).toBe('late');
    expect(bucketOf({ due: TODAY }, TODAY)).toBe('today');
    expect(bucketOf({ due: '2026-11-29' }, TODAY)).toBe('week');
    expect(bucketOf({ due: '2026-11-30' }, TODAY)).toBe('later');
    // 일요일에 보면 '이번 주'는 그날뿐이다
    expect(bucketOf({ due: '2026-11-30' }, '2026-11-29')).toBe('later');
  });

  it('끝낸 일·기다리는 일은 따로, 묶음 안은 기한 빠른 순', () => {
    let s = stateOf([{ title: '나중', due: '2026-11-27' }, { title: '먼저', due: '2026-11-25' }, { title: '기다림', state: 'waiting', waitingOn: '고객' }, { title: '끝낼 일' }]);
    s = applyOp(s, { type: 'task.done', id: s.tasks[3].id, done: true }, ctx).state;
    const g = groupTasks(s.tasks, TODAY);
    expect(g.buckets.week.map((t) => t.title)).toEqual(['먼저', '나중']);
    expect(g.waiting.map((t) => t.title)).toEqual(['기다림']);
    expect(g.done.map((t) => t.title)).toEqual(['끝낼 일']);
    expect(g.buckets.none).toEqual([]);
    expect(waitingDays(g.waiting[0], '2026-11-28')).toBe(5);
  });

  it('후보는 무시한 것·이미 할 일로 올린 사안을 뺀다', () => {
    const cand = (title: string, key: string, anchor?: WorklogAnchor): Candidate => ({ key, source: 'worklog', cls: 'todo', title, client: '', who: '', phrase: '대응 예정', waitingOn: '', date: '2026-11-18', due: null, anchor });
    const list = [cand('가', 'k1', { ...ANCHOR, caseKey: '가' }), cand('나', 'k2', ANCHOR), cand('다', 'k3', { ...ANCHOR, caseKey: '다' })];
    const s = stateOf([{ title: '올린 일', origin: { kind: 'worklog', anchor: ANCHOR } }]);
    expect(visibleCandidates(list, { ...s, hiddenCandidates: ['k1'] }).map((c) => c.title)).toEqual(['다']);
  });

  it('일지에서 닫힌 사안의 할 일에는 끝냄 제안이 붙는다 — 가리키는 기록보다 뒤에 닫힌 것만', () => {
    const s = stateOf([{ title: '올린 일', origin: { kind: 'worklog', anchor: ANCHOR } }]);
    const key = `${ANCHOR.folder}\u0000${ANCHOR.caseKey}`;
    expect(closedInWorklog(s.tasks, { closed: new Map([[key, '2026-11-20']]) }).get(s.tasks[0].id)).toBe('2026-11-20');
    expect(closedInWorklog(s.tasks, { closed: new Map([[key, '2026-11-10']]) }).size).toBe(0);
    expect(closedInWorklog(s.tasks, null).size).toBe(0);
  });
});

describe('달력 분류 (classify.ts)', () => {
  it('회의·작업·휴가·공휴일·근무 위치를 가른다', () => {
    expect(kindOf({ summary: 'MX 주간 미팅', eventType: 'default', holiday: false, meet: false })).toBe('meeting');
    expect(kindOf({ summary: '온라인 점검', eventType: 'default', holiday: false, meet: true })).toBe('meeting');
    expect(kindOf({ summary: 'AB Z+ 수집 서버 패치', eventType: 'default', holiday: false, meet: false })).toBe('work');
    expect(kindOf({ summary: '[휴가] 홍길동', eventType: 'default', holiday: false, meet: false })).toBe('leave');
    expect(kindOf({ summary: '오후 반차', eventType: 'default', holiday: false, meet: false })).toBe('leave');
    expect(kindOf({ summary: '예시 공휴일', eventType: 'default', holiday: true, meet: false })).toBe('holiday');
    // 회사 이름(테스트 설정: 예시IT)을 떼고 근무 위치 낱말뿐이면 회의가 아니다
    expect(kindOf({ summary: '예시IT 사무실', eventType: 'default', holiday: false, meet: false })).toBe('place');
    expect(kindOf({ summary: '사무실', eventType: 'default', holiday: false, meet: false })).toBe('place');
    expect(kindOf({ summary: '사무실 이전 회의', eventType: 'default', holiday: false, meet: false })).toBe('meeting');
    expect(kindOf({ summary: '재택', eventType: 'workingLocation', holiday: false, meet: false })).toBe('place');
  });

  it('취소·거절·생일·숨긴 일정은 버리고, 종일 일정의 끝은 포함 날짜로 바꾼다', () => {
    const events = classifyEvents(
      [
        raw('a', 'AB Z+ 수집 서버 패치', '2026-11-26', '10:00', '12:00', { location: '누리사옥 4층' }),
        raw('b', '거절한 회의', '2026-11-26', '13:00', '14:00', { declined: true }),
        raw('c', '생일', '2026-11-26', '00:00', '00:00', { eventType: 'birthday' }),
        raw('d', '점심', '2026-11-26', '12:00', '13:00'),
        raw('e', '숨긴 일정', '2026-11-27'),
        allDay('f', '휴가', '2026-12-03', '2026-12-05'),
      ],
      { hiddenTitles: ['점심'], hiddenEvents: ['primary/e'] },
    );
    expect(events.map((e) => e.title)).toEqual(['AB Z+ 수집 서버 패치', '휴가']);
    expect(events[0]).toMatchObject({ kind: 'work', client: 'AB Z+', date: '2026-11-26', startTime: '10:00', endTime: '12:00', location: '누리사옥 4층' });
    expect(events[1]).toMatchObject({ kind: 'leave', allDay: true, date: '2026-12-03', endDate: '2026-12-04' });
    // 여러 날 일정은 날마다 걸린다
    expect(eventsOn(events, '2026-12-04').map((e) => e.title)).toEqual(['휴가']);
    expect(eventsOn(events, '2026-12-05')).toEqual([]);
    expect(detectClient('제트플러스 북악사옥 방문')).toBe('AB Z+');
    expect(detectClient('사내 회의')).toBe('');
  });

  it('확인한 뒤 바뀐 일정을 찾는다 — 시각·취소·제목, 지난 일정은 빼고', () => {
    const base = [raw('a', '정기점검', '2026-12-01'), raw('b', '분기 리뷰 회의', '2026-12-03'), raw('c', '지난 회의', '2026-11-20'), raw('d', '그대로', '2026-12-02')];
    const now = [raw('a', '정기점검', '2026-12-01', '14:00', '15:00'), raw('d', '그대로', '2026-12-02'), raw('e', '새 일정', '2026-12-04')];
    expect(diffEvents(base, now, TODAY)).toEqual([
      { key: 'primary/a', title: '정기점검', what: '12/1 10:00 → 14:00' },
      { key: 'primary/b', title: '분기 리뷰 회의', what: '12/3 10:00 취소됨' },
    ]);
    expect(diffEvents(null, now, TODAY)).toEqual([]);
    expect(diffEvents([raw('a', '정기점검', '2026-12-01')], [raw('a', '정기 점검', '2026-12-02')], TODAY)[0].what).toBe('12/1 10:00 → 12/2 10:00 · 제목 바뀜');
  });
});

describe('2주 띠·요약·확정 일정', () => {
  const events = classifyEvents([
    raw('m', 'MX 주간 미팅', '2026-11-24', '14:00', '15:00'),
    raw('o', '사무실', '2026-11-25', '09:00', '10:00'),
    raw('p', 'AB Z+ 수집 서버 패치', '2026-11-26'),
    allDay('h', '예시 공휴일', '2026-12-02', '2026-12-03', { holiday: true, calendarId: 'holiday' }),
    allDay('v', '휴가', '2026-12-04', '2026-12-05'),
    raw('x', '지난 회의', '2026-11-20'),
  ]);
  const s = stateOf([{ title: '지남', due: '2026-11-20' }, { title: '오늘', due: TODAY }, { title: '수요일', due: '2026-11-25' }, { title: '기다림', due: '2026-11-25', state: 'waiting' }]);
  const open = s.tasks.filter((t: Task) => t.state === 'todo');

  it('날 칸에 근무 위치·휴일·일정·할 일 수가 들어간다', () => {
    const [w1, w2] = buildStrip(TODAY, events, open);
    expect(w1.map((d) => d.date)[0]).toBe('2026-11-23');
    expect(w1[0]).toMatchObject({ today: true, late: 1, due: 1, weekend: false });
    expect(w1[1].events.map((e) => e.title)).toEqual(['MX 주간 미팅']);
    expect(w1[2]).toMatchObject({ place: '사무실', due: 1 });
    expect(w1[2].events).toEqual([]);
    expect(w1[5].weekend).toBe(true);
    expect(w2[2].off).toBe('예시 공휴일');
    expect(w2[4].off).toBe('휴가');
  });

  it('요약은 다음 일정과 숫자 다섯을 준다', () => {
    const sum = summarize(TODAY, groupTasks(s.tasks, TODAY), events);
    expect(sum).toMatchObject({ late: 1, today: 1, week: 1, weekEvents: 2, waiting: 1, todayEvents: 0 });
    expect(sum.next?.title).toBe('MX 주간 미팅');
  });

  it('확정 일정은 오늘부터 2주 끝까지 — 근무 위치는 빼고, 지난 일정은 따로', () => {
    expect(agendaDays(TODAY, events).map((d) => `${d.date}:${d.events.map((e) => e.title).join(',')}`)).toEqual([
      '2026-11-24:MX 주간 미팅',
      '2026-11-26:AB Z+ 수집 서버 패치',
      '2026-12-02:예시 공휴일',
      '2026-12-04:휴가',
    ]);
    expect(recentPastEvents(TODAY, events).map((e) => e.title)).toEqual(['지난 회의']);
  });
});

describe('주간보고 표지 (sources/weekly.ts)', () => {
  const MD = [
    '@PREV 2026-11-16 ~ 2026-11-22',
    '@CURRENT 2026-11-23 ~ 2026-11-29',
    '@AUTHOR 홍길동',
    '@PLAN 2026-11-24 10:00 MX(주간미팅)',
    '@PLAN 2026-11-20 지난 일정',
    '',
    '# 2026-11-17(화)',
    '@LOC 회사',
    '@CUS MX',
    '@SUM [MX] (담당C/메일) 에이전트 이름 변경 반영 안 됨',
    '  -> 서버 이름을 바꿔도 목록에 반영 안 됨',
    '  *<- 에이전트 로그 공유 요청',
    '@SUM [MX] (담당D/유선) 알림 설정',
    '  <- 설정 방법 안내',
    '  *-> 적용 결과 회신 예정',
    '  - 확인 필요',
  ].join('\n');

  it('미결 표지와 @PLAN만 읽는다 — 문장 속 상태 낱말은 읽지 않는다', () => {
    const r = scanWeekly([{ name: '', text: MD }], TODAY);
    expect(r.candidates.map((c) => [c.cls, c.title, c.phrase, c.client, c.who])).toEqual([
      ['todo', '에이전트 이름 변경 반영 안 됨', '에이전트 로그 공유 요청', 'MX', '담당C'],
      ['wait', '알림 설정', '적용 결과 회신 예정', 'MX', '담당D'],
    ]);
    // 제목에 '미팅'이 있으면 회의로 본다. 지난 날짜의 줄은 버린다
    expect(r.plans.map((p) => [p.date, p.startTime, p.title, p.kind])).toEqual([['2026-11-24', '10:00', 'MX(주간미팅)', 'meeting']]);
    expect(r.from?.week).toBe('2026-11-16');
  });

  it('보고 주가 가장 늦은 보고서 하나만 읽는다', () => {
    const older = MD.replace('2026-11-16 ~ 2026-11-22', '2026-11-09 ~ 2026-11-15').replace('에이전트 로그 공유 요청', '옛 요청');
    expect(scanWeekly([{ name: 'old.md', text: older }, { name: 'new.md', text: MD }], TODAY).candidates[0].phrase).toBe('에이전트 로그 공유 요청');
    expect(scanWeekly([{ name: '', text: '' }], TODAY)).toEqual({ candidates: [], plans: [], from: null });
  });

  it('달력 일정을 @PLAN 줄로 만들어 머리에 끼워 넣는다 — 다른 줄은 그대로', () => {
    const events = classifyEvents([raw('a', '가나스토어 정기점검', '2026-12-01'), allDay('b', '휴가', '2026-12-04', '2026-12-05'), raw('c', '사무실', '2026-12-02'), raw('d', '범위 밖', '2026-12-09')]);
    const plans = plansFromEvents(events, { start: '2026-11-30', end: '2026-12-06' });
    expect(plans).toEqual([
      { date: '2026-12-01', text: '10:00 가나스토어 정기점검' },
      { date: '2026-12-04', text: '휴가' },
    ]);
    const next = insertPlanLines(MD, plans).split('\n');
    expect(next.slice(3, 7)).toEqual(['@PLAN 2026-11-24 10:00 MX(주간미팅)', '@PLAN 2026-11-20 지난 일정', '@PLAN 2026-12-01 10:00 가나스토어 정기점검', '@PLAN 2026-12-04 휴가']);
    expect(next.filter((l) => !l.startsWith('@PLAN 2026-12'))).toEqual(MD.split('\n'));
    // @PLAN이 없으면 마지막 머리 지시어 뒤
    expect(insertPlanLines('@PREV 2026-11-16 ~ 2026-11-22\n@AUTHOR 홍길동\n\n# 2026-11-16(월)', plans.slice(0, 1)).split('\n')[2]).toBe('@PLAN 2026-12-01 10:00 가나스토어 정기점검');
  });
});

describe('일지에 덧붙이기 (worklogWrite.ts)', () => {
  it('끝낸 할 일의 블록 — 일지 사안에서 온 것은 그 사안의 후속으로', () => {
    expect(doneBlock({ title: '백업 절차 확인', origin: { kind: 'worklog', anchor: ANCHOR } }, TODAY)).toBe('■ (홍길동/메일) 수집 누락 원인 문의 (11/18 문의 후속)\n▶ 백업 절차 확인 완료');
    expect(doneBlock({ title: '수집 누락 원인 문의', origin: { kind: 'worklog', anchor: { ...ANCHOR, date: TODAY, source: '' } } }, TODAY)).toBe('■ 수집 누락 원인 문의 (후속)\n▶ 처리 완료');
    expect(doneBlock({ title: '체크리스트 갱신', origin: { kind: 'manual' } }, TODAY)).toBe('■ 체크리스트 갱신\n▶ 처리 완료');
  });

  it('회의 블록 초안과 중복 판정', () => {
    expect(eventBlock({ title: 'MX 주간 미팅', kind: 'meeting' })).toBe('■ MX 주간 미팅 회의 (캘린더 일정)');
    expect(eventBlock({ title: '분기 리뷰 회의', kind: 'meeting' })).toBe('■ 분기 리뷰 회의 (캘린더 일정)');
    expect(eventBlock({ title: 'AB Z+ 수집 서버 패치', kind: 'work' })).toBe('■ AB Z+ 수집 서버 패치 (캘린더 일정)');
    expect(hasEventBlock('[2026-11-20] 점검\n\n■ MX 주간 미팅 회의 (캘린더 일정)\n▶ 참석', '■ MX 주간 미팅 회의 (캘린더 일정)')).toBe(true);
    expect(hasEventBlock('[2026-11-20] 점검\n\n■ MX 주간 미팅 회의 준비', '■ MX 주간 미팅 회의 (캘린더 일정)')).toBe(false);
  });

  function fakeApi(files: Record<string, string>) {
    const entry = (name: string): WorklogEntry => ({ folder: 'AB Z+ 작업', name, date: name.slice(1, 11), title: name.slice(13, -4), size: 1, mtimeMs: 1 });
    const save = vi.fn(async (req: WorklogSaveRequest) => {
      if (files[req.name] !== req.base) return { ok: false as const, code: 'changed' as const, disk: files[req.name], mtimeMs: 2, size: 1 };
      files[req.name] = req.text;
      return { ok: true as const, mtimeMs: 2, size: 1 };
    });
    const api = {
      worklogList: async () => ({ ok: true as const, files: Object.keys(files).map(entry) }),
      worklogRead: async (ref: { name: string }) => ({ ok: true as const, text: files[ref.name], mtimeMs: 1, size: 1, bom: false, crlf: false, legacyEncoding: false }),
      worklogSave: save,
      worklogCreate: vi.fn(async (req: { date: string; title: string; text: string }) => {
        const name = `[${req.date}] ${req.title}.txt`;
        files[name] = req.text;
        return { ok: true as const, name, mtimeMs: 1, size: 1 };
      }),
    } as unknown as PlannerApi;
    return { api, save, files };
  }

  it('그날 일지 끝에만 붙인다 — 기존 내용은 앞부분 그대로', async () => {
    const name = '[2026-11-23] 오늘 작업.txt';
    const before = '[2026-11-23] 오늘 작업\n\n■ (홍길동/메신저) 이벤트 설정 문의\n▶ 설정 방법 안내\n';
    const { api, files } = fakeApi({ [name]: before });
    const r = await appendToWorklog(api, { folder: 'AB Z+ 작업', date: TODAY, title: '무시', block: '■ 체크리스트 갱신\n▶ 처리 완료' });
    expect(r).toEqual({ ok: true, name, created: false });
    expect(files[name]).toBe(`${before.trimEnd()}\n\n■ 체크리스트 갱신\n▶ 처리 완료\n`);
    expect(files[name].startsWith(before.trimEnd())).toBe(true);
  });

  it('읽은 뒤 파일이 바뀌었으면 바뀐 내용 뒤에 다시 붙인다', async () => {
    const name = '[2026-11-23] 오늘 작업.txt';
    const { api, save, files } = fakeApi({ [name]: '[2026-11-23] 오늘 작업\n\n■ 가\n' });
    // 읽기와 저장 사이에 루틴이 덧붙임
    save.mockImplementationOnce(async () => {
      files[name] += '\n■ 루틴이 덧붙인 사안\n';
      return { ok: false as const, code: 'changed' as const, disk: files[name], mtimeMs: 3, size: 1 };
    });
    const r = await appendToWorklog(api, { folder: 'AB Z+ 작업', date: TODAY, title: '무시', block: '■ 나' });
    expect(r.ok).toBe(true);
    expect(files[name]).toBe('[2026-11-23] 오늘 작업\n\n■ 가\n\n■ 루틴이 덧붙인 사안\n\n■ 나\n');
  });

  it('그날 일지가 없으면 그 블록으로 새로 만들고, 같은 회의 블록이 있으면 쓰지 않는다', async () => {
    const { api, files } = fakeApi({});
    const made = await appendToWorklog(api, { folder: 'AB Z+ 작업', date: '2026-11-20', title: 'MX 주간 미팅', block: '■ MX 주간 미팅 회의 (캘린더 일정)', skipIfEventExists: true });
    expect(made).toEqual({ ok: true, name: '[2026-11-20] MX 주간 미팅.txt', created: true });
    expect(files['[2026-11-20] MX 주간 미팅.txt']).toBe('[2026-11-20] MX 주간 미팅\n\n■ MX 주간 미팅 회의 (캘린더 일정)\n');
    const again = await appendToWorklog(api, { folder: 'AB Z+ 작업', date: '2026-11-20', title: 'MX 주간 미팅', block: '■ MX 주간 미팅 회의 (캘린더 일정)', skipIfEventExists: true });
    expect(again).toMatchObject({ ok: false, duplicate: true });
  });
});
