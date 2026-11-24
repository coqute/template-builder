/** 홈 화면의 묶음·정렬·요약 — 순수 함수 (설계 §4.4) */
import { anchorGroupKey } from './anchor';
import { eventsOn, isAgendaEvent, type HomeEvent } from './classify';
import { addDays, diffDays, mondayOf } from './dates';
import type { Candidate, WorklogScan } from './sources/worklog';
import type { PlannerState, Task } from './types';

export type Bucket = 'late' | 'today' | 'week' | 'later' | 'none';

export const BUCKETS: ReadonlyArray<{ id: Bucket; label: string }> = [
  { id: 'late', label: '기한 지남' },
  { id: 'today', label: '오늘' },
  { id: 'week', label: '이번 주' },
  { id: 'later', label: '다음 주 이후' },
  { id: 'none', label: '기한 없음' },
];

/** 기다린 지 이만큼 넘으면 굵게 (재촉 신호) */
export const WAIT_NUDGE_DAYS = 7;

export function bucketOf(task: Pick<Task, 'due'>, today: string): Bucket {
  if (!task.due) return 'none';
  if (task.due < today) return 'late';
  if (task.due === today) return 'today';
  return task.due <= addDays(mondayOf(today), 6) ? 'week' : 'later';
}

const byDue = (a: Task, b: Task) => (a.due ?? '').localeCompare(b.due ?? '') || a.createdAt.localeCompare(b.createdAt);

export interface TaskGroups {
  buckets: Record<Bucket, Task[]>;
  waiting: Task[];
  done: Task[];
}

export function groupTasks(tasks: readonly Task[], today: string): TaskGroups {
  const buckets: Record<Bucket, Task[]> = { late: [], today: [], week: [], later: [], none: [] };
  const waiting: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.doneAt) done.push(t);
    else if (t.state === 'waiting') waiting.push(t);
    else buckets[bucketOf(t, today)].push(t);
  }
  for (const k of Object.keys(buckets) as Bucket[]) buckets[k].sort(byDue);
  waiting.sort((a, b) => (a.waitingSince ?? a.createdAt).localeCompare(b.waitingSince ?? b.createdAt));
  done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return { buckets, waiting, done };
}

/** 기다린 날 수 */
export function waitingDays(task: Pick<Task, 'waitingSince' | 'createdAt'>, today: string): number {
  const since = task.waitingSince ?? task.createdAt.slice(0, 10);
  return Math.max(0, diffDays(since, today));
}

/**
 * 화면에 낼 후보 — 무시한 것, 이미 할 일로 올린 사안(같은 폴더·사안 키), 일지에서 닫힌 사안은 뺀다.
 */
export function visibleCandidates(candidates: readonly Candidate[], state: Pick<PlannerState, 'tasks' | 'hiddenCandidates'>): Candidate[] {
  const hidden = new Set(state.hiddenCandidates);
  const taken = new Set<string>();
  for (const t of state.tasks) if (t.origin.kind === 'worklog') taken.add(anchorGroupKey(t.origin.anchor));
  return candidates.filter((c) => !hidden.has(c.key) && !(c.anchor && taken.has(anchorGroupKey(c.anchor))));
}

/** 일지에 닫힘 기록이 생긴 할 일 — "끝냄으로?" 제안 대상. 값은 닫힌 날 */
export function closedInWorklog(tasks: readonly Task[], scan: Pick<WorklogScan, 'closed'> | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!scan) return out;
  for (const t of tasks) {
    if (t.doneAt || t.origin.kind !== 'worklog') continue;
    const date = scan.closed.get(anchorGroupKey(t.origin.anchor));
    // 할 일이 가리키는 기록보다 뒤(같은 날 포함)에 닫힌 것만
    if (date && date >= t.origin.anchor.date) out.set(t.id, date);
  }
  return out;
}

