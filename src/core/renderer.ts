import type {
  ClientItem,
  ContentBlock,
  DayEntry,
  DialogTurn,
  LocationBlock,
  PlanEntry,
  WeekReport,
} from './types';
import { getWeekday, isNoteLine, noteText } from './types';
import { turnMarker } from './content';
import { formatItemHeader } from './item-header';
import { pruneBlank } from './blank';
import {
  buildCombinedSubject,
  buildHtmlHeader,
  buildPlainHeader,
  buildPlanHtmlTitle,
  buildPlanTitle,
  buildSubject,
} from './templates/header';
import { escapeHtml } from '../lib/html';

const FAMILY = `'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', system-ui, sans-serif`;
const PAD = '8px 10px';
const BORDER = '1px solid #b7bcc2';

export const CANVAS_WIDTH = 960;

// 컬럼 폭은 기존 Gmail 발송본의 비율을 기준으로 — 내용 셀이 최대(약 53%).
// - 일자(125): `2026-04-27(월)` 13자가 한 줄에 들어가는 최소 폭. 100px로 줄이면 줄바꿈 발생
// - 지원장소(130): `한강 제트플러스 4F` 한 줄 + 여유
// - 고객사|작업구분(145): 최장 `한강 관제 개발팀` 한 줄(~129px) + padding 여유
// - 내용(510): 항목 머리 + 대화 이력 + 다중 세부 풍부한 표시 보장
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
/** 반차(부분 근태) 라벨 — 휴무(빨강)와 구분되는 주황 계열, 행 배경은 근무일 그대로 */
const HALFDAY_FG = '#C2410C';
/** 미결 대응(`*<-`) — 받는 사람이 후속 건을 한눈에 찾도록 호박색 */
const PENDING_FG = '#B45309';
/** 들여쓰기 1단계 폭 (px) */
const INDENT_PX = 16;

// font-variant-ligatures:none — Pretendard(Inter 계열)가 설치된 수신 환경에서 `->` `<-` `==>`가 화살표로 합쳐 보이지 않게
const TEXT_BASE = `font-family:${FAMILY};font-size:13px;line-height:1.55;letter-spacing:-0.01em;color:#1f2937;word-break:keep-all;overflow-wrap:break-word;font-variant-ligatures:none;`;
const TD_BASE = `border:${BORDER};padding:${PAD};vertical-align:top;${TEXT_BASE}`;
/** 일자·지원장소·고객사 셀 — 가로/세로 정중앙 정렬 */
const TD_CENTER = `border:${BORDER};padding:${PAD};vertical-align:middle;text-align:center;${TEXT_BASE}`;
const TH_BASE = `${TD_BASE}background:${HEADER_BG};font-weight:600;text-align:center;color:#111827;`;
/** 빈 칸 채움 — 전각 공백 (팀 기준 보고서 규격, 행 높이 유지) */
const FILL = '　';

export interface RenderResult {
  html: string;
  plain: string;
}

export interface RenderOptions {
  width?: number;
  /** □ 일정 예정 표 포함 여부 (기본 true). 합본에서는 최근 주에만 */
  includePlan?: boolean;
}

export function render(report: WeekReport, options: RenderOptions = {}): RenderResult {
  return {
    html: renderHtml(report, options),
    plain: renderPlain(report, options),
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
    `<th style="${TH_BASE}">고객사|작업구분</th>`,
    `<th style="${TH_BASE}">내용</th>`,
    `<th style="${TH_BASE}">기타</th>`,
    `</tr>`,
    `</thead>`,
  ].join('');

  const rows: string[] = [];
  // 쓰지 않은 골격(빈 항목·빈 행·빈 턴)은 출력하지 않는다
  for (const day of pruneBlank(report).days) {
    rows.push(...renderDayRows(day));
  }

  const table = `${tableOpen}${colgroup}${thead}<tbody>${rows.join('')}</tbody></table>`;
  const plan = options.includePlan === false ? '' : renderPlanHtml(report);
  return `${head}\n${table}${plan}`;
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
      : FILL;
    return [
      `<tr style="background:${HOLIDAY_BG};">` +
        `<td style="${tdDate}">${escapeHtml(formatDateLabel(day))}</td>` +
        `<td style="${tdHolidayCenter}">${FILL}</td>` +
        `<td style="${tdHolidayCenter}">${FILL}</td>` +
        `<td style="${tdHolidayBase}">${reasonHtml}</td>` +
        `<td style="${tdHolidayBase}">${FILL}</td>` +
        `</tr>`,
    ];
  }

  if (day.blocks.length === 0) {
    return [
      `<tr>` +
        `<td style="${TD_CENTER}">${dateCellHtml(day)}</td>` +
        `<td style="${TD_CENTER}">${FILL}</td>` +
        `<td style="${TD_CENTER}">${FILL}</td>` +
        `<td style="${TD_BASE}">${FILL}</td>` +
        `<td style="${TD_BASE}">${FILL}</td>` +
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
      cells.push(`<td rowspan="${totalSpan}" style="${TD_CENTER}">${dateCellHtml(day)}</td>`);
    }
    if (locationSpans[idx] > 0) {
      const span = locationSpans[idx];
      const rowspanAttr = span > 1 ? ` rowspan="${span}"` : '';
      cells.push(`<td${rowspanAttr} style="${TD_CENTER}">${renderLocationCell(block)}</td>`);
    }
    // inheritLocation=true인 block은 장소 셀 출력 생략 (상위 block의 rowspan에 흡수)
    cells.push(`<td style="${TD_CENTER}">${renderCustomerCell(block.customer)}</td>`);
    cells.push(`<td style="${TD_BASE}">${renderContentCell(block.items)}</td>`);
    cells.push(`<td style="${TD_BASE}">${FILL}</td>`);
    out.push(`<tr>${cells.join('')}</tr>`);
  });

  return out;
}

