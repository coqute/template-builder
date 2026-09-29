/**
 * 메일 제목·머리말 규격 — 주간보고 형식 명세 §1~2
 *   제목  : [2026. 09. 21 ~ 2026. 09. 27] 주간보고
 *   머리말: ■ 주간 보고 / □ Date : 2026. 09. 21 ~ 2026. 09. 27
 *   일정  : □ 일정 예정 (2026. 09. 28 ~ 2026. 10. 04)
 */
import type { DateRange } from '../types';

const MAIL_P = `font-family:'Malgun Gothic','맑은 고딕',sans-serif;`;

/** `2026-09-07` → `2026. 09. 07` (점 뒤 공백, 두 자리 월·일) */
export function formatDotDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[1]}. ${m[2]}. ${m[3]}` : iso;
}

export function formatRangeDot(range: DateRange): string {
  return `${formatDotDate(range.start)} ~ ${formatDotDate(range.end)}`;
}

/** 메일 제목 — 보고 대상 주 기준. 작성자는 발신자로 식별되므로 제목에 넣지 않는다 (D2) */
export function buildSubject(prevWeekRange: DateRange): string {
  return `[${formatRangeDot(prevWeekRange)}] 주간보고`;
}

/** 다주 합본 제목 — 가장 오래된 주 시작 ~ 가장 최근 주 끝 */
export function buildCombinedSubject(ranges: readonly DateRange[]): string {
  if (ranges.length === 0) return '';
  const starts = ranges.map((r) => r.start).sort();
  const ends = ranges.map((r) => r.end).sort();
  return buildSubject({ start: starts[0], end: ends[ends.length - 1] });
}

export function buildPlainHeader(prevWeekRange: DateRange): string {
  return `■ 주간 보고\n\n□ Date : ${formatRangeDot(prevWeekRange)}`;
}

export function buildHtmlHeader(prevWeekRange: DateRange): string {
  return [
    `<p style="margin:0 0 12px;${MAIL_P}">■ 주간 보고</p>`,
    `<p style="margin:0 0 16px;${MAIL_P}">□ Date : ${formatRangeDot(prevWeekRange)}</p>`,
  ].join('\n');
}

export function buildPlanTitle(currentWeekRange: DateRange): string {
  return `□ 일정 예정 (${formatRangeDot(currentWeekRange)})`;
}

export function buildPlanHtmlTitle(currentWeekRange: DateRange): string {
  return `<p style="margin:18px 0 10px;${MAIL_P}">${buildPlanTitle(currentWeekRange)}</p>`;
}
