import type {
  ClientItem,
  ContentBlock,
  DayEntry,
  LocationBlock,
  WeekReport,
} from './types';
import { isNoteLine, noteText } from './types';
import { buildHtmlHeader, buildPlainHeader } from './templates/header';
import { escapeHtml } from '../lib/html';

const FAMILY = `'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', system-ui, sans-serif`;
const PAD = '8px 10px';
const BORDER = '1px solid #b7bcc2';

export const CANVAS_WIDTH = 960;

// 컬럼 폭은 기존 Gmail 발송본의 비율을 기준으로 — 내용 셀이 최대(약 53%).
// - 일자(125): `2026-04-27(월)` 13자가 한 줄에 들어가는 최소 폭. 100px로 줄이면 줄바꿈 발생
// - 지원장소(130): `한강 제트플러스 4F` 한 줄 + 여유
// - 고객사/작업구분(145): 최장 `한강 관제 개발팀` 한 줄(~129px) + padding 여유
// - 내용(510): @SUM 헤더 + Q&A + 다중 bullet 풍부한 표시 보장
// - 기타(50): 전각공백 1자
// 합계는 CANVAS_WIDTH(960)와 일치해야 한다.
const COL_WIDTHS = {
  date: 125,
  location: 130,
  client: 145,
  content: 510,
  etc: 50,
} as const;

const HEADER_BG = '#dde0e3';

const HOLIDAY_BG = '#FFCCCC';
const HOLIDAY_FG = '#B91C1C';

const TEXT_BASE = `font-family:${FAMILY};font-size:13px;line-height:1.55;letter-spacing:-0.01em;color:#1f2937;word-break:keep-all;overflow-wrap:break-word;`;
const TD_BASE = `border:${BORDER};padding:${PAD};vertical-align:top;${TEXT_BASE}`;
/** 일자·지원장소·고객사 셀 — 가로/세로 정중앙 정렬 */
const TD_CENTER = `border:${BORDER};padding:${PAD};vertical-align:middle;text-align:center;${TEXT_BASE}`;
const TH_BASE = `${TD_BASE}background:${HEADER_BG};font-weight:600;text-align:center;color:#111827;`;
const ETC_FILLER = '　';

export interface RenderResult {
  html: string;
  plain: string;
}

export interface RenderOptions {
  width?: number;
}

export function render(report: WeekReport, options: RenderOptions = {}): RenderResult {
  return {
    html: renderHtml(report, options),
    plain: renderPlain(report),
  };
}

export function renderHtml(report: WeekReport, options: RenderOptions = {}): string {
  const width = options.width ?? CANVAS_WIDTH;
  const head = buildHtmlHeader(report.prevWeekRange);
  const tableOpen = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:${BORDER};width:${width}px;table-layout:fixed;">`;
  const colgroup = [
    `<colgroup>`,
    `<col style="width:${COL_WIDTHS.date}px"/>`,
    `<col style="width:${COL_WIDTHS.location}px"/>`,
    `<col style="width:${COL_WIDTHS.client}px"/>`,
    `<col style="width:${COL_WIDTHS.content}px"/>`,
    `<col style="width:${COL_WIDTHS.etc}px"/>`,
    `</colgroup>`,
  ].join('');
  const thead = [
    `<thead>`,
    `<tr>`,
    `<th style="${TH_BASE}">일자</th>`,
    `<th style="${TH_BASE}">지원장소</th>`,
    `<th style="${TH_BASE}">고객사 / 작업구분</th>`,
    `<th style="${TH_BASE}">내용</th>`,
    `<th style="${TH_BASE}">기타</th>`,
    `</tr>`,
    `</thead>`,
  ].join('');

  const rows: string[] = [];
  for (const day of report.days) {
    rows.push(...renderDayRows(day));
  }

  const table = `${tableOpen}${colgroup}${thead}<tbody>${rows.join('')}</tbody></table>`;
  return `${head}\n${table}`;
}

