import { getWeekday, type Weekday } from '@core/index';

export interface BuildTemplateOptions {
  authorName?: string;
  baseDate?: Date;
}

const WEEKDAY_LABELS: ReadonlyArray<Weekday> = ['월', '화', '수', '목', '금'];

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

export function buildWeeklyTemplate(options: BuildTemplateOptions = {}): TemplateResult {
  const base = options.baseDate ?? new Date();
  // 작성 시점의 이번 주 (월~금) — @CURRENT
  const currentMonday = mondayOf(base);
  const currentFriday = addDays(currentMonday, 4);
  // 보고 대상 = 지난 주 (월~일) — @PREV
  const prevMonday = addDays(currentMonday, -7);
  const prevSunday = addDays(prevMonday, 6);

  const prevStart = isoDate(prevMonday);
  const prevEnd = isoDate(prevSunday);
  const currentStart = isoDate(currentMonday);
  const currentEnd = isoDate(currentFriday);

  const author = (options.authorName ?? '').trim() || '작성자';

  const lines: string[] = [
    `@PREV ${prevStart} ~ ${prevEnd}`,
    `@CURRENT ${currentStart} ~ ${currentEnd}`,
    `@AUTHOR ${author}`,
    '',
  ];

  // 일자 행은 보고 대상 주(지난 주) 월~금 5일
  WEEKDAY_LABELS.forEach((label, idx) => {
    const day = addDays(prevMonday, idx);
    const iso = isoDate(day);
    const wd = getWeekday(iso);
    const heading = `# ${iso}(${wd})`;
    lines.push(heading);
    lines.push('@LOC ');
    lines.push('@CUS ');
    lines.push('@SUM [고객사] (담당자) 작업 설명');
    lines.push('1) ');
    lines.push('- ');
    lines.push('');
    void label;
  });

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return {
    md: `${lines.join('\n')}\n`,
    prevStart,
    prevEnd,
  };
}
