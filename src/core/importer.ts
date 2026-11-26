import type { ClientItem, DateRange, DayEntry, LocationBlock, PlanEntry, WeekReport } from './types';
import { isoOf } from '../lib/dates';
import { appendContentLine, appendPlainText, indentLevel, matchContentLine, type ContentCursor } from './content';
import { parseItemHeader } from './item-header';

export interface ImportInput {
  html?: string;
  plain?: string;
  /** 가져온 보고서의 작성자명 (HTML에는 없음) — 호출부가 프로필 이름 주입 */
  defaultAuthor?: string;
}

export interface ImportResult {
  report: WeekReport;
  warnings: string[];
}

/** 날짜 조각 — `2026.05.11`(v1) · `2026. 05. 11`(v2) 모두 인식 */
const DOT_DATE = String.raw`(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?`;
const RE_HEADER_DATE = new RegExp(String.raw`□\s*Date\s*:\s*${DOT_DATE}\s*~\s*${DOT_DATE}`);
const RE_PLAN_HEADER = new RegExp(String.raw`□\s*일정\s*예정\s*\(\s*${DOT_DATE}\s*~\s*${DOT_DATE}\s*\)`);
const RE_DAY_LABEL = /(\d{4})-(\d{2})-(\d{2})\s*\(([월화수목금토일])\)/;
const RE_DAY_DOT = /(\d{4})\.(\d{2})\.(\d{2})\s*\(([월화수목금토일])\)/;

/** 본문 셀 한 줄 — 들여쓰기 단계는 margin-left(px÷16) 또는 줄 앞 공백에서 */
interface CellLine {
  text: string;
  indent: number;
}

export function importFromInput(input: ImportInput): ImportResult {
  if (input.html && input.html.trim().length > 0) {
    return importFromHtml(input.html, input.defaultAuthor);
  }
  if (input.plain && input.plain.trim().length > 0) {
    return importFromPlain(input.plain, input.defaultAuthor);
  }
  throw new Error('가져올 본문이 비어 있습니다 (HTML/plain 모두 없음).');
}

export function importFromHtml(html: string, defaultAuthor = '작성자'): ImportResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = (doc.body?.textContent ?? '').replace(/ /g, ' ');
  // 본문 □ Date 헤더는 보고 대상 주 — 합본 메일이면 첫 섹션(최근 주)
  const headerRange = extractRange(fullText, RE_HEADER_DATE);

  const tables = Array.from(doc.querySelectorAll('table'));
  const reportTable = pickReportTable(tables);
  if (!reportTable) {
    warnings.push('보고서 표를 찾지 못해 plain text 경로로 폴백합니다.');
    // 폴백 결과에 표 미발견 경고를 합치고 작성자 주입을 유지 — 호출부가 경고 수로 품질을 판단한다
    const fb = importFromPlain(fullText, defaultAuthor);
    return { report: fb.report, warnings: [...warnings, ...fb.warnings] };
  }

  const days = parseHtmlTable(reportTable, warnings);
  const inferredPrev = inferWeekRangeFromDays(days);
  const prevWeekRange = headerRange ?? inferredPrev ?? defaultPrevWeekRange();
  if (!headerRange && !inferredPrev) {
    warnings.push('"□ Date" 헤더와 일자 행을 모두 찾지 못해 @PREV를 추정했습니다.');
  }
  const currentWeekRange = extractRange(fullText, RE_PLAN_HEADER) ?? nextWeekFrom(prevWeekRange);
  const plans = parseHtmlPlans(tables, reportTable, tables.indexOf(reportTable));

  return { report: buildReport(prevWeekRange, currentWeekRange, defaultAuthor, days, plans), warnings };
}