function renderDayRows(day: DayEntry): string[] {
  if (day.holiday) {
    const tdHolidayCenter = `${TD_CENTER}background:${HOLIDAY_BG};`;
    const tdHolidayBase = `${TD_BASE}background:${HOLIDAY_BG};`;
    const tdDate = `${tdHolidayCenter}color:${HOLIDAY_FG};font-weight:600;`;
    // 휴무 사유는 내용 셀에 표기 — importer가 이 텍스트로 사유를 왕복 복원한다
    const reason = day.holiday.reason.trim();
    const reasonHtml = reason
      ? `<span style="color:${HOLIDAY_FG};font-weight:600;">${escapeHtml(reason)}</span>`
      : '';
    return [
      `<tr style="background:${HOLIDAY_BG};">` +
        `<td style="${tdDate}">${escapeHtml(formatDateLabel(day))}</td>` +
        `<td style="${tdHolidayCenter}"></td>` +
        `<td style="${tdHolidayCenter}"></td>` +
        `<td style="${tdHolidayBase}">${reasonHtml}</td>` +
        `<td style="${tdHolidayBase}"></td>` +
        `</tr>`,
    ];
  }

  if (day.blocks.length === 0) {
    return [
      `<tr>` +
        `<td style="${TD_CENTER}">${escapeHtml(formatDateLabel(day))}</td>` +
        `<td style="${TD_CENTER}"></td>` +
        `<td style="${TD_CENTER}"></td>` +
        `<td style="${TD_BASE}"></td>` +
        `<td style="${TD_BASE}">${ETC_FILLER}</td>` +
        `</tr>`,
    ];
  }

  const totalSpan = day.blocks.length;
  const out: string[] = [];

  // 장소 그룹 rowspan 계산 — inheritLocation=false 시작점부터 연속된 inheritLocation=true 갯수
  const locationSpans: number[] = new Array(day.blocks.length).fill(0);
  for (let i = 0; i < day.blocks.length; i++) {
    if (!day.blocks[i].inheritLocation) {
      let span = 1;
      for (let j = i + 1; j < day.blocks.length; j++) {
        if (day.blocks[j].inheritLocation) span++;
        else break;
      }
      locationSpans[i] = span;
    }
  }

  day.blocks.forEach((block, idx) => {
    const cells: string[] = [];
    if (idx === 0) {
      cells.push(
        `<td rowspan="${totalSpan}" style="${TD_CENTER}">${escapeHtml(formatDateLabel(day))}</td>`,
      );
    }
    if (locationSpans[idx] > 0) {
      const span = locationSpans[idx];
      const rowspanAttr = span > 1 ? ` rowspan="${span}"` : '';
      cells.push(
        `<td${rowspanAttr} style="${TD_CENTER}">${renderLocationCell(block)}</td>`,
      );
    }
    // inheritLocation=true인 block은 장소 셀 출력 생략 (상위 block의 rowspan에 흡수)
    cells.push(`<td style="${TD_CENTER}">${renderCustomerCell(block.customer)}</td>`);
    cells.push(`<td style="${TD_BASE}">${renderContentCell(block.items)}</td>`);
    cells.push(`<td style="${TD_BASE}">${ETC_FILLER}</td>`);
    out.push(`<tr>${cells.join('')}</tr>`);
  });

  return out;
}

function formatDateLabel(day: DayEntry): string {
  return `${day.date}(${day.weekday})`;
}

function renderLocationCell(block: LocationBlock): string {
  if (block.locations.length === 0) return '';
  return block.locations.map(escapeHtml).join('<br/>');
}

/** 고객사/작업구분 컬럼 — @CUS 텍스트. 공백 둘러싼 슬래시(` / `)는 줄바꿈 */
function renderCustomerCell(customer: string): string {
  if (!customer) return '';
  const parts = customer.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map(escapeHtml).join('<br/>');
}

/** 내용 셀 — @SUM 라인 전체(`[고객사] (담당자) workType`)를 굵은 상위 헤더로 표시 + 1) 2) 하위 */
function renderContentCell(items: ClientItem[]): string {
  return items
    .map((item, idx) => {
      const sep = idx > 0 ? `<div style="height:10px;"></div>` : '';
      const summaryLine = formatSummaryLine(item);
      const summaryHeader = summaryLine
        ? `<div style="font-weight:700;margin-bottom:4px;">${escapeHtml(summaryLine)}</div>`
        : '';
      const blocks = item.content.map(renderContentBlock).filter(Boolean).join('');
      return `${sep}${summaryHeader}${blocks}`;
    })
    .join('');
}

