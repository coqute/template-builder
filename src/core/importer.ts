import type {
  Channel,
  ClientItem,
  ContentBlock,
  DateRange,
  DayEntry,
  LocationBlock,
  WeekReport,
} from './types';
import { getWeekday } from './types';

export interface ImportInput {
  html?: string;
  plain?: string;
}

export interface ImportResult {
  report: WeekReport;
  warnings: string[];
}

const RE_HEADER_DATE = /□\s*Date\s*:\s*(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})/;
const RE_DAY_LABEL = /(\d{4})-(\d{2})-(\d{2})\s*\(([월화수목금토일])\)/;
const RE_DAY_DOT = /(\d{4})\.(\d{2})\.(\d{2})\s*\(([월화수목금토일])\)/;

const VALID_CHANNELS = new Set<Channel>(['메일', '유선', '유선&메일']);

export function importFromInput(input: ImportInput): ImportResult {
  if (input.html && input.html.trim().length > 0) {
    return importFromHtml(input.html);
  }
  if (input.plain && input.plain.trim().length > 0) {
    return importFromPlain(input.plain);
  }
  throw new Error('가져올 본문이 비어 있습니다 (HTML/plain 모두 없음).');
}

export function importFromHtml(html: string): ImportResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = (doc.body?.textContent ?? '').replace(/ /g, ' ');
  // 본문 □ Date 헤더는 PREV(보고 대상 주) 기준
  const headerRange = extractDateHeader(fullText);

  const tables = Array.from(doc.querySelectorAll('table'));
  const reportTable = pickReportTable(tables);
  if (!reportTable) {
    warnings.push('보고서 표를 찾지 못해 plain text 경로로 폴백합니다.');
    return importFromPlain(fullText);
  }

  const days = parseHtmlTable(reportTable, warnings);
  const inferredPrev = inferWeekRangeFromDays(days);
  const prevWeekRange = headerRange ?? inferredPrev ?? defaultPrevWeekRange();
  if (!headerRange && !inferredPrev) {
    warnings.push('"□ Date" 헤더와 일자 행을 모두 찾지 못해 @PREV를 추정했습니다.');
  }
  const currentWeekRange = nextWeekFrom(prevWeekRange);

  return {
    report: { prevWeekRange, currentWeekRange, authorName: '박민수', days },
    warnings,
  };
}

export function importFromPlain(text: string): ImportResult {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/ /g, ' ');
  const headerRange = extractDateHeader(normalized);

  const days = parsePlainBody(normalized, warnings);
  const inferredPrev = inferWeekRangeFromDays(days);
  const prevWeekRange = headerRange ?? inferredPrev ?? defaultPrevWeekRange();
  if (!headerRange && !inferredPrev) {
    warnings.push('"□ Date" 헤더와 일자 행을 모두 찾지 못해 @PREV를 추정했습니다.');
  }
  const currentWeekRange = nextWeekFrom(prevWeekRange);

  return {
    report: { prevWeekRange, currentWeekRange, authorName: '박민수', days },
    warnings,
  };
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
    const cells = Array.from(row.querySelectorAll('th,td')).map((c) => cellText(c));
    if (cells.length === 0) continue;

    const offsetForDate = cells.length >= 5 ? 0 : 1;
    const dateLabel = offsetForDate === 0 ? cells[0] : '';
    const locationCell = cells[cells.length - 4] ?? '';
    const clientCell = cells[cells.length - 3] ?? '';
    const contentCell = cells[cells.length - 2] ?? '';

    if (dateLabel) {
      const m = dateLabel.match(RE_DAY_LABEL) ?? dateLabel.match(RE_DAY_DOT);
      if (m) {
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        const weekday = m[4] as DayEntry['weekday'];
        currentDay = { date, weekday, blocks: [] };
        days.push(currentDay);
      } else if (dateLabel.trim()) {
        warnings.push(`인식할 수 없는 일자 라벨: ${dateLabel.slice(0, 40)}`);
      }
    }

    if (!currentDay) continue;

    const block = parseBlockFromCells(locationCell, clientCell, contentCell, warnings);
    if (block) currentDay.blocks.push(block);
  }

  return days;
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

function parseBlockFromCells(
  locationCell: string,
  customerCell: string,
  contentCell: string,
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

  const contentLines = contentCell.split('\n').map((s) => s.trim());

  // 새 형식: content 안의 [고객사]로 시작하는 줄이 @SUM 헤더, 나머지가 본문
  const items = parseItemsFromContentLines(contentLines, warnings);

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

/** content 셀의 줄들에서 [고객사]로 시작하는 줄을 @SUM 헤더로 분리, 나머지를 본문으로 흡수 */
function parseItemsFromContentLines(lines: string[], warnings: string[]): ClientItem[] {
  const items: ClientItem[] = [];
  let buffer: string[] = [];
  let header: ClientItem | null = null;

  const flush = () => {
    if (header) {
      header.content = parseContentLines(buffer);
      items.push(header);
    }
    header = null;
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      flush();
      header = parseClientHead(line, warnings);
    } else if (header) {
      buffer.push(line);
    } else {
      // [고객사] 헤더 없이 본문만 있는 경우 — 빈 client로 흡수
      header = { client: '', workType: '', content: [] };
      buffer.push(line);
    }
  }
  flush();
  return items;
}