export function importFromPlain(text: string, defaultAuthor = '작성자'): ImportResult {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/ /g, ' ');
  const headerRange = extractRange(normalized, RE_HEADER_DATE);

  const { days, plans } = parsePlainBody(normalized, warnings);
  const inferredPrev = inferWeekRangeFromDays(days);
  const prevWeekRange = headerRange ?? inferredPrev ?? defaultPrevWeekRange();
  if (!headerRange && !inferredPrev) {
    warnings.push('"□ Date" 헤더와 일자 행을 모두 찾지 못해 @PREV를 추정했습니다.');
  }
  const currentWeekRange = extractRange(normalized, RE_PLAN_HEADER) ?? nextWeekFrom(prevWeekRange);

  return { report: buildReport(prevWeekRange, currentWeekRange, defaultAuthor, days, plans), warnings };
}

function buildReport(
  prevWeekRange: DateRange,
  currentWeekRange: DateRange,
  authorName: string,
  days: DayEntry[],
  plans: PlanEntry[],
): WeekReport {
  const report: WeekReport = { prevWeekRange, currentWeekRange, authorName, days };
  if (plans.length > 0) report.plans = plans;
  return report;
}

function pickReportTable(tables: HTMLTableElement[]): HTMLTableElement | null {
  for (const t of tables) {
    const cells = Array.from(t.querySelectorAll('th,td')).slice(0, 8);
    const sample = cells.map((c) => (c.textContent ?? '').trim()).join('|');
    if (/일자/.test(sample) && /지원장소/.test(sample) && /고객사/.test(sample)) {
      return t;
    }
  }
  return tables[0] ?? null;
}

function dayFromLabel(label: string): { date: string; weekday: DayEntry['weekday']; rest: string } | null {
  const m = label.match(RE_DAY_LABEL) ?? label.match(RE_DAY_DOT);
  if (!m) return null;
  const rest = label
    .slice(label.indexOf(m[0]) + m[0].length)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
  return { date: `${m[1]}-${m[2]}-${m[3]}`, weekday: m[4] as DayEntry['weekday'], rest };
}

function parseHtmlTable(table: HTMLTableElement, warnings: string[]): DayEntry[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  const dataRows = rows.filter((r) => {
    const text = (r.textContent ?? '').trim();
    if (!text) return false;
    if (/^일자/.test(text) && /지원장소/.test(text)) return false;
    return true;
  });

  const days: DayEntry[] = [];
  let currentDay: DayEntry | undefined;

  for (const row of dataRows) {
    const cellEls = Array.from(row.querySelectorAll('th,td'));
    if (cellEls.length === 0) continue;
    const cells = cellEls.map((c) => cellText(c));

    const offsetForDate = cells.length >= 5 ? 0 : 1;
    const dateLabel = offsetForDate === 0 ? cells[0] : '';
    const locationCell = cells[cells.length - 4] ?? '';
    const clientCell = cells[cells.length - 3] ?? '';
    const contentEl = cellEls[cellEls.length - 2];
    const contentCell = cells[cells.length - 2] ?? '';

    if (dateLabel) {
      const parsed = dayFromLabel(dateLabel);
      if (parsed) {
        currentDay = { date: parsed.date, weekday: parsed.weekday, blocks: [] };
        days.push(currentDay);
        // 휴무 행 복원 — 빨간 배경(#FFCCCC)으로 휴무 여부를, 내용 셀 텍스트로 사유를 복원
        const rowHtml = (row as HTMLElement).outerHTML ?? '';
        if (/ffcccc/i.test(rowHtml)) {
          currentDay.holiday = { reason: contentCell.trim() };
          continue;
        }
        // 반차(@HALFDAY) 복원 — 날짜 셀에서 일자 라벨 뒤 잔여 텍스트를 라벨로
        if (parsed.rest) currentDay.partial = { label: parsed.rest };
      } else if (dateLabel.trim()) {
        warnings.push(`인식할 수 없는 일자 라벨: ${dateLabel.slice(0, 40)}`);
      }
    }

    if (!currentDay) continue;

    const lines = contentEl ? cellLines(contentEl) : [];
    const block = buildBlock(locationCell, clientCell, lines, warnings);
    if (block) {
      // 같은 지원장소 아래 둘째 고객사 행 — 렌더는 장소 칸을 위 행의 rowspan에 합쳐 이 행에 셀이 3개뿐이다.
      // 장소를 비워 두면 가져온 보고서의 그 행이 빈 @LOC가 되어 "지원장소가 비어 있습니다" 경고가 나고 표 모양도 달라진다
      const above = currentDay.blocks[currentDay.blocks.length - 1];
      if (cells.length === 3 && above && block.locations.length === 0) {
        block.locations = above.locations;
        block.inheritLocation = true;
      }
      currentDay.blocks.push(block);
    }
  }

  return days;
}