function formatSummaryLine(item: ClientItem): string {
  const head = item.contact
    ? item.channel
      ? `[${item.client}] (${item.contact}/${item.channel})`
      : `[${item.client}] (${item.contact})`
    : `[${item.client}]`;
  return item.workType ? `${head} ${item.workType}` : head;
}

/** `>` 노트 라인 — 들여쓰기 + 회색 보조 스타일, `>` 마커 유지 (HTML 재가져오기 시 구분 보존) */
function renderNoteLine(line: string): string {
  return `<div style="margin-left:16px;color:#6B7280;">&gt; ${escapeHtml(noteText(line))}</div>`;
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.kind) {
    case 'numbered': {
      const detail = block.details
        .map((d) =>
          isNoteLine(d)
            ? renderNoteLine(d)
            : `<div style="margin-left:8px;">- ${escapeHtml(d)}</div>`,
        )
        .join('');
      return `<div>${block.index}) ${escapeHtml(block.title)}</div>${detail}`;
    }
    case 'qa': {
      const q = block.question
        ? `<div>&lt;- ${escapeHtml(block.question)}</div>`
        : '';
      const a = block.answers
        .map((ans) =>
          isNoteLine(ans) ? renderNoteLine(ans) : `<div>-&gt; ${escapeHtml(ans)}</div>`,
        )
        .join('');
      return `${q}${a}`;
    }
    case 'bullets': {
      return block.items
        .map((b) => (isNoteLine(b) ? renderNoteLine(b) : `<div>- ${escapeHtml(b)}</div>`))
        .join('');
    }
  }
}

export function renderPlain(report: WeekReport): string {
  const head = buildPlainHeader(report.prevWeekRange);
  const headerRow = ['일자', '지원장소', '고객사 / 작업구분', '내용', '기타'].join('\t');
  const rows: string[] = [];

  for (const day of report.days) {
    if (day.holiday) {
      rows.push([formatDateLabel(day), '', '', day.holiday.reason.trim(), ''].join('\t'));
      continue;
    }
    if (day.blocks.length === 0) {
      rows.push([formatDateLabel(day), '', '', '', ETC_FILLER].join('\t'));
      continue;
    }
    day.blocks.forEach((block, idx) => {
      const date = idx === 0 ? formatDateLabel(day) : '';
      const loc = block.locations.join('\n');
      const customer = block.customer
        ? block.customer.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean).join('\n')
        : '';
      const content = block.items
        .map((item) => {
          const summaryLine = formatClientLinePlain(item);
          const body = item.content
            .map(renderContentBlockPlain)
            .filter((s) => s.length > 0)
            .join('\n');
          return body ? `${summaryLine}\n${body}` : summaryLine;
        })
        .filter((s) => s.length > 0)
        .join('\n\n');
      rows.push([date, loc, customer, content, ETC_FILLER].join('\t'));
    });
  }

  return `${head}\n\n${headerRow}\n${rows.join('\n')}`;
}

function formatClientLinePlain(item: ClientItem): string {
  const head = item.contact
    ? item.channel
      ? `[${item.client}] (${item.contact}/${item.channel})`
      : `[${item.client}] (${item.contact})`
    : `[${item.client}]`;
  return item.workType ? `${head} ${item.workType}` : head;
}

function renderContentBlockPlain(block: ContentBlock): string {
  switch (block.kind) {
    case 'numbered': {
      const detail = block.details
        .map((d) => (isNoteLine(d) ? `> ${noteText(d)}` : `- ${d}`))
        .join('\n');
      return `${block.index}) ${block.title}${detail ? `\n${detail}` : ''}`;
    }
    case 'qa': {
      const q = block.question ? `<- ${block.question}` : '';
      const a = block.answers
        .map((ans) => (isNoteLine(ans) ? `> ${noteText(ans)}` : `-> ${ans}`))
        .join('\n');
      return [q, a].filter(Boolean).join('\n');
    }
    case 'bullets': {
      return block.items.map((b) => (isNoteLine(b) ? `> ${noteText(b)}` : `- ${b}`)).join('\n');
    }
  }
}