function formatDateLabel(day: Pick<DayEntry, 'date' | 'weekday'>): string {
  return `${day.date}(${day.weekday})`;
}

/** 날짜 셀 — 반차(@HALFDAY)면 날짜 아래 주황 라벨 표기. importer가 이 텍스트로 왕복 복원 */
function dateCellHtml(day: DayEntry): string {
  const base = escapeHtml(formatDateLabel(day));
  if (!day.partial) return base;
  const label = day.partial.label.trim() || '반차';
  return `${base}<br/><span style="color:${HALFDAY_FG};font-weight:600;">${escapeHtml(label)}</span>`;
}

function renderLocationCell(block: LocationBlock): string {
  if (block.locations.length === 0) return FILL;
  return block.locations.map(escapeHtml).join('<br/>');
}

/** 고객사|작업구분 컬럼 — @CUS 텍스트. 공백 둘러싼 슬래시(` / `)는 줄바꿈 */
function renderCustomerCell(customer: string): string {
  const parts = customer.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return FILL;
  return parts.map(escapeHtml).join('<br/>');
}

/** 내용 셀 — 항목 머리(굵게) + 본문. 항목 사이 간격 */
function renderContentCell(items: ClientItem[]): string {
  const html = items
    .map((item, idx) => {
      const sep = idx > 0 ? `<div style="height:10px;"></div>` : '';
      const summaryLine = formatItemHeader(item);
      const summaryHeader = summaryLine
        ? `<div style="font-weight:700;margin-bottom:4px;">${escapeHtml(summaryLine)}</div>`
        : '';
      const blocks = item.content.map(renderContentBlock).filter(Boolean).join('');
      return `${sep}${summaryHeader}${blocks}`;
    })
    .join('');
  return html || FILL;
}

/** margin-left 스타일 조각 (0이면 빈 문자열 — 들여쓰기 없는 줄은 기존 출력과 동일) */
function ml(px: number, extra = ''): string {
  const style = `${px > 0 ? `margin-left:${px}px;` : ''}${extra}`;
  return style ? ` style="${style}"` : '';
}

/** 여러 줄 텍스트 → <br/> */
function multiline(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br/>');
}

/** `>` 노트 라인 — 들여쓰기 + 회색 보조 스타일, `>` 마커 유지 (HTML 재가져오기 시 구분 보존) */
function renderNoteLine(text: string, base: number): string {
  return `<div style="margin-left:${base + 16}px;color:#6B7280;">&gt; ${multiline(text)}</div>`;
}

function renderTurn(turn: DialogTurn, base: number): string {
  if (turn.kind === 'note') return renderNoteLine(turn.text, base);
  const marker = escapeHtml(turnMarker(turn));
  const extra =
    turn.kind === 'conclusion' ? 'font-weight:700;' : turn.pending ? `color:${PENDING_FG};` : '';
  return `<div${ml(base, extra)}>${marker} ${multiline(turn.text)}</div>`;
}

function renderContentBlock(block: ContentBlock): string {
  const base = (block.indent ?? 0) * INDENT_PX;
  switch (block.kind) {
    case 'numbered': {
      const detail = block.details
        .map((d) =>
          isNoteLine(d)
            ? renderNoteLine(noteText(d), base)
            : `<div style="margin-left:${base + 8}px;">- ${escapeHtml(d)}</div>`,
        )
        .join('');
      return `<div${ml(base)}>${block.index}) ${escapeHtml(block.title)}</div>${detail}`;
    }
    case 'dialog':
      return block.turns.map((t) => renderTurn(t, base)).join('');
    case 'bullets':
      return block.items
        .map((b) => (isNoteLine(b) ? renderNoteLine(noteText(b), base) : `<div${ml(base)}>- ${escapeHtml(b)}</div>`))
        .join('');
  }
}

/** □ 일정 예정 — 날짜별로 묶은 2열 표 (일정이 있을 때만) */
function groupPlans(plans: readonly PlanEntry[]): Array<{ label: string; texts: string[] }> {
  const byDate = new Map<string, string[]>();
  for (const p of [...plans].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!p.text.trim()) continue;
    const list = byDate.get(p.date) ?? [];
    list.push(p.text.trim());
    byDate.set(p.date, list);
  }
  return [...byDate.entries()].map(([date, texts]) => {
    let label = date;
    try {
      label = formatDateLabel({ date, weekday: getWeekday(date) });
    } catch {
      // 잘못된 날짜는 원문 그대로 (검증기가 경고)
    }
    return { label, texts };
  });
}

