import type { DateRange } from '../types';

export function formatDotDate(iso: string): string {
  return iso.replace(/-/g, '.');
}

export function formatRangeDot(range: DateRange): string {
  return `${formatDotDate(range.start)}~ ${formatDotDate(range.end)}`;
}

/** 메일 제목 — 보고 대상 주(지난 주, @PREV) 기준 */
export function buildSubject(prevWeekRange: DateRange, authorName: string): string {
  return `[${formatDotDate(prevWeekRange.start)} ~ ${formatDotDate(prevWeekRange.end)}] ${authorName} 주간보고서`;
}

/** 본문 □ Date — 보고 대상 주(지난 주, @PREV) 기준 — 제목과 동일 주차 */
export function buildPlainHeader(prevWeekRange: DateRange): string {
  return `■ 주간 보고서\n\n□ Date : ${formatRangeDot(prevWeekRange)}`;
}

export function buildHtmlHeader(prevWeekRange: DateRange): string {
  return [
    `<p style="margin:0 0 12px;font-family:'Malgun Gothic','맑은 고딕',sans-serif;">■ 주간 보고서</p>`,
    `<p style="margin:0 0 16px;font-family:'Malgun Gothic','맑은 고딕',sans-serif;">□ Date : ${formatRangeDot(prevWeekRange)}</p>`,
  ].join('\n');
}
