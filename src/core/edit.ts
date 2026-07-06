/**
 * WeekReport AST 불변 편집 리듀서 — 비주얼 에디터의 편집 로직 전부를 UI 없이 담당.
 * 모든 함수는 새 WeekReport를 반환하고 원본을 변경하지 않는다.
 * 잘못된 인덱스/무의미한 조작(경계 밖 이동 등)은 원본을 그대로 반환한다.
 */
import type {
  ContentBlock,
  DateRange,
  DayEntry,
  LocationBlock,
  ClientItem,
  WeekReport,
} from './types';
import { getWeekday } from './types';

// ── 경로 헬퍼 ────────────────────────────────────────────────────────────────

// no-op(f가 같은 참조 반환) 시 상위 객체도 원본 참조 유지 — 경계 조작 무시·리렌더 최소화
function withDay(r: WeekReport, di: number, f: (d: DayEntry) => DayEntry): WeekReport {
  if (di < 0 || di >= r.days.length) return r;
  const prev = r.days[di];
  const next = f(prev);
  if (next === prev) return r;
  return { ...r, days: r.days.map((d, i) => (i === di ? next : d)) };
}

function withBlock(
  r: WeekReport,
  di: number,
  bi: number,
  f: (b: LocationBlock) => LocationBlock,
): WeekReport {
  return withDay(r, di, (d) => {
    if (bi < 0 || bi >= d.blocks.length) return d;
    const prev = d.blocks[bi];
    const next = f(prev);
    if (next === prev) return d;
    return { ...d, blocks: d.blocks.map((b, i) => (i === bi ? next : b)) };
  });
}

function withItem(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  f: (it: ClientItem) => ClientItem,
): WeekReport {
  return withBlock(r, di, bi, (b) => {
    if (ii < 0 || ii >= b.items.length) return b;
    const prev = b.items[ii];
    const next = f(prev);
    if (next === prev) return b;
    return { ...b, items: b.items.map((it, i) => (i === ii ? next : it)) };
  });
}