export interface StripDay {
  date: string;
  /** 지난 날 */
  past: boolean;
  today: boolean;
  weekend: boolean;
  /** 근무 위치 (작게) */
  place: string;
  /** 휴가·공휴일 이름 (빨간 줄) — 반차처럼 시각이 있는 휴가는 시각과 함께 */
  off: string;
  /** 시각이 있는 휴가(반차)다 — 빨간 줄은 긋되 그날 전체를 쉬는 날로 칠하지 않는다 */
  offPart: boolean;
  /** 내 회의·작업 */
  events: HomeEvent[];
  /** 남의 달력의 일정 (동료의 휴가·현장 일정) — 옅게 */
  others: HomeEvent[];
  /** 그날이 기한인 열린 할 일 수 */
  due: number;
  /** 오늘 칸에만 — 기한 지난 할 일 수 */
  late: number;
}

/** 이번 주 월요일부터 2주 */
export function buildStrip(today: string, events: readonly HomeEvent[], open: readonly Task[]): StripDay[][] {
  const start = mondayOf(today);
  const late = open.filter((t) => t.due && t.due < today).length;
  const week = (from: string): StripDay[] =>
    Array.from({ length: 7 }, (_, i) => {
      const date = addDays(from, i);
      const all = eventsOn(events, date);
      const day = all.filter((e) => !e.other);
      const off = day.find((e) => e.kind === 'holiday') ?? day.find((e) => e.kind === 'leave' && e.allDay) ?? day.find((e) => e.kind === 'leave');
      const part = !!off && off.kind === 'leave' && !off.allDay;
      return {
        date,
        past: date < today,
        today: date === today,
        weekend: i > 4,
        place: day.find((e) => e.kind === 'place')?.title ?? '',
        off: off ? (off.kind === 'holiday' ? off.title : off.allDay ? '휴가' : `${off.startTime} ${off.title}`.trim()) : '',
        offPart: part,
        events: day.filter(isAgendaEvent),
        others: all.filter((e) => e.other && e.kind !== 'place' && e.kind !== 'holiday'),
        due: open.filter((t) => t.due === date).length,
        late: date === today ? late : 0,
      };
    });
  return [week(start), week(addDays(start, 7))];
}

export interface Summary {
  late: number;
  today: number;
  week: number;
  weekEvents: number;
  waiting: number;
  /** 오늘 남은 회의·작업 수 */
  todayEvents: number;
  /** 다음 회의·작업 (오늘 이후 가장 가까운 것) */
  next: HomeEvent | null;
}

export function summarize(today: string, groups: TaskGroups, events: readonly HomeEvent[]): Summary {
  const agenda = events.filter((e) => isAgendaEvent(e) && e.endDate >= today);
  const sunday = addDays(mondayOf(today), 6);
  return {
    late: groups.buckets.late.length,
    today: groups.buckets.today.length,
    week: groups.buckets.week.length,
    weekEvents: agenda.filter((e) => e.date <= sunday).length,
    waiting: groups.waiting.length,
    todayEvents: agenda.filter((e) => e.date <= today).length,
    next: agenda[0] ?? null,
  };
}

/** 확정 일정 목록 — 오늘부터 2주 끝까지, 근무 위치는 뺀다. 날짜별 묶음 */
export function agendaDays(today: string, events: readonly HomeEvent[]): Array<{ date: string; events: HomeEvent[] }> {
  const end = addDays(mondayOf(today), 13);
  const out: Array<{ date: string; events: HomeEvent[] }> = [];
  for (const e of events) {
    if (e.other || e.kind === 'place' || e.endDate < today || e.date > end) continue;
    const date = e.date < today ? today : e.date;
    const last = out[out.length - 1];
    if (last && last.date === date) last.events.push(e);
    else out.push({ date, events: [e] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 지난 7일의 회의·작업 — [일지에 회의 블록으로] 대상 (설계 §6.7 ②) */
export function recentPastEvents(today: string, events: readonly HomeEvent[]): HomeEvent[] {
  const from = addDays(today, -7);
  return events.filter((e) => isAgendaEvent(e) && e.endDate < today && e.date >= from).reverse();
}