function parseClientHead(line: string, warnings: string[]): ClientItem {
  const channelMatch = line.match(/^\[([^\]]+)\]\s*\(([^)/]+)\/([^)]+)\)\s*(.*)$/);
  if (channelMatch) {
    const [, client, contact, channelRaw, workType] = channelMatch;
    if (!VALID_CHANNELS.has(channelRaw as Channel)) {
      warnings.push(`알 수 없는 채널: ${channelRaw}`);
      return { client, contact, workType, content: [] };
    }
    return { client, contact, channel: channelRaw as Channel, workType, content: [] };
  }
  const namedMatch = line.match(/^\[([^\]]+)\]\s*\(([^)/]+)\)\s*(.*)$/);
  if (namedMatch) {
    const [, client, contact, workType] = namedMatch;
    return { client, contact, workType, content: [] };
  }
  const bareMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bareMatch) {
    const [, client, workType] = bareMatch;
    return { client, workType, content: [] };
  }
  warnings.push(`고객사 헤더 인식 실패: ${line.slice(0, 40)}`);
  return { client: '', workType: line, content: [] };
}

function parseContentLines(lines: string[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  let current: ContentBlock | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      current = undefined;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(\d+)\)\s*(.*)$/))) {
      current = { kind: 'numbered', index: Number.parseInt(m[1], 10), title: m[2], details: [] };
      out.push(current);
      continue;
    }
    if ((m = line.match(/^<-\s*(.*)$/))) {
      current = { kind: 'qa', question: m[1] || undefined, answers: [] };
      out.push(current);
      continue;
    }
    if ((m = line.match(/^->\s*(.*)$/))) {
      if (!current || current.kind !== 'qa') {
        current = { kind: 'qa', answers: [] };
        out.push(current);
      }
      (current as { answers: string[] }).answers.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      // `>` 노트 라인 — NOTE_PREFIX 접두 보존하여 현재 블록에 부착
      const noteLine = `> ${m[1]}`;
      if (current && current.kind === 'numbered') {
        current.details.push(noteLine);
        continue;
      }
      if (current && current.kind === 'qa') {
        current.answers.push(noteLine);
        continue;
      }
      if (!current || current.kind !== 'bullets') {
        current = { kind: 'bullets', items: [] };
        out.push(current);
      }
      (current as { items: string[] }).items.push(noteLine);
      continue;
    }
    if ((m = line.match(/^-\s+(.*)$/))) {
      if (current && current.kind === 'numbered') {
        current.details.push(m[1]);
        continue;
      }
      if (!current || current.kind !== 'bullets') {
        current = { kind: 'bullets', items: [] };
        out.push(current);
      }
      (current as { items: string[] }).items.push(m[1]);
      continue;
    }
    if (current && current.kind === 'numbered') {
      current.details.push(line);
      continue;
    }
    if (current && current.kind === 'qa') {
      current.answers.push(line);
      continue;
    }
    if (!current || current.kind !== 'bullets') {
      current = { kind: 'bullets', items: [] };
      out.push(current);
    }
    (current as { items: string[] }).items.push(line);
  }

  return out;
}