/** 일정 예정 표 — 보고 표 뒤의 2열 표에서 `일자 | 일정` 행 (한 칸에 여러 줄이면 일정 여러 개) */
function parseHtmlPlans(tables: HTMLTableElement[], reportTable: HTMLTableElement, reportIdx: number): PlanEntry[] {
  const plans: PlanEntry[] = [];
  // 합본 메일은 최근 주 섹션의 보고 표 바로 다음 표만 일정 예정 후보
  const next = tables[reportIdx + 1];
  if (!next || next === reportTable) return plans;
  for (const row of Array.from(next.querySelectorAll('tr'))) {
    const cells = Array.from(row.querySelectorAll('th,td')).map((c) => cellText(c));
    if (cells.length !== 2) return plans; // 2열 표가 아니면 일정 예정 표가 아님
    const parsed = dayFromLabel(cells[0]);
    if (!parsed) continue;
    for (const text of cells[1].split('\n').map((s) => s.trim()).filter(Boolean)) {
      plans.push({ date: parsed.date, text });
    }
  }
  return plans;
}

function cellText(cell: Element): string {
  const html = (cell as HTMLElement).innerHTML ?? '';
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE']);

/**
 * 본문 셀 → 줄 목록. 블록 요소·<br>에서 줄을 나누고, 들여쓰기는
 * 앱 렌더 결과의 margin-left(16px = 1단계)와 Outlook 등 원문의 줄 앞 공백 중 큰 쪽을 쓴다.
 */
function cellLines(cell: Element): CellLine[] {
  const out: CellLine[] = [];
  let cur: CellLine | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) out.push({ text: cur.text.replace(/\s+$/, ''), indent: cur.indent });
    cur = null;
  };
  const walk = (node: Node, indent: number) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // 렌더링과 같게 — 일반 공백·소스 줄바꿈은 접고(줄 머리에서는 제거), NBSP만 실제 공백(들여쓰기)으로 인정
        let text = (child.textContent ?? '').replace(/[ \t\r\n]+/g, ' ');
        if (!cur || cur.text === '') text = text.replace(/^ +/, '');
        text = text.replace(/ /g, ' ');
        if (!text) continue;
        if (!cur) cur = { text: '', indent };
        cur.text += text;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      if (el.tagName === 'BR') {
        flush();
        continue;
      }
      const isBlock = BLOCK_TAGS.has(el.tagName);
      const margin = /margin-left:\s*(\d+(?:\.\d+)?)px/i.exec(el.getAttribute('style') ?? '');
      const childIndent = isBlock && margin ? Math.floor(Number(margin[1]) / 16) : indent;
      if (isBlock) flush();
      walk(el, childIndent);
      if (isBlock) flush();
    }
  };
  walk(cell, 0);
  flush();
  return out.map((l) => ({ text: l.text, indent: Math.max(l.indent, indentLevel(l.text)) }));
}

function buildBlock(
  locationCell: string,
  customerCell: string,
  lines: CellLine[],
  warnings: string[],
): LocationBlock | null {
  const locations = locationCell
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const customer = customerCell
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');

  // 내용 셀의 [고객사]로 시작하는 줄이 항목 머리, 나머지가 본문
  const items = parseItems(lines, locations, warnings);

  if (locations.length === 0 && !customer && items.length === 0) return null;

  // 기존 메일(customer 컬럼 없는 옛 표) fallback — locations 마지막 줄을 customer로 추정
  let finalLocations = locations;
  let finalCustomer = customer;
  if (!finalCustomer && locations.length >= 2) {
    finalCustomer = locations[locations.length - 1];
    finalLocations = locations.slice(0, -1);
  }

  return { locations: finalLocations, customer: finalCustomer, items };
}