function renderPlanHtml(report: WeekReport): string {
  const groups = groupPlans(report.plans ?? []);
  if (groups.length === 0) return '';
  const rows = groups
    .map(
      (g) =>
        `<tr><td style="${TD_CENTER}">${escapeHtml(g.label)}</td>` +
        `<td style="${TD_BASE}">${g.texts.map(escapeHtml).join('<br/>')}</td></tr>`,
    )
    .join('');
  const width = COL_WIDTHS.date + 400;
  return (
    `\n${buildPlanHtmlTitle(report.currentWeekRange)}` +
    `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:${BORDER};width:${width}px;table-layout:fixed;">` +
    `<colgroup><col style="width:${COL_WIDTHS.date}px"/><col/></colgroup><tbody>${rows}</tbody></table>`
  );
}

export function renderPlain(report: WeekReport, options: RenderOptions = {}): string {
  const head = buildPlainHeader(report.prevWeekRange);
  const headerRow = ['일자', '지원장소', '고객사|작업구분', '내용', '기타'].join('\t');
  const rows: string[] = [];

  // 쓰지 않은 골격(빈 항목·빈 행·빈 턴)은 출력하지 않는다
  for (const day of pruneBlank(report).days) {
    if (day.holiday) {
      rows.push([formatDateLabel(day), '', '', day.holiday.reason.trim(), ''].join('\t'));
      continue;
    }
    const dateLabelPlain = day.partial
      ? `${formatDateLabel(day)} ${day.partial.label.trim() || '반차'}`
      : formatDateLabel(day);
    if (day.blocks.length === 0) {
      rows.push([dateLabelPlain, '', '', '', FILL].join('\t'));
      continue;
    }
    day.blocks.forEach((block, idx) => {
      const date = idx === 0 ? dateLabelPlain : '';
      const loc = block.locations.join('\n');
      const customer = block.customer
        ? block.customer.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean).join('\n')
        : '';
      const content = block.items
        .map((item) => {
          const summaryLine = formatItemHeader(item);
          const body = item.content
            .map(renderContentBlockPlain)
            .filter((s) => s.length > 0)
            .join('\n');
          return body ? `${summaryLine}\n${body}` : summaryLine;
        })
        .filter((s) => s.length > 0)
        .join('\n\n');
      rows.push([date, loc, customer, content, FILL].join('\t'));
    });
  }

  let out = `${head}\n\n${headerRow}\n${rows.join('\n')}`;
  if (options.includePlan !== false) {
    const groups = groupPlans(report.plans ?? []);
    if (groups.length > 0) {
      out += `\n\n${buildPlanTitle(report.currentWeekRange)}\n${groups
        .map((g) => `${g.label}\t${g.texts.join(' / ')}`)
        .join('\n')}`;
    }
  }
  return out;
}

function renderContentBlockPlain(block: ContentBlock): string {
  const p = '  '.repeat(block.indent ?? 0);
  switch (block.kind) {
    case 'numbered': {
      const detail = block.details
        .map((d) => `${p}${isNoteLine(d) ? `> ${noteText(d)}` : `- ${d}`}`)
        .join('\n');
      return `${p}${block.index}) ${block.title}${detail ? `\n${detail}` : ''}`;
    }
    case 'dialog':
      return block.turns
        .map((t) => `${p}${turnMarker(t)} ${t.text.split('\n').join(`\n${p}  `)}`)
        .join('\n');
    case 'bullets':
      return block.items.map((b) => `${p}${isNoteLine(b) ? `> ${noteText(b)}` : `- ${b}`}`).join('\n');
  }
}

export interface CombinedResult extends RenderResult {
  subject: string;
  /** 합본에 들어간 주 수 */
  weeks: number;
}

/**
 * 다주 합본 — 최근 주가 맨 위, 일정 예정은 최근 주에만 (docs §1). 같은 보고 주는 앞의 것만 남긴다.
 * 제목 범위는 가장 오래된 주 시작 ~ 가장 최근 주 끝.
 */
export function renderCombined(reports: readonly WeekReport[]): CombinedResult {
  const seen = new Set<string>();
  const unique = reports.filter((r) => {
    const key = r.prevWeekRange.start;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = [...unique].sort((a, b) => b.prevWeekRange.start.localeCompare(a.prevWeekRange.start));
  const spacer = `\n<p style="margin:0;">&nbsp;</p><p style="margin:0;">&nbsp;</p>\n`;
  const html = sorted.map((r, i) => renderHtml(r, { includePlan: i === 0 })).join(spacer);
  const plain = sorted.map((r, i) => renderPlain(r, { includePlan: i === 0 })).join('\n\n\n');
  const subject =
    sorted.length === 1 ? buildSubject(sorted[0].prevWeekRange) : buildCombinedSubject(sorted.map((r) => r.prevWeekRange));
  return { html, plain, subject, weeks: sorted.length };
}