function parsePlainBody(text: string, warnings: string[]): DayEntry[] {
  const days: DayEntry[] = [];
  const lines = text.split('\n');
  let currentDay: DayEntry | undefined;
  let currentBlock: LocationBlock | undefined;
  let currentItem: ClientItem | undefined;
  let currentContent: ContentBlock | undefined;

  let inHeader = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      currentContent = undefined;
      continue;
    }
    if (inHeader && (line.startsWith('■') || line.startsWith('□') || /^일자\s+지원장소/.test(line))) {
      continue;
    }
    inHeader = false;

    const dayMatch = line.match(RE_DAY_LABEL) ?? line.match(RE_DAY_DOT);
    if (dayMatch && line.startsWith(dayMatch[0])) {
      const date = `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`;
      const weekday = dayMatch[4] as DayEntry['weekday'];
      currentDay = { date, weekday, blocks: [] };
      days.push(currentDay);
      currentBlock = { locations: [], customer: '', items: [] };
      currentDay.blocks.push(currentBlock);
      currentItem = undefined;
      currentContent = undefined;
      continue;
    }

    if (!currentDay) continue;
    if (!currentBlock) {
      currentBlock = { locations: [], customer: '', items: [] };
      currentDay.blocks.push(currentBlock);
    }

    if (line.startsWith('[')) {
      const item = parseClientHead(line, warnings);
      currentBlock.items.push(item);
      currentItem = item;
      currentContent = undefined;
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(\d+)\)\s*(.*)$/))) {
      if (!currentItem) {
        currentItem = { client: '', workType: '', content: [] };
        currentBlock.items.push(currentItem);
      }
      const block: ContentBlock = {
        kind: 'numbered',
        index: Number.parseInt(m[1], 10),
        title: m[2],
        details: [],
      };
      currentItem.content.push(block);
      currentContent = block;
      continue;
    }
    if ((m = line.match(/^<-\s*(.*)$/))) {
      if (!currentItem) {
        currentItem = { client: '', workType: '', content: [] };
        currentBlock.items.push(currentItem);
      }
      const block: ContentBlock = { kind: 'qa', question: m[1] || undefined, answers: [] };
      currentItem.content.push(block);
      currentContent = block;
      continue;
    }
    if ((m = line.match(/^->\s*(.*)$/))) {
      if (!currentItem) {
        currentItem = { client: '', workType: '', content: [] };
        currentBlock.items.push(currentItem);
      }
      let target = currentContent;
      if (!target || target.kind !== 'qa') {
        target = { kind: 'qa', answers: [] };
        currentItem.content.push(target);
        currentContent = target;
      }
      (target as { answers: string[] }).answers.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      // `>` 노트 라인 — NOTE_PREFIX 접두 보존하여 현재 블록에 부착
      if (!currentItem) {
        currentItem = { client: '', workType: '', content: [] };
        currentBlock.items.push(currentItem);
      }
      const noteLine = `> ${m[1]}`;
      if (currentContent && currentContent.kind === 'numbered') {
        currentContent.details.push(noteLine);
        continue;
      }
      if (currentContent && currentContent.kind === 'qa') {
        currentContent.answers.push(noteLine);
        continue;
      }
      let noteBullets = currentContent && currentContent.kind === 'bullets' ? currentContent : undefined;
      if (!noteBullets) {
        noteBullets = { kind: 'bullets', items: [] };
        currentItem.content.push(noteBullets);
        currentContent = noteBullets;
      }
      noteBullets.items.push(noteLine);
      continue;
    }
    if ((m = line.match(/^-\s+(.*)$/))) {
      if (!currentItem) {
        currentItem = { client: '', workType: '', content: [] };
        currentBlock.items.push(currentItem);
      }
      if (currentContent && currentContent.kind === 'numbered') {
        currentContent.details.push(m[1]);
        continue;
      }
      let bullets = currentContent && currentContent.kind === 'bullets' ? currentContent : undefined;
      if (!bullets) {
        bullets = { kind: 'bullets', items: [] };
        currentItem.content.push(bullets);
        currentContent = bullets;
      }
      bullets.items.push(m[1]);
      continue;
    }

    if (currentBlock.locations.length === 0 && currentBlock.items.length === 0) {
      currentBlock.locations.push(line);
      continue;
    }
    if (currentItem && currentContent) {
      if (currentContent.kind === 'numbered') currentContent.details.push(line);
      else if (currentContent.kind === 'qa') currentContent.answers.push(line);
      else (currentContent as { items: string[] }).items.push(line);
    }
  }

  return days;
}

/** 본문 □ Date 헤더에서 보고 대상 주(@PREV) 범위 추출 */
function extractDateHeader(text: string): DateRange | null {
  const m = text.match(RE_HEADER_DATE);
  if (!m) return null;
  return {
    start: `${m[1]}-${m[2]}-${m[3]}`,
    end: `${m[4]}-${m[5]}-${m[6]}`,
  };
}

/** PREV(지난 주) + 7일 = CURRENT(이번 주). 길이 보존 (월~일이면 월~일, 월~금이면 월~금) */
function nextWeekFrom(prev: DateRange): DateRange {
  const start = new Date(`${prev.start}T00:00:00`);
  const end = new Date(`${prev.end}T00:00:00`);
  start.setDate(start.getDate() + 7);
  end.setDate(end.getDate() + 7);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { start: fmt(start), end: fmt(end) };
}

/** 표 일자 행에서 "지난 주" 범위(@PREV) 추정 — 첫 일자가 속한 주의 월~일 */
function inferWeekRangeFromDays(days: DayEntry[]): DateRange | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0].date;
  const lastDate = new Date(`${first}T00:00:00`);
  if (Number.isNaN(lastDate.getTime())) return null;
  const monday = new Date(lastDate);
  monday.setDate(lastDate.getDate() - ((lastDate.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { start: fmt(monday), end: fmt(sunday) };
}

/** 추정 실패 시 fallback — 지난 주(보고 대상) 월~일 */
function defaultPrevWeekRange(): DateRange {
  const today = new Date();
  today.setDate(today.getDate() - 7);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { start: fmt(monday), end: fmt(sunday) };
}

export { getWeekday };
