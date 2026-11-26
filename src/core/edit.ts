/**
 * WeekReport AST 불변 편집 리듀서 — 비주얼 에디터의 편집 로직 전부를 UI 없이 담당.
 * 모든 함수는 새 WeekReport를 반환하고 원본을 변경하지 않는다.
 * 잘못된 인덱스/무의미한 조작(경계 밖 이동 등)은 원본을 그대로 반환한다.
 */
import type {
  ContentBlock,
  DateRange,
  DayEntry,
  DialogTurn,
  LocationBlock,
  ClientItem,
  WeekReport,
} from './types';
import { buildingOf, datesInRange, getWeekday, isLeaveBlock, isNoteLine, LEAVE_LOCATION, NOTE_PREFIX, noteText } from './types';
import { isoOf } from '../lib/dates';
import { MAX_INDENT } from './content';
import { clientForRow } from './customer';
import { isBlankBlock } from './blank';

// ── 골격 ─────────────────────────────────────────────────────────────────────

/** 빈 대화 이력 — 1단계, 상대 발화(->)와 내 대응(<-) 한 쌍. Enter로 다음 빈 턴에 이어 쓴다 */
function scaffoldDialog(): ContentBlock {
  return { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }, { kind: 'out', text: '' }] };
}

/** 새 항목의 본문 — 목록(`- 한 일` / `> 상세`) 또는 대화 이력(`->` 상대 / `<-` 대응) */
export type ItemBody = 'bullets' | 'dialog';

/**
 * 행 맥락을 물려받은 빈 항목 — 건물은 지원장소 `MX(누리사옥)`의 건물명.
 * 고객사는 customer.ts의 clientForRow: 행 칸이 고객사면 그 값, 팀·부서(`한강 SRE`)면 그 행에 쓰던 고객사(`AB Z+`).
 */
function scaffoldItem(block?: Pick<LocationBlock, 'customer' | 'locations'>, report?: WeekReport, body: ItemBody = 'dialog'): ClientItem {
  const client = block && report ? clientForRow(report, block) : '';
  const site = block?.locations.map(buildingOf).find(Boolean);
  const content: ContentBlock[] = body === 'bullets' ? [{ kind: 'bullets', items: [''] }] : [scaffoldDialog()];
  return { client, ...(site ? { site } : {}), workType: '', content };
}

/** 빈 행 — 지원장소·고객사 비움, 빈 항목 1개 */
export function scaffoldBlock(): LocationBlock {
  return { locations: [], customer: '', items: [scaffoldItem()] };
}

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

/** 보고 대상 주(지난 주)의 월요일 ISO로 @PREV(월~일)·@CURRENT(다음주 월~금) 동시 계산 */
export function setWeekByPrevMonday(r: WeekReport, prevMondayIso: string): WeekReport {
  const monday = new Date(`${prevMondayIso}T00:00:00`);
  if (Number.isNaN(monday.getTime())) return r;
  const iso = isoOf;
  const add = (base: Date, n: number) => {
    const d = new Date(base);
    d.setDate(base.getDate() + n);
    return d;
  };
  const prev: DateRange = { start: iso(monday), end: iso(add(monday, 6)) };
  // 다음 주 월~일 — □ 일정 예정 범위 (docs §2)
  const current: DateRange = { start: iso(add(monday, 7)), end: iso(add(monday, 13)) };
  return { ...r, prevWeekRange: prev, currentWeekRange: current };
}

// ── 일자 ─────────────────────────────────────────────────────────────────────

/** 날짜순 위치에 새 일자 삽입 — 중복 날짜·잘못된 날짜는 무시(원본 반환) */
/** 토·일 여부 */
export function isWeekend(weekday: DayEntry['weekday']): boolean {
  return weekday === '토' || weekday === '일';
}

/**
 * 날짜순 위치에 새 일자 삽입 — 중복 날짜·잘못된 날짜는 무시(원본 반환).
 * weekendHoliday: 토·일이면 휴일(@HOLIDAY)로 시드 — 주말은 업무가 없어 휴일로 분류한다 (docs §5.6)
 */