/** 본문 줄 → 항목 목록. 머리 없이 시작하는 본문은 빈 고객사 항목으로 흡수 */
function parseItems(lines: CellLine[], locations: readonly string[], warnings: string[]): ClientItem[] {
  const items: ClientItem[] = [];
  let item: ClientItem | null = null;
  let cursor: ContentCursor = {};

  for (const { text, indent } of lines) {
    const line = text.trim();
    if (!line) {
      cursor = {};
      continue;
    }
    if (line.startsWith('[')) {
      const { header, issues } = parseItemHeader(line, locations);
      for (const is of issues) if (is.severity === 'warning') warnings.push(is.message);
      item = { ...header, content: [] };
      items.push(item);
      cursor = {};
      continue;
    }
    if (!item) {
      item = { client: '', workType: '', content: [] };
      items.push(item);
    }
    const content = matchContentLine(line);
    if (content) appendContentLine(item, cursor, content, indent);
    else appendPlainText(item, cursor, line, indent);
  }
  return items;
}

/** 탭 구분 plain 본문 (renderPlain 출력 · 표를 plain으로 복사한 메일) → 일자 + 일정 예정 */
function parsePlainBody(text: string, warnings: string[]): { days: DayEntry[]; plans: PlanEntry[] } {
  const days: DayEntry[] = [];
  const plans: PlanEntry[] = [];
  const lines = text.split('\n');
  let currentDay: DayEntry | undefined;
  let currentBlock: LocationBlock | undefined;
  let item: ClientItem | undefined;
  let cursor: ContentCursor = {};
  let inPlan = false;
  let sections = 0;

  const startBlock = (day: DayEntry, loc: string, cus: string): LocationBlock => {
    const block: LocationBlock = {
      locations: loc.trim() ? [loc.trim()] : [],
      customer: cus.trim(),
      items: [],
    };
    day.blocks.push(block);
    currentBlock = block;
    item = undefined;
    cursor = {};
    return block;
  };

  /** 내용 셀 한 줄 소비 — 항목 머리 / 본문 마커 / 이어지는 줄 */
  const consume = (block: LocationBlock, raw: string) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('[')) {
      const { header, issues } = parseItemHeader(line, block.locations);
      for (const is of issues) if (is.severity === 'warning') warnings.push(is.message);
      item = { ...header, content: [] };
      block.items.push(item);
      cursor = {};
      return;
    }
    const content = matchContentLine(line);
    if (!content && block.locations.length === 0 && block.items.length === 0) {
      // 마커 없는 첫 줄은 지원장소로 추정 (탭 없는 옛 메일 본문)
      block.locations.push(line);
      return;
    }
    if (!item) {
      item = { client: '', workType: '', content: [] };
      block.items.push(item);
    }
    if (content) appendContentLine(item, cursor, content, indentLevel(raw));
    else appendPlainText(item, cursor, line, indentLevel(raw));
  };

  let inHeader = true;
  for (const rawLine0 of lines) {
    const rawLine = rawLine0.replace(/\r$/, '');
    const line = rawLine.trim();
    if (!line) {
      cursor = {};
      continue;
    }
    if (line.startsWith('■')) {
      sections += 1;
      // 합본 plain — 두 번째 섹션(이전 주)부터는 가져오지 않는다 (최근 주 = 첫 섹션)
      if (sections > 1) break;
      inHeader = true;
      continue;
    }
    if (RE_PLAN_HEADER.test(line)) {
      inPlan = true;
      continue;
    }
    if (inHeader && (line.startsWith('□') || /^일자\s+지원장소/.test(line))) {
      continue;
    }
    inHeader = false;

    if (inPlan) {
      const [dateCell, ...restCells] = rawLine.split('\t').map((c) => c.trim());
      const parsed = dayFromLabel(dateCell);
      const planText = restCells.join(' ').trim();
      if (parsed && planText) {
        for (const t of planText.split(' / ').map((s) => s.trim()).filter(Boolean)) plans.push({ date: parsed.date, text: t });
      }
      continue;
    }

    // renderPlain 출력(및 표를 plain으로 복사한 본문)은 셀을 탭으로 구분한다 — 탭 행은 컬럼 단위로 해석.
    const cells = rawLine.includes('\t') ? rawLine.split('\t') : null;
    const head = cells ? cells[0].trim() : line;

    const dayMatch = head.match(RE_DAY_LABEL) ?? head.match(RE_DAY_DOT);
    if (dayMatch && head.startsWith(dayMatch[0])) {
      const day: DayEntry = {
        date: `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`,
        weekday: dayMatch[4] as DayEntry['weekday'],
        blocks: [],
      };
      currentDay = day;
      days.push(day);
      // 일자 라벨 뒤 잔여(같은 셀 안) = 반차(@HALFDAY) 라벨. 탭 뒤 셀은 장소/고객사이므로 라벨이 아님
      const restAfterDate = head.slice(dayMatch[0].length).trim();
      if (restAfterDate) day.partial = { label: restAfterDate };
      const block = startBlock(day, cells?.[1] ?? '', cells?.[2] ?? '');
      if (cells?.[3]?.trim()) consume(block, cells[3]);
      continue;
    }

    if (!currentDay) continue;
    const block = currentBlock ?? startBlock(currentDay, '', '');

    if (cells) {
      if (!cells[0].trim() && cells.length >= 4) {
        // 첫 셀이 빈 탭 행 = 같은 일자의 추가 장소 블록 (표의 rowspan 다음 행)
        const next = startBlock(currentDay, cells[1], cells[2]);
        if (cells[3]?.trim()) consume(next, cells[3]);
      } else if (cells.length >= 3 && block.items.length === 0) {
        // 장소 셀이 여러 줄인 행: [장소 n행, 고객사, 내용]
        if (cells[0].trim()) block.locations.push(cells[0].trim());
        if (cells[1].trim() && !block.customer) block.customer = cells[1].trim();
        if (cells[2]?.trim()) consume(block, cells[2]);
      } else {
        // 내용 셀의 연속 줄 — 뒤 셀(기타 필러 등)은 무시
        consume(block, cells[0]);
      }
      continue;
    }

    consume(block, rawLine);
  }

  return { days, plans };
}

