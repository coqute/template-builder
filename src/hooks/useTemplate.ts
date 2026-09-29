import { getWeekday } from '@core/index';

export interface BuildTemplateOptions {
  authorName?: string;
  baseDate?: Date;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mondayOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(d.getDate() + n);
  return next;
}

export interface TemplateResult {
  md: string;
  prevStart: string;
  prevEnd: string;
}

/**
 * 지난 주(보고 대상) 빈 템플릿 — 주간보고 형식 명세 §2~4
 * - @PREV = 지난 주 월~일, @CURRENT = 이번 주 월~일 (□ 일정 예정 범위)
 * - 월~일 7행 모두 표기. 평일은 빈 골격(행·항목·대화 턴 ->/<-), 토·일은 휴일(@HOLIDAY — 업무 없음, 빨간 행)
 * 골격은 값이 아니라 빈 자리다 — 비주얼에서는 안내 문구가 보이고, 쓰지 않으면 출력·검증에서 빠진다 (core/blank.ts).
 * 직렬화기가 빈 골격 행을 쓰는 형태와 같게 둬서, 첫 편집 뒤에도 .md가 바뀌지 않는다.
 */
export function buildWeeklyTemplate(options: BuildTemplateOptions = {}): TemplateResult {
  const base = options.baseDate ?? new Date();
  const currentMonday = mondayOf(base);
  const prevMonday = addDays(currentMonday, -7);

  const prevStart = isoDate(prevMonday);
  const prevEnd = isoDate(addDays(prevMonday, 6));
  const currentStart = isoDate(currentMonday);
  const currentEnd = isoDate(addDays(currentMonday, 6));

  const author = (options.authorName ?? '').trim() || '작성자';

  const lines: string[] = [
    `@PREV ${prevStart} ~ ${prevEnd}`,
    `@CURRENT ${currentStart} ~ ${currentEnd}`,
    `@AUTHOR ${author}`,
    '',
  ];

  for (let idx = 0; idx < 7; idx++) {
    const iso = isoDate(addDays(prevMonday, idx));
    const wd = getWeekday(iso);
    lines.push(`# ${iso}(${wd})`);
    if (idx < 5) {
      lines.push('@LOC');
      lines.push('@CUS');
      lines.push('@SUM');
      lines.push('  ->');
      lines.push('  <-');
    } else {
      lines.push('@HOLIDAY');
    }
    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return {
    md: `${lines.join('\n')}\n`,
    prevStart,
    prevEnd,
  };
}