function moveInArray<T>(arr: T[], from: number, dir: -1 | 1): T[] | null {
  const to = from + dir;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return null;
  const next = [...arr];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// ── 헤더 ─────────────────────────────────────────────────────────────────────

export function updateHeader(
  r: WeekReport,
  patch: Partial<Pick<WeekReport, 'prevWeekRange' | 'currentWeekRange' | 'authorName'>>,
): WeekReport {
  return { ...r, ...patch };
}

/** 보고 대상 주(지난 주)의 월요일 ISO로 @PREV(월~일)·@CURRENT(다음주 월~금) 동시 계산 */
export function setWeekByPrevMonday(r: WeekReport, prevMondayIso: string): WeekReport {
  const monday = new Date(`${prevMondayIso}T00:00:00`);
  if (Number.isNaN(monday.getTime())) return r;
  const iso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const add = (base: Date, n: number) => {
    const d = new Date(base);
    d.setDate(base.getDate() + n);
    return d;
  };
  const prev: DateRange = { start: iso(monday), end: iso(add(monday, 6)) };
  const current: DateRange = { start: iso(add(monday, 7)), end: iso(add(monday, 11)) };
  return { ...r, prevWeekRange: prev, currentWeekRange: current };
}

// ── 일자 ─────────────────────────────────────────────────────────────────────

/** 날짜순 위치에 새 일자 삽입 — 중복 날짜·잘못된 날짜는 무시(원본 반환) */
export function addDay(r: WeekReport, date: string): WeekReport {
  let weekday: DayEntry['weekday'];
  try {
    weekday = getWeekday(date);
  } catch {
    return r;
  }
  if (r.days.some((d) => d.date === date)) return r;
  const day: DayEntry = { date, weekday, blocks: [] };
  const days = [...r.days, day].sort((a, b) => a.date.localeCompare(b.date));
  return { ...r, days };
}

export function removeDay(r: WeekReport, di: number): WeekReport {
  if (di < 0 || di >= r.days.length) return r;
  return { ...r, days: r.days.filter((_, i) => i !== di) };
}

/** 휴무 토글 — 켜면 reason '' 시드, 끄면 제거. blocks는 보존(다시 끄면 작업 복원) */
export function toggleHoliday(r: WeekReport, di: number): WeekReport {
  return withDay(r, di, (d) => {
    if (d.holiday) {
      const { holiday: _drop, ...rest } = d;
      return rest;
    }
    return { ...d, holiday: { reason: '' } };
  });
}

export function updateHolidayReason(r: WeekReport, di: number, reason: string): WeekReport {
  return withDay(r, di, (d) => (d.holiday ? { ...d, holiday: { reason } } : d));
}

// ── 장소 블록 ─────────────────────────────────────────────────────────────────

export function addLocationBlock(r: WeekReport, di: number): WeekReport {
  return withDay(r, di, (d) => ({
    ...d,
    blocks: [...d.blocks, { locations: [], customer: '', items: [] }],
  }));
}

/** day에 블록이 없으면 기본 블록 1개 보장 (폼이 항상 편집 대상을 갖도록) */
export function ensureBlock(r: WeekReport, di: number): WeekReport {
  const day = r.days[di];
  if (!day || day.blocks.length > 0) return r;
  return addLocationBlock(r, di);
}

export function removeLocationBlock(r: WeekReport, di: number, bi: number): WeekReport {
  return withDay(r, di, (d) => {
    if (bi < 0 || bi >= d.blocks.length) return d;
    return { ...d, blocks: d.blocks.filter((_, i) => i !== bi) };
  });
}

export function updateBlockFields(
  r: WeekReport,
  di: number,
  bi: number,
  patch: Partial<Pick<LocationBlock, 'locations' | 'customer' | 'inheritLocation'>>,
): WeekReport {
  return withBlock(r, di, bi, (b) => ({ ...b, ...patch }));
}

// ── @SUM 항목 ────────────────────────────────────────────────────────────────

export function addItem(r: WeekReport, di: number, bi: number): WeekReport {
  return withBlock(r, di, bi, (b) => ({
    ...b,
    items: [...b.items, { client: '', workType: '', content: [] }],
  }));
}

export function updateItemFields(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  patch: Partial<Pick<ClientItem, 'client' | 'contact' | 'channel' | 'workType'>>,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    const next = { ...it, ...patch };
    // 빈 문자열 contact/channel은 필드 제거 (serialize가 괄호를 생략하도록)
    if (next.contact !== undefined && !next.contact.trim()) delete next.contact;
    if (next.channel !== undefined && !next.channel.trim()) delete next.channel;
    return next;
  });
}

export function removeItem(r: WeekReport, di: number, bi: number, ii: number): WeekReport {
  return withBlock(r, di, bi, (b) => {
    if (ii < 0 || ii >= b.items.length) return b;
    return { ...b, items: b.items.filter((_, i) => i !== ii) };
  });
}

export function moveItem(r: WeekReport, di: number, bi: number, ii: number, dir: -1 | 1): WeekReport {
  return withBlock(r, di, bi, (b) => {
    const moved = moveInArray(b.items, ii, dir);
    return moved ? { ...b, items: moved } : b;
  });
}

// ── 본문 콘텐츠 블록 ──────────────────────────────────────────────────────────

export function emptyContentBlock(kind: ContentBlock['kind'], numberedIndex = 1): ContentBlock {
  switch (kind) {
    case 'numbered':
      return { kind: 'numbered', index: numberedIndex, title: '', details: [] };
    case 'qa':
      return { kind: 'qa', question: '', answers: [] };
    case 'bullets':
      return { kind: 'bullets', items: [] };
  }
}

export function addContentBlock(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  kind: ContentBlock['kind'],
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    const nextIndex =
      it.content.filter((c): c is Extract<ContentBlock, { kind: 'numbered' }> => c.kind === 'numbered')
        .length + 1;
    return { ...it, content: [...it.content, emptyContentBlock(kind, nextIndex)] };
  });
}

export function updateContentBlock(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  block: ContentBlock,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    if (ci < 0 || ci >= it.content.length) return it;
    return { ...it, content: it.content.map((c, i) => (i === ci ? block : c)) };
  });
}

export function removeContentBlock(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    if (ci < 0 || ci >= it.content.length) return it;
    return { ...it, content: it.content.filter((_, i) => i !== ci) };
  });
}

export function moveContentBlock(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  dir: -1 | 1,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    const moved = moveInArray(it.content, ci, dir);
    return moved ? { ...it, content: moved } : it;
  });
}
