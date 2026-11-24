/**
 * 달력 일정 분류 (설계 §5.4) — 일일 작업일지 루틴이 지난 일정에 쓰는 포함·제외 기준과 같게 둔다.
 * 한쪽을 바꾸면 다른 쪽도 고친다.
 */
import { customerKey } from '../core/customer';
import { site } from '../core/site-config';
import { addDays, localParts } from './dates';
import { eventKey } from './ops';
import type { EventRef, RawEvent } from './types';

export type EventKind = 'meeting' | 'work' | 'leave' | 'holiday' | 'place';

export const KIND_LABEL: Record<EventKind, string> = { meeting: '회의', work: '작업', leave: '휴가', holiday: '공휴일', place: '근무 위치' };

export interface HomeEvent {
  key: string;
  /** 달력 일정이면 그 ID (주간보고 `@PLAN`에서 온 것은 null) */
  ref: EventRef | null;
  title: string;
  kind: EventKind;
  allDay: boolean;
  /** 시작 날짜 */
  date: string;
  /** 마지막 날짜 (포함) */
  endDate: string;
  /** `HH:MM` (종일이면 '') */
  startTime: string;
  endTime: string;
  location: string;
  /** 제목·장소에서 알아본 고객사 (없으면 '') */
  client: string;
  htmlLink: string;
  canWrite: boolean;
  /** 반복 일정의 한 회차 */
  recurring?: boolean;
  source: 'gcal' | 'plan';
}

const LEAVE_RE = /휴가|연차|반차|휴무/;
const MEETING_RE = /회의|미팅|meeting|리뷰|sync/i;
/** 제목이 이 낱말뿐이면 회의가 아니라 근무 위치다 (회사 이름은 떼고 본다) */
const PLACE_WORDS = new Set(['사무실', '오피스', '본사', '출근', '재택', '재택근무']);
const DROP_TYPES = new Set(['birthday', 'fromGmail']);

/** 글에서 아는 고객사 표기를 찾아 표준 표기로 */
export function detectClient(text: string): string {
  const key = customerKey(text);
  return site().customers.find((c) => key.includes(c.key))?.canonical ?? '';
}

function placeOnly(title: string): boolean {
  const s = site();
  let t = title;
  for (const name of [s.company, s.legacyCompany]) if (name) t = t.split(name).join('');
  return PLACE_WORDS.has(t.replace(/\s+/g, ''));
}

export function kindOf(e: Pick<RawEvent, 'summary' | 'eventType' | 'holiday' | 'meet'>): EventKind {
  if (e.holiday) return 'holiday';
  if (LEAVE_RE.test(e.summary) || e.eventType === 'outOfOffice') return 'leave';
  if (e.eventType === 'workingLocation' || placeOnly(e.summary)) return 'place';
  if (e.meet || MEETING_RE.test(e.summary)) return 'meeting';
  return 'work';
}

export interface ClassifyOptions {
  hiddenEvents?: readonly string[];
  hiddenTitles?: readonly string[];
}

/** 달력에서 읽은 일정 → 홈의 일정. 취소·거절·생일·메일에서 생긴 일정·숨긴 일정은 버린다 */
export function classifyEvents(raw: readonly RawEvent[], opts: ClassifyOptions = {}): HomeEvent[] {
  const hidden = new Set(opts.hiddenEvents ?? []);
  const hiddenTitles = new Set((opts.hiddenTitles ?? []).map((t) => t.trim()));
  const out: HomeEvent[] = [];
  for (const e of raw) {
    if (e.status === 'cancelled' || e.declined || DROP_TYPES.has(e.eventType)) continue;
    const ref = { calendarId: e.calendarId, eventId: e.id };
    const title = e.summary.trim() || '(제목 없음)';
    if (hidden.has(eventKey(ref)) || hiddenTitles.has(title)) continue;
    const kind = kindOf(e);
    const start = e.allDay ? { date: e.start, time: '' } : localParts(e.start);
    const end = e.allDay ? { date: addDays(e.end, -1), time: '' } : localParts(e.end);
    out.push({
      key: eventKey(ref),
      ref,
      title,
      kind,
      allDay: e.allDay,
      date: start.date,
      endDate: end.date < start.date ? start.date : end.date,
      startTime: start.time,
      endTime: end.time,
      location: e.location.trim(),
      client: kind === 'meeting' || kind === 'work' ? detectClient(`${e.summary} ${e.location}`) : '',
      htmlLink: e.htmlLink,
      canWrite: e.canWrite && !e.holiday,
      ...(e.recurring ? { recurring: true } : {}),
      source: 'gcal',
    });
  }
  return sortEvents(out);
}

export function sortEvents(list: HomeEvent[]): HomeEvent[] {
  return [...list].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title),
  );
}

/** 그날에 걸친 일정 (여러 날 일정은 날마다) */
export function eventsOn(events: readonly HomeEvent[], date: string): HomeEvent[] {
  return events.filter((e) => e.date <= date && date <= e.endDate);
}

/** 일정 수에 넣는 것 — 회의·작업 (휴가·공휴일·근무 위치는 날 칸의 표시일 뿐이다) */
export function isAgendaEvent(e: HomeEvent): boolean {
  return e.kind === 'meeting' || e.kind === 'work';
}

export interface EventChange {
  key: string;
  title: string;
  /** 한 줄 설명 — `12/1 10:00 → 14:00` · `취소됨` */
  what: string;
}

function whenOf(e: RawEvent): string {
  if (e.allDay) return e.start;
  const p = localParts(e.start);
  return `${p.date} ${p.time}`;
}

/**
 * 사용자가 마지막으로 확인한 때(baseline)와 지금을 견줘 바뀐 일정을 찾는다 — 아직 시작하지 않은 일정만.
 * Claude가 달력 MCP로 옮긴 것, 다른 기기에서 고친 것이 이렇게 드러난다 (설계 §6.8).
 */
export function diffEvents(baseline: readonly RawEvent[] | null, current: readonly RawEvent[], today: string): EventChange[] {
  if (!baseline) return [];
  const now = new Map(current.map((e) => [`${e.calendarId}/${e.id}`, e]));
  const out: EventChange[] = [];
  const short = (w: string) => {
    const [d, t] = w.split(' ');
    const [, m, day] = d.split('-').map(Number);
    return t ? `${m}/${day} ${t}` : `${m}/${day}`;
  };
  for (const old of baseline) {
    const startDate = old.allDay ? old.start : localParts(old.start).date;
    if (startDate < today || old.status === 'cancelled') continue;
    const key = `${old.calendarId}/${old.id}`;
    const cur = now.get(key);
    const title = old.summary.trim() || '(제목 없음)';
    if (!cur || cur.status === 'cancelled') {
      out.push({ key, title, what: `${short(whenOf(old))} 취소됨` });
      continue;
    }
    const parts: string[] = [];
    if (whenOf(old) !== whenOf(cur)) {
      const [a, b] = [whenOf(old), whenOf(cur)];
      // 같은 날이면 시각만 견준다 — `12/1 10:00 → 14:00`
      parts.push(a.slice(0, 10) === b.slice(0, 10) && a.includes(' ') && b.includes(' ') ? `${short(a)} → ${b.split(' ')[1]}` : `${short(a)} → ${short(b)}`);
    }
    if (old.summary.trim() !== cur.summary.trim()) parts.push('제목 바뀜');
    if (old.location.trim() !== cur.location.trim()) parts.push('장소 바뀜');
    if (parts.length) out.push({ key, title: cur.summary.trim() || title, what: parts.join(' · ') });
  }
  return out;
}
