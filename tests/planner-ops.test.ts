/**
 * 플래너 동작(src/planner/ops.ts) — 순수 함수(상태 → 상태)라 파일 없이 본다.
 * 값은 모두 합성 값이다(AB Z+·MX·홍길동·담당A).
 */
import { describe, expect, it } from 'vitest';
import { applyOp, DEFAULT_SETTINGS, emptyState, newTaskId, normalizeState, PlannerError, type OpContext } from '../src/planner/ops';
import type { EventLink, PlannerOp, PlannerState, Task, WorklogAnchor } from '../src/planner/types';

const NOW = '2026-11-23T00:40:00.000Z';
const TODAY = '2026-11-23';

function ctx(over: Partial<OpContext> = {}): OpContext {
  let n = 0;
  return { now: NOW, today: TODAY, by: 'app', newId: () => `t_new${++n}`, ...over };
}

/** 동작을 차례로 적용한 상태 */
function run(ops: PlannerOp[], start: PlannerState = emptyState(), c: OpContext = ctx()): PlannerState {
  return ops.reduce((s, op) => applyOp(s, op, c).state, start);
}

const ANCHOR: WorklogAnchor = {
  folder: '예시 작업',
  name: '[2026-11-18] 수집 점검.txt',
  date: '2026-11-18',
  caseKey: '수집누락원인문의',
  nth: 0,
  line: 14,
  title: '수집 누락 원인 문의',
  source: '홍길동/메일',
};

describe('task.add — 더하기', () => {
  it('제목만 있어도 더해지고 나머지 칸은 기본값이다', () => {
    const { state, log } = applyOp(emptyState(), { type: 'task.add', draft: { title: '  패치 적용 전   백업 절차 확인 ' } }, ctx());
    expect(state.rev).toBe(1);
    expect(state.tasks).toEqual<Task[]>([
      {
        id: 't_new1',
        title: '패치 적용 전 백업 절차 확인', // 앞뒤 공백을 떼고 겹친 공백은 하나로
        client: '',
        who: '',
        due: null,
        state: 'todo',
        waitingOn: '',
        waitingSince: null,
        note: '',
        origin: { kind: 'manual' },
        event: null,
        createdAt: NOW,
        updatedAt: NOW,
        doneAt: null,
        by: 'app',
      },
    ]);
    expect(log).toEqual({ at: NOW, by: 'app', rev: 1, op: 'task.add', id: 't_new1', after: state.tasks[0] });
  });

  it('칸을 채워 더한다 — 고객사·요청자·기한·메모·일지 닻·이어진 일정', () => {
    const s = run([
      {
        type: 'task.add',
        id: 't_a',
        draft: {
          title: '수집 서버 패치 일정 회신',
          client: 'AB Z+',
          who: '홍길동',
          due: '2026-11-25',
          note: '첫 줄\r\n둘째 줄',
          origin: { kind: 'worklog', anchor: ANCHOR },
          event: { calendarId: 'primary', eventId: 'evt1' },
        },
      },
    ]);
    expect(s.tasks[0]).toMatchObject({
      id: 't_a',
      client: 'AB Z+',
      who: '홍길동',
      due: '2026-11-25',
      note: '첫 줄\n둘째 줄',
      origin: { kind: 'worklog', anchor: ANCHOR },
      event: { calendarId: 'primary', eventId: 'evt1' },
    });
  });

  it('닻의 모양이 틀리면 직접 입력으로 둔다', () => {
    const bad = { ...ANCHOR, name: '하위/[2026-11-18] 수집 점검.txt' }; // 파일 이름에 경로 구분자
    const s = run([{ type: 'task.add', draft: { title: 'MX 주간 미팅 준비', origin: { kind: 'worklog', anchor: bad } } }]);
    expect(s.tasks[0].origin).toEqual({ kind: 'manual' });
  });

  it('기다리는 중으로 더하면 기다리기 시작한 날이 오늘이다. 내 차례면 기다리는 대상을 버린다', () => {
    const s = run([
      { type: 'task.add', id: 't_w', draft: { title: '로그 회수 요청', state: 'waiting', waitingOn: '담당A' } },
      { type: 'task.add', id: 't_t', draft: { title: '원인 정리', waitingOn: '담당A' } },
    ]);
    expect(s.tasks[0]).toMatchObject({ state: 'waiting', waitingOn: '담당A', waitingSince: TODAY });
    expect(s.tasks[1]).toMatchObject({ state: 'todo', waitingOn: '', waitingSince: null });
  });

  it('입력 검사 — 빈 제목, 가짜 날짜(2026-02-30), 날짜 모양이 아닌 기한, 같은 ID', () => {
    const base = run([{ type: 'task.add', id: 't_a', draft: { title: '있는 할 일' } }]);
    const bad: PlannerOp[] = [
      { type: 'task.add', draft: { title: '   ' } },
      { type: 'task.add', draft: { title: '기한이 가짜', due: '2026-02-30' } },
      { type: 'task.add', draft: { title: '기한 모양이 다름', due: '11/27' } },
      { type: 'task.add', id: 't_a', draft: { title: '같은 ID' } },
    ];
    for (const op of bad) expect(() => applyOp(base, op, ctx())).toThrow(PlannerError);
    expect(base.rev).toBe(1); // 실패한 동작은 상태를 바꾸지 않는다
    expect(base.tasks).toHaveLength(1);
  });
});