export function addDay(
  r: WeekReport,
  date: string,
  opts: { weekendHoliday?: boolean; skeleton?: boolean } = {},
): WeekReport {
  let weekday: DayEntry['weekday'];
  try {
    weekday = getWeekday(date);
  } catch {
    return r;
  }
  if (r.days.some((d) => d.date === date)) return r;
  // skeleton: 평일에 빈 골격 행을 넣어 바로 쓸 수 있게 (새 주간보고와 같은 모양)
  const day: DayEntry =
    opts.weekendHoliday && isWeekend(weekday)
      ? { date, weekday, blocks: [], holiday: { reason: '' } }
      : { date, weekday, blocks: opts.skeleton ? [scaffoldBlock()] : [] };
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

/** 반차(부분 근태) 토글 — 켜면 기본 라벨 시드, 끄면 제거. blocks는 그대로 보존 */
export function toggleHalfday(r: WeekReport, di: number): WeekReport {
  return withDay(r, di, (d) => {
    if (d.partial) {
      const { partial: _drop, ...rest } = d;
      return rest;
    }
    return { ...d, partial: { label: '오후 반차' } };
  });
}

export function updateHalfdayLabel(r: WeekReport, di: number, label: string): WeekReport {
  return withDay(r, di, (d) => (d.partial ? { ...d, partial: { label } } : d));
}

// ── 장소 블록 ─────────────────────────────────────────────────────────────────

/** 행 추가 — 빈 항목 1개를 품은 빈 행 (항목 추가를 한 번 더 누르지 않게) */
export function addLocationBlock(r: WeekReport, di: number): WeekReport {
  return withDay(r, di, (d) => ({
    ...d,
    blocks: [...d.blocks, scaffoldBlock()],
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

/**
 * 항목 추가 — 행의 고객사·건물을 물려받고 고른 본문을 시드한다.
 * 목록(`- 한 일` + `> 상세`)이 사용자 보고서의 주된 모양이고, 대화 이력은 문의 ↔ 회신이 핵심인 건에 쓴다(2026-11-16).
 */
export function addItem(r: WeekReport, di: number, bi: number, body: ItemBody = 'dialog'): WeekReport {
  return withBlock(r, di, bi, (b) => ({
    ...b,
    items: [...b.items, scaffoldItem(b, r, body)],
  }));
}

/**
 * 행의 고객사|작업구분을 쓰고 나면(입력칸을 벗어날 때) 빈 항목의 고객사를 채운다 (채울 값은 clientForRow).
 * 비어 있는 칸만 채우므로 사용자가 다르게 쓴 값은 건드리지 않는다.
 */
export function fillItemClientsFromRow(r: WeekReport, di: number, bi: number): WeekReport {
  return withBlock(r, di, bi, (b) => {
    const c = clientForRow(r, b);
    if (!c || !b.items.some((it) => !it.client.trim())) return b;
    return { ...b, items: b.items.map((it) => (it.client.trim() ? it : { ...it, client: c })) };
  });
}

/** 지원장소를 쓰고 나면 건물이 빈 항목에 지원장소의 건물명을 채운다 (`MX(누리사옥)` → 누리사옥) */
export function fillItemSitesFromRow(r: WeekReport, di: number, bi: number): WeekReport {
  return withBlock(r, di, bi, (b) => {
    const site = b.locations.map(buildingOf).find(Boolean);
    if (!site || !b.items.some((it) => !it.site)) return b;
    return { ...b, items: b.items.map((it) => (it.site ? it : { ...it, site })) };
  });
}

/** 항목의 고객사를 쓰고 나면 행의 고객사|작업구분이 비어 있을 때 같은 값으로 채운다 */
export function fillRowCustomerFromItem(r: WeekReport, di: number, bi: number, ii: number): WeekReport {
  return withBlock(r, di, bi, (b) => {
    const c = b.items[ii]?.client.trim();
    if (!c || b.customer.trim()) return b;
    return { ...b, customer: c };
  });
}

export function updateItemFields(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  patch: Partial<Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>>,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    const next = { ...it, ...patch };
    // 빈 문자열 site/contact/channel은 필드 제거 (serialize가 괄호를 생략하도록)
    if (next.site !== undefined && !next.site.trim()) delete next.site;
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
    case 'dialog':
      // 대화 이력은 항목 머리 아래 1단계(2칸) — docs §4.3. 상대방 발화(->)부터, 먼저 요청한 건은 턴 종류를 바꿔 쓴다
      return { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }] };
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

/** 본문 블록 들여쓰기 단계 설정 (0~MAX_INDENT). 0이면 indent 필드 제거 */
export function setContentIndent(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  indent: number,
): WeekReport {
  const level = Math.max(0, Math.min(MAX_INDENT, Math.round(indent)));
  return withItem(r, di, bi, ii, (it) => {
    const cur = it.content[ci];
    if (!cur || (cur.indent ?? 0) === level) return it;
    const { indent: _drop, ...rest } = cur;
    const next = (level > 0 ? { ...rest, indent: level } : rest) as ContentBlock;
    return { ...it, content: it.content.map((c, i) => (i === ci ? next : c)) };
  });
}

// ── 대화 이력 턴 ─────────────────────────────────────────────────────────────

/** 대화 블록의 턴 목록 교체 헬퍼 */
function withTurns(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  f: (turns: DialogTurn[]) => DialogTurn[] | null,
): WeekReport {
  return withItem(r, di, bi, ii, (it) => {
    const cur = it.content[ci];
    if (!cur || cur.kind !== 'dialog') return it;
    const turns = f(cur.turns);
    if (!turns) return it;
    return { ...it, content: it.content.map((c, i) => (i === ci ? { ...cur, turns } : c)) };
  });
}

/** 턴 삽입 — at 위치(기본 끝)에. 빈 텍스트로 시드 */
export function addTurn(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  turn: DialogTurn,
  at?: number,
): WeekReport {
  return withTurns(r, di, bi, ii, ci, (turns) => {
    const pos = at === undefined ? turns.length : Math.max(0, Math.min(turns.length, at));
    return [...turns.slice(0, pos), turn, ...turns.slice(pos)];
  });
}

export function updateTurn(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  ti: number,
  patch: Partial<DialogTurn>,
): WeekReport {
  return withTurns(r, di, bi, ii, ci, (turns) => {
    if (ti < 0 || ti >= turns.length) return null;
    return turns.map((t, i) => {
      if (i !== ti) return t;
      const next = { ...t, ...patch };
      // 미결 표시는 대응(out)·발화(in)에만 — 결론·노트로 바뀌면 제거
      if (!next.pending || next.kind === 'conclusion' || next.kind === 'note') delete next.pending;
      return next;
    });
  });
}

// ── 대화 턴 ↔ 목록 줄 바꾸기 ─────────────────────────────────────────────────
// 한 블록 안에는 한 종류만 들어가므로, 줄 하나의 종류를 바꾸면 블록을 그 자리에서 나눈다.
// 바뀐 줄에 딸린 노트(`>`)는 함께 옮기고(.md에서는 같은 `> ` 줄), 나뉜 앞뒤가 빈 골격뿐이면 버린다.
// 바로 옆 블록이 같은 종류·같은 들여쓰기면 합친다 — 목록 줄 아래에서 `- `를 치면 그 목록이 이어지게.

/** 바꾼 뒤 포커스할 자리 — 본문 블록 번호와 그 안의 줄(턴) 번호 */
export interface ContentAt {
  ci: number;
  index: number;
}

const filled = (s: string) => !!s.trim();

function withIndentLevel<T extends ContentBlock>(block: T, level: number): T {
  const { indent: _drop, ...rest } = block;
  return (level > 0 ? { ...rest, indent: Math.min(MAX_INDENT, level) } : rest) as T;
}

/** 본문 배열의 ci 자리를 pieces로 바꾸고, 새 블록(pieces[mid])을 같은 종류의 이웃과 합친다 */
function spliceAndMerge(
  content: readonly ContentBlock[],
  ci: number,
  pieces: ContentBlock[],
  mid: number,
  start: number,
): { content: ContentBlock[]; at: ContentAt } {
  const out = [...content.slice(0, ci), ...pieces, ...content.slice(ci + 1)];
  let at = ci + mid;
  let index = start;
  const same = (a: ContentBlock | undefined, b: ContentBlock) =>
    !!a && a.kind === b.kind && (a.indent ?? 0) === (b.indent ?? 0) && (a.kind === 'bullets' || a.kind === 'dialog');
  const prev = out[at - 1];
  const cur = out[at];
  if (same(prev, cur)) {
    const merged =
      cur.kind === 'bullets'
        ? { ...(prev as Extract<ContentBlock, { kind: 'bullets' }>), items: [...(prev as Extract<ContentBlock, { kind: 'bullets' }>).items, ...cur.items] }
        : { ...(prev as Extract<ContentBlock, { kind: 'dialog' }>), turns: [...(prev as Extract<ContentBlock, { kind: 'dialog' }>).turns, ...(cur as Extract<ContentBlock, { kind: 'dialog' }>).turns] };
    index += cur.kind === 'bullets' ? (prev as Extract<ContentBlock, { kind: 'bullets' }>).items.length : (prev as Extract<ContentBlock, { kind: 'dialog' }>).turns.length;
    out.splice(at - 1, 2, merged);
    at -= 1;
  }
  const now = out[at];
  const next = out[at + 1];
  if (same(next, now)) {
    const merged =
      now.kind === 'bullets'
        ? { ...now, items: [...now.items, ...(next as Extract<ContentBlock, { kind: 'bullets' }>).items] }
        : { ...now, turns: [...(now as Extract<ContentBlock, { kind: 'dialog' }>).turns, ...(next as Extract<ContentBlock, { kind: 'dialog' }>).turns] };
    out.splice(at, 2, merged as ContentBlock);
  }
  return { content: out, at: { ci: at, index } };
}

/**
 * 대화 턴 → 목록 줄. lines는 목록 줄들(노트는 `> ` 접두) — 턴에 딸린 노트 턴은 노트 줄로 따라온다.
 * 목록은 대화보다 한 단계 바깥(대화 이력은 머리 아래 1단계, 목록은 0단계가 기본 모양).
 */
export function turnToListInContent(
  content: readonly ContentBlock[],
  ci: number,
  ti: number,
  lines: readonly string[],
): { content: ContentBlock[]; at: ContentAt } | null {
  const block = content[ci];
  if (!block || block.kind !== 'dialog' || ti < 0 || ti >= block.turns.length) return null;
  let end = ti + 1;
  while (end < block.turns.length && block.turns[end].kind === 'note') end++;
  const notes = block.turns
    .slice(ti + 1, end)
    .flatMap((t) => t.text.split('\n').filter(filled).map((l) => `${NOTE_PREFIX}${l.trim()}`));
  const before = block.turns.slice(0, ti);
  const after = block.turns.slice(end);
  const keep = (turns: DialogTurn[]) => (turns.some((t) => filled(t.text)) ? turns : []);
  const items = [...(lines.length ? lines : ['']), ...notes];
  const list = withIndentLevel<ContentBlock>({ kind: 'bullets', items }, (block.indent ?? 0) - 1);
  const pieces: ContentBlock[] = [];
  if (keep(before).length) pieces.push({ ...block, turns: before });
  const mid = pieces.length;
  pieces.push(list);
  if (keep(after).length) pieces.push({ ...block, turns: after });
  return spliceAndMerge(content, ci, pieces, mid, 0);
}

/** 목록 줄 → 대화 턴. 그 줄에 딸린 노트 줄은 노트 턴으로 따라온다. 대화는 목록보다 한 단계 안쪽 */
export function listLineToTurnInContent(
  content: readonly ContentBlock[],
  ci: number,
  li: number,
  turns: readonly DialogTurn[],
): { content: ContentBlock[]; at: ContentAt } | null {
  const block = content[ci];
  if (!block || block.kind !== 'bullets' || li < 0 || li >= Math.max(1, block.items.length) || turns.length === 0) return null;
  const items = block.items.length ? block.items : [''];
  let end = li + 1;
  while (end < items.length && isNoteLine(items[end])) end++;
  const notes: DialogTurn[] = items.slice(li + 1, end).map((s) => ({ kind: 'note', text: noteText(s) }));
  const before = items.slice(0, li);
  const after = items.slice(end);
  const dialog = withIndentLevel<ContentBlock>({ kind: 'dialog', turns: [...turns, ...notes] }, (block.indent ?? 0) + 1);
  const pieces: ContentBlock[] = [];
  if (before.some(filled)) pieces.push({ ...block, items: before });
  const mid = pieces.length;
  pieces.push(dialog);
  if (after.some(filled)) pieces.push({ ...block, items: after });
  return spliceAndMerge(content, ci, pieces, mid, 0);
}

/** 대화 턴 하나를 목록 줄로 — 턴 표지 메뉴의 [목록 줄], 턴 줄 앞에 `- ` 입력 */
export function convertTurnToList(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  ti: number,
  lines: readonly string[],
): { report: WeekReport; at: ContentAt | null } {
  let at: ContentAt | null = null;
  const report = withItem(r, di, bi, ii, (it) => {
    const res = turnToListInContent(it.content, ci, ti, lines);
    if (!res) return it;
    at = res.at;
    return { ...it, content: res.content };
  });
  return { report, at };
}

/** 목록 줄 하나를 대화 턴으로 — 줄 표지 메뉴의 [상대 발화]·[내 대응], 목록 줄 앞에 `-> `·`<- ` 입력 */
export function convertListLineToTurn(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  li: number,
  turns: readonly DialogTurn[],
): { report: WeekReport; at: ContentAt | null } {
  let at: ContentAt | null = null;
  const report = withItem(r, di, bi, ii, (it) => {
    const res = listLineToTurnInContent(it.content, ci, li, turns);
    if (!res) return it;
    at = res.at;
    return { ...it, content: res.content };
  });
  return { report, at };
}

/** 턴 하나를 여러 턴으로 교체 — 입력칸에 마커를 치거나 여러 줄을 붙여넣어 턴이 나뉠 때 */
export function replaceTurn(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  ti: number,
  replacement: DialogTurn[],
): WeekReport {
  return withTurns(r, di, bi, ii, ci, (turns) =>
    ti < 0 || ti >= turns.length || replacement.length === 0
      ? null
      : [...turns.slice(0, ti), ...replacement, ...turns.slice(ti + 1)],
  );
}

export function removeTurn(r: WeekReport, di: number, bi: number, ii: number, ci: number, ti: number): WeekReport {
  return withTurns(r, di, bi, ii, ci, (turns) => (ti < 0 || ti >= turns.length ? null : turns.filter((_, i) => i !== ti)));
}

export function moveTurn(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  ci: number,
  ti: number,
  dir: -1 | 1,
): WeekReport {
  return withTurns(r, di, bi, ii, ci, (turns) => moveInArray(turns, ti, dir));
}

// ── 히스토리: 다른 날로 이어쓰기 ─────────────────────────────────────────────

/**
 * 항목을 대상 일자에 배치 — 같은 지원장소·고객사 행이 있으면 그 행 끝에, 아직 쓰지 않은 골격 행이 있으면
 * 그 자리를 채우고, 둘 다 없으면 새 행으로. 대상 일자가 없으면 추가한다(날짜순). 휴일에는 배치하지 않는다.
 * 새 항목 위치를 함께 반환해 UI가 스크롤·포커스를 옮길 수 있다.
 */
export function placeItem(
  r: WeekReport,
  targetDate: string,
  row: Pick<LocationBlock, 'locations' | 'customer'>,
  item: ClientItem,
): { report: WeekReport; at?: { di: number; bi: number; ii: number } } {
  let next = r.days.some((d) => d.date === targetDate) ? r : addDay(r, targetDate);
  const tdi = next.days.findIndex((d) => d.date === targetDate);
  if (tdi < 0) return { report: r };
  const target = next.days[tdi];
  if (target.holiday) return { report: r };

  const locKey = row.locations.join(' / ');
  const same = target.blocks.findIndex((b) => b.locations.join(' / ') === locKey && b.customer === row.customer);
  if (same >= 0) {
    next = withBlock(next, tdi, same, (b) => ({ ...b, items: [...b.items, item] }));
    return { report: next, at: { di: tdi, bi: same, ii: next.days[tdi].blocks[same].items.length - 1 } };
  }
  const block: LocationBlock = { locations: [...row.locations], customer: row.customer, items: [item] };
  const scaffold = target.blocks.findIndex(isBlankBlock);
  if (scaffold >= 0) {
    // 골격 행을 그대로 두면 이어 쓴 항목 위에 빈 행이 남는다 — 그 자리를 채운다
    next = withDay(next, tdi, (d) => ({ ...d, blocks: d.blocks.map((b, i) => (i === scaffold ? block : b)) }));
    return { report: next, at: { di: tdi, bi: scaffold, ii: 0 } };
  }
  next = withDay(next, tdi, (d) => ({ ...d, blocks: [...d.blocks, block] }));
  return { report: next, at: { di: tdi, bi: next.days[tdi].blocks.length - 1, ii: 0 } };
}

/** 항목 머리만 복사한 새 항목 (본문은 빈 대화 이력) — 이어쓰기에 쓴다 */
export function continuationOf(src: Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>): ClientItem {
  return {
    client: src.client,
    ...(src.site ? { site: src.site } : {}),
    ...(src.contact ? { contact: src.contact } : {}),
    ...(src.channel ? { channel: src.channel } : {}),
    workType: src.workType,
    content: [scaffoldDialog()],
  };
}

/**
 * 며칠에 걸친 건의 경과를 이어 쓰기 — 항목 머리(고객사·건물·담당자·채널·제목)를 대상 일자로 복사하고
 * 빈 대화 이력을 시드한다. 배치 규칙은 placeItem.
 */
export function continueItem(
  r: WeekReport,
  di: number,
  bi: number,
  ii: number,
  targetDate: string,
): { report: WeekReport; at?: { di: number; bi: number; ii: number } } {
  const src = r.days[di]?.blocks[bi]?.items[ii];
  const srcBlock = r.days[di]?.blocks[bi];
  if (!src || !srcBlock) return { report: r };
  return placeItem(r, targetDate, srcBlock, continuationOf(src));
}

// ── 근태·일자 ────────────────────────────────────────────────────────────────

/**
 * 휴가 토글 — 켜면 맨 앞에 `@LOC 휴가` 빈 행을 넣고, 끄면 항목 없는 휴가 행을 제거.
 * 휴가 중 대응(휴가 행에 고객사·항목이 있는 경우)은 지우지 않는다.
 */
export function toggleLeave(r: WeekReport, di: number): WeekReport {
  return withDay(r, di, (d) => {
    const hasEmptyLeave = d.blocks.some((b) => isLeaveBlock(b) && b.items.length === 0 && !b.customer);
    if (hasEmptyLeave) {
      return { ...d, blocks: d.blocks.filter((b) => !(isLeaveBlock(b) && b.items.length === 0 && !b.customer)) };
    }
    const leave: LocationBlock = { locations: [LEAVE_LOCATION], customer: '', items: [] };
    return { ...d, blocks: [leave, ...d.blocks] };
  });
}

export function isOnLeave(d: DayEntry): boolean {
  return d.blocks.some((b) => isLeaveBlock(b));
}

/** 보고 주(@PREV) 안에서 빠진 일자 목록 */
export function missingDates(r: WeekReport): string[] {
  const all = datesInRange(r.prevWeekRange);
  if (all.length === 0 || all.length > 14) return [];
  const have = new Set(r.days.map((d) => d.date));
  return all.filter((d) => !have.has(d));
}

/** 빠진 일자를 모두 추가 (날짜순) — 평일은 빈 골격 행, 토·일은 휴일 */
export function fillMissingDays(r: WeekReport): WeekReport {
  return missingDates(r).reduce((acc, date) => addDay(acc, date, { weekendHoliday: true, skeleton: true }), r);
}