function extractRange(text: string, re: RegExp): DateRange | null {
  const m = text.match(re);
  if (!m) return null;
  const p = (s: string) => s.padStart(2, '0');
  return { start: `${m[1]}-${p(m[2])}-${p(m[3])}`, end: `${m[4]}-${p(m[5])}-${p(m[6])}` };
}

/** PREV(보고 주) + 7일 = 다음 주. 길이 보존 (월~일이면 월~일) */
function nextWeekFrom(prev: DateRange): DateRange {
  const start = new Date(`${prev.start}T00:00:00`);
  const end = new Date(`${prev.end}T00:00:00`);
  start.setDate(start.getDate() + 7);
  end.setDate(end.getDate() + 7);
  return { start: isoOf(start), end: isoOf(end) };
}

/** 표 일자 행에서 보고 주(@PREV) 추정 — 첫 일자가 속한 주의 월~일 */
function inferWeekRangeFromDays(days: DayEntry[]): DateRange | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(`${sorted[0].date}T00:00:00`);
  if (Number.isNaN(first.getTime())) return null;
  const monday = new Date(first);
  monday.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: isoOf(monday), end: isoOf(sunday) };
}

/** 추정 실패 시 fallback — 지난 주(보고 대상) 월~일 */
function defaultPrevWeekRange(): DateRange {
  const today = new Date();
  today.setDate(today.getDate() - 7);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: isoOf(monday), end: isoOf(sunday) };
}