describe('task.update — 고치기', () => {
  const base = run([{ type: 'task.add', id: 't_a', draft: { title: '용량 산정', client: 'MX', due: '2026-12-02' } }]);

  it('준 칸만 바꾸고 고친 때·고친 쪽을 남긴다', () => {
    const later = ctx({ now: '2026-11-24T01:00:00.000Z', today: '2026-11-24', by: 'claude' });
    const { state, log } = applyOp(base, { type: 'task.update', id: 't_a', patch: { due: '2026-12-04', note: '증설 뒤 다시 계산' } }, later);
    expect(state.tasks[0]).toMatchObject({
      title: '용량 산정',
      client: 'MX',
      due: '2026-12-04',
      note: '증설 뒤 다시 계산',
      createdAt: NOW,
      updatedAt: '2026-11-24T01:00:00.000Z',
      by: 'claude',
    });
    expect(log).toMatchObject({ op: 'task.update', id: 't_a', by: 'claude', rev: 2 });
    expect((log.before as Task).due).toBe('2026-12-02');
    expect((log.after as Task).due).toBe('2026-12-04');
    expect(base.tasks[0].due).toBe('2026-12-02'); // 넘긴 상태는 그대로다
  });

  it('기한을 null로 주면 지운다', () => {
    expect(run([{ type: 'task.update', id: 't_a', patch: { due: null } }], base).tasks[0].due).toBeNull();
  });

  it('입력 검사 — 빈 제목, 가짜 날짜, 모르는 상태, 없는 ID', () => {
    const bad: PlannerOp[] = [
      { type: 'task.update', id: 't_a', patch: { title: ' ' } },
      { type: 'task.update', id: 't_a', patch: { due: '2026-02-30' } },
      { type: 'task.update', id: 't_a', patch: { state: 'done' as never } },
      { type: 'task.update', id: 't_none', patch: { title: '없는 할 일' } },
    ];
    for (const op of bad) expect(() => applyOp(base, op, ctx())).toThrow(PlannerError);
  });

  it('기다리는 중으로 바꾸면 그날이 기다리기 시작한 날이고, 다시 고쳐도 그 날짜를 지킨다', () => {
    const day1 = ctx({ today: '2026-11-24' });
    const day5 = ctx({ today: '2026-11-28' });
    const waiting = applyOp(base, { type: 'task.update', id: 't_a', patch: { state: 'waiting', waitingOn: '담당A' } }, day1).state;
    expect(waiting.tasks[0]).toMatchObject({ state: 'waiting', waitingOn: '담당A', waitingSince: '2026-11-24' });
    const again = applyOp(waiting, { type: 'task.update', id: 't_a', patch: { state: 'waiting', waitingOn: '홍길동' } }, day5).state;
    expect(again.tasks[0]).toMatchObject({ waitingOn: '홍길동', waitingSince: '2026-11-24' });
  });

  it('내 차례로 돌리면 기다리는 대상·시작한 날을 지운다. 내 차례일 때 준 기다리는 대상은 버린다', () => {
    const waiting = run([{ type: 'task.update', id: 't_a', patch: { state: 'waiting', waitingOn: '담당A' } }], base);
    const back = run([{ type: 'task.update', id: 't_a', patch: { state: 'todo' } }], waiting);
    expect(back.tasks[0]).toMatchObject({ state: 'todo', waitingOn: '', waitingSince: null });
    const ignored = run([{ type: 'task.update', id: 't_a', patch: { waitingOn: '담당A' } }], base);
    expect(ignored.tasks[0].waitingOn).toBe('');
  });
});

describe('task.done · task.remove · task.restore — 끝냄·지우기·되살리기', () => {
  const base = run([
    { type: 'task.add', id: 't_a', draft: { title: '백업 절차 확인', client: 'AB Z+' } },
    { type: 'task.add', id: 't_b', draft: { title: '주간 미팅 준비', client: 'MX' } },
  ]);

  it('끝낸 할 일은 지우지 않고 끝낸 때만 남긴다. 되돌리면 지운다', () => {
    const done = run([{ type: 'task.done', id: 't_a', done: true }], base);
    expect(done.tasks).toHaveLength(2);
    expect(done.tasks[0].doneAt).toBe(NOW);
    expect(run([{ type: 'task.done', id: 't_a', done: false }], done).tasks[0].doneAt).toBeNull();
    expect(() => applyOp(base, { type: 'task.done', id: 't_none', done: true }, ctx())).toThrow(PlannerError);
  });

  it('지운 할 일은 기록의 before로 그대로 되살릴 수 있다', () => {
    const removed = applyOp(base, { type: 'task.remove', id: 't_a' }, ctx());
    expect(removed.state.tasks.map((t) => t.id)).toEqual(['t_b']);
    expect(removed.log).toMatchObject({ op: 'task.remove', id: 't_a' });
    const restored = applyOp(removed.state, { type: 'task.restore', task: removed.log.before as Task }, ctx());
    expect(restored.state.tasks.find((t) => t.id === 't_a')).toEqual(base.tasks[0]);
    expect(restored.state.rev).toBe(base.rev + 2);
  });

  it('없는 할 일 지우기, 이미 있는 ID 되살리기, 모양이 다른 값 되살리기는 거부한다', () => {
    expect(() => applyOp(base, { type: 'task.remove', id: 't_none' }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(base, { type: 'task.restore', task: base.tasks[0] }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(base, { type: 'task.restore', task: { id: 't_c' } as Task }, ctx())).toThrow(PlannerError);
  });
});

describe('숨김 토글 — 후보·일정·제목', () => {
  it('켜면 목록에 한 번만 들어가고 끄면 빠진다', () => {
    const on = run([
      { type: 'candidate.hide', key: '예시 작업|웹훅연동설정전수확인@2026-11-12', hidden: true },
      { type: 'candidate.hide', key: '예시 작업|웹훅연동설정전수확인@2026-11-12', hidden: true },
      { type: 'event.hide', ref: { calendarId: 'primary', eventId: 'evt2' }, hidden: true },
      { type: 'title.hide', title: ' 점심 ', hidden: true },
    ]);
    expect(on.hiddenCandidates).toEqual(['예시 작업|웹훅연동설정전수확인@2026-11-12']);
    expect(on.hiddenEvents).toEqual(['primary/evt2']);
    expect(on.hiddenTitles).toEqual(['점심']);
    expect(on.rev).toBe(4);

    const off = run(
      [
        { type: 'candidate.hide', key: '예시 작업|웹훅연동설정전수확인@2026-11-12', hidden: false },
        { type: 'event.hide', ref: { calendarId: 'primary', eventId: 'evt2' }, hidden: false },
        { type: 'title.hide', title: '점심', hidden: false },
      ],
      on,
    );
    expect([off.hiddenCandidates, off.hiddenEvents, off.hiddenTitles]).toEqual([[], [], []]);
  });

  it('가리키는 값이 없으면 거부한다', () => {
    const s = emptyState();
    expect(() => applyOp(s, { type: 'candidate.hide', key: '', hidden: true }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(s, { type: 'event.hide', ref: { calendarId: 'primary', eventId: '' }, hidden: true }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(s, { type: 'title.hide', title: '  ', hidden: true }, ctx())).toThrow(PlannerError);
  });
});

describe('link.set · link.remove — 일정과 일지 사안 잇기', () => {
  const link: EventLink = { calendarId: 'primary', eventId: 'evt1', anchor: ANCHOR };

  it('같은 일정을 다시 이으면 바꿔 끼운다', () => {
    const other = { ...ANCHOR, caseKey: '패치적용일정문의', title: '패치 적용 일정 문의', line: 30 };
    const s = run([
      { type: 'link.set', link },
      { type: 'link.set', link: { calendarId: 'primary', eventId: 'evt9', anchor: ANCHOR } },
      { type: 'link.set', link: { ...link, anchor: other } },
    ]);
    expect(s.links).toHaveLength(2);
    expect(s.links.find((l) => l.eventId === 'evt1')?.anchor.caseKey).toBe('패치적용일정문의');
  });

  it('이은 것을 푼다. 없는 것을 풀어도 오류는 아니다', () => {
    const s = run([{ type: 'link.set', link }]);
    expect(run([{ type: 'link.remove', ref: { calendarId: 'primary', eventId: 'evt1' } }], s).links).toEqual([]);
    expect(run([{ type: 'link.remove', ref: { calendarId: 'primary', eventId: 'evt-none' } }], s).links).toHaveLength(1);
  });

  it('닻이나 일정 ID가 빠지면 거부한다', () => {
    const s = emptyState();
    expect(() => applyOp(s, { type: 'link.set', link: { calendarId: 'primary', eventId: 'evt1' } as EventLink }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(s, { type: 'link.set', link: { ...link, eventId: '' } }, ctx())).toThrow(PlannerError);
    expect(() => applyOp(s, { type: 'link.remove', ref: { calendarId: '', eventId: 'evt1' } }, ctx())).toThrow(PlannerError);
  });
});

describe('settings — 설정', () => {
  const days = (v: unknown, start = emptyState()) =>
    run([{ type: 'settings', patch: { lookbackDays: v as number } }], start).settings.lookbackDays;

  it('후보를 찾는 기간은 7~180일 안으로 맞춘다', () => {
    expect(days(3)).toBe(7);
    expect(days(7)).toBe(7);
    expect(days(45.4)).toBe(45);
    expect(days(180)).toBe(180);
    expect(days(999)).toBe(180);
  });

  it('숫자가 아니면 전 값을 지킨다', () => {
    const sixty = run([{ type: 'settings', patch: { lookbackDays: 60 } }]);
    expect(days('많이', sixty)).toBe(60);
    expect(days(Number.NaN, sixty)).toBe(60);
  });

  it('읽을 달력은 겹친 것을 빼고, 비면 본인 달력으로 돌린다. 주지 않은 칸은 그대로다', () => {
    const s = run([{ type: 'settings', patch: { calendars: ['primary', 'cal-holiday', 'primary', ' '] } }]);
    expect(s.settings).toEqual({ lookbackDays: DEFAULT_SETTINGS.lookbackDays, calendars: ['primary', 'cal-holiday'], holidays: true, notion: DEFAULT_SETTINGS.notion });
    expect(run([{ type: 'settings', patch: { calendars: [] } }], s).settings.calendars).toEqual(['primary']);
    expect(run([{ type: 'settings', patch: { lookbackDays: 14 } }], s).settings).toEqual({ lookbackDays: 14, calendars: ['primary', 'cal-holiday'], holidays: true, notion: DEFAULT_SETTINGS.notion });
  });
});

describe('rev · 순수성', () => {
  it('성공한 동작마다 rev가 1씩 오르고 기록에 같은 rev가 남는다', () => {
    const ops: PlannerOp[] = [
      { type: 'task.add', id: 't_a', draft: { title: '하나' } },
      { type: 'task.update', id: 't_a', patch: { title: '하나 고침' } },
      { type: 'task.done', id: 't_a', done: true },
      { type: 'candidate.hide', key: 'k', hidden: true },
      { type: 'settings', patch: { lookbackDays: 14 } },
      { type: 'task.remove', id: 't_a' },
    ];
    let s = emptyState();
    ops.forEach((op, i) => {
      const r = applyOp(s, op, ctx());
      expect(r.state.rev).toBe(i + 1);
      expect(r.log).toMatchObject({ rev: i + 1, op: op.type });
      s = r.state;
    });
  });

  it('넘긴 상태를 고치지 않는다. 모르는 동작은 거부한다', () => {
    const base = run([{ type: 'task.add', id: 't_a', draft: { title: '그대로' } }]);
    const copy = JSON.parse(JSON.stringify(base)) as PlannerState;
    run(
      [
        { type: 'task.update', id: 't_a', patch: { title: '바뀜', state: 'waiting' } },
        { type: 'task.done', id: 't_a', done: true },
        { type: 'title.hide', title: '점심', hidden: true },
        { type: 'settings', patch: { calendars: ['cal-b'] } },
        { type: 'task.remove', id: 't_a' },
      ],
      base,
    );
    expect(base).toEqual(copy);
    expect(() => applyOp(base, { type: 'task.archive' } as unknown as PlannerOp, ctx())).toThrow(PlannerError);
  });

  it('newTaskId는 t_로 시작하는 짧은 ID다', () => {
    expect(newTaskId()).toMatch(/^t_[0-9a-z]+$/);
  });
});

describe('normalizeState — 파일에서 읽은 값을 저장 모양으로', () => {
  it('모양이 아예 다르면 던진다', () => {
    for (const raw of [null, undefined, [], 'planner', 42]) expect(() => normalizeState(raw)).toThrow(PlannerError);
  });

  it('빠진 칸은 기본값으로 채운다', () => {
    expect(normalizeState({})).toEqual(emptyState());
    const s = normalizeState({ rev: 7, tasks: [{ id: 't_a', title: '제목만 있는 할 일' }] });
    expect(s.rev).toBe(7);
    expect(s.tasks[0]).toMatchObject({
      id: 't_a',
      client: '',
      who: '',
      due: null,
      state: 'todo',
      waitingOn: '',
      waitingSince: null,
      note: '',
      origin: { kind: 'manual' },
      event: null,
      doneAt: null,
      by: 'app',
    });
    expect(s.tasks[0].updatedAt).toBe(s.tasks[0].createdAt);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('ID·제목이 없는 할 일과 같은 ID의 둘째 것은 버린다', () => {
    const s = normalizeState({
      tasks: [
        { id: 't_a', title: '먼저 온 것' },
        { id: 't_a', title: '같은 ID' },
        { id: 't_b' },
        { title: 'ID 없음' },
        null,
        '할 일 아님',
        { id: 't_c', title: '남는 것' },
      ],
    });
    expect(s.tasks.map((t) => [t.id, t.title])).toEqual([
      ['t_a', '먼저 온 것'],
      ['t_c', '남는 것'],
    ]);
  });

  it('모양이 다른 값은 버리거나 기본값으로 돌린다', () => {
    const s = normalizeState({
      version: 9,
      rev: -3,
      extra: '모르는 칸',
      tasks: [
        {
          id: 't_a',
          title: '값이 이상한 할 일',
          due: '2026-02-30',
          state: 'someday',
          waitingOn: '담당A', // 내 차례인데 남아 있던 값
          waitingSince: '2026-11-01',
          origin: { kind: 'worklog', anchor: { name: '이름만' } },
          event: { calendarId: 'primary' },
          by: 'someone',
          snoozeUntil: '2026-12-01',
        },
      ],
      links: [
        { calendarId: 'primary', eventId: 'evt1', anchor: ANCHOR },
        { calendarId: 'primary', eventId: 'evt1', anchor: ANCHOR }, // 같은 일정
        { calendarId: 'primary', eventId: 'evt2' }, // 닻 없음
      ],
      hiddenCandidates: 'k1',
      hiddenEvents: ['primary/evt2', 'primary/evt2', 7, ''],
      hiddenTitles: null,
      settings: { lookbackDays: 1000, calendars: 'primary' },
    });
    expect(s.version).toBe(1);
    expect(s.rev).toBe(0);
    expect(s).not.toHaveProperty('extra');
    expect(s.tasks[0]).toMatchObject({ due: null, state: 'todo', waitingOn: '', waitingSince: null, origin: { kind: 'manual' }, event: null, by: 'app' });
    expect(s.tasks[0]).not.toHaveProperty('snoozeUntil');
    expect(s.links).toEqual([{ calendarId: 'primary', eventId: 'evt1', anchor: ANCHOR }]);
    expect(s.hiddenCandidates).toEqual([]);
    expect(s.hiddenEvents).toEqual(['primary/evt2']);
    expect(s.hiddenTitles).toEqual([]);
    expect(s.settings).toEqual({ lookbackDays: 180, calendars: ['primary'], holidays: true, notion: DEFAULT_SETTINGS.notion });
  });

  it('동작을 거친 상태는 다시 읽어도 같다', () => {
    const s = run([
      { type: 'task.add', id: 't_a', draft: { title: '로그 회수 요청', client: 'AB Z+', state: 'waiting', waitingOn: '담당A', origin: { kind: 'worklog', anchor: ANCHOR } } },
      { type: 'task.add', id: 't_b', draft: { title: '주간보고 미결', origin: { kind: 'weekly', file: '2026-11-16.md', line: 12 } } },
      { type: 'task.done', id: 't_b', done: true },
      { type: 'link.set', link: { calendarId: 'primary', eventId: 'evt1', anchor: ANCHOR } },
      { type: 'event.hide', ref: { calendarId: 'primary', eventId: 'evt2' }, hidden: true },
      { type: 'settings', patch: { lookbackDays: 14, calendars: ['primary', 'cal-holiday'] } },
    ]);
    expect(normalizeState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
