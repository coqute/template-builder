/** 플래너 날짜 계산 — 모두 이 컴퓨터의 날짜(YYYY-MM-DD) 기준 */

export const DOW = '일월화수목금토';

const p2 = (n: number) => String(n).padStart(2, '0');

export function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function todayIso(now = new Date()): string {
  return isoOf(now);
}

export function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

/** b − a (일) */
export function diffDays(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

/** 그 주 월요일 */
export function mondayOf(iso: string): string {
  return addDays(iso, -((toDate(iso).getDay() + 6) % 7));
}

export function dowOf(iso: string): string {
  return DOW[toDate(iso).getDay()];
}

export function isWeekend(iso: string): boolean {
  const d = toDate(iso).getDay();
  return d === 0 || d === 6;
}

/** `11/25` */
export function md(iso: string): string {
  const d = toDate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** `11/25 (수)` */
export function mdw(iso: string): string {
  return `${md(iso)} (${dowOf(iso)})`;
}

/** 오늘에서 본 그날 — 오늘 · 내일 · 어제 · n일 뒤 · n일 전. 기한이 아니라 날짜를 말할 때 쓴다(기한은 relDay — "n일 지남") */
export function dayFromToday(today: string, iso: string): string {
  const d = diffDays(today, iso);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === -1) return '어제';
  return d > 0 ? `${d}일 뒤` : `${-d}일 전`;
}

/** 오늘 · 내일 · n일 뒤 · n일 지남 */
export function relDay(today: string, iso: string): string {
  const n = diffDays(today, iso);
  return n === 0 ? '오늘' : n === 1 ? '내일' : n > 0 ? `${n}일 뒤` : `${-n}일 지남`;
}

/**
 * `M/D` → 기준일 이후(같은 날 포함) 가장 가까운 날짜. 없는 날짜(2/30)는 null.
 * 기준일보다 앞선 날짜는 다음 해로 본다 — 12월에 적은 `1/5`는 내년 1월 5일이다.
 */
export function resolveMonthDay(month: number, day: number, base: string): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = Number(base.slice(0, 4));
  for (const yy of [y, y + 1]) {
    const d = new Date(yy, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) continue;
    const iso = isoOf(d);
    if (iso >= base) return iso;
  }
  return null;
}

/** 빠른 입력 — 끝의 `11/27`을 기한으로 읽고 제목에서 뗀다 */
export function parseQuickAdd(input: string, today: string): { title: string; due: string | null } {
  const text = input.replace(/\s+/g, ' ').trim();
  const m = /(?:^|\s)(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (m) {
    const due = resolveMonthDay(Number(m[1]), Number(m[2]), today);
    const title = text.slice(0, m.index).trim();
    if (due && title) return { title, due };
  }
  return { title: text, due: null };
}

/** 시간대가 붙은 ISO 시각 → 이 컴퓨터의 날짜와 `HH:MM` */
export function localParts(isoDateTime: string): { date: string; time: string } {
  const d = new Date(isoDateTime);
  if (Number.isNaN(d.getTime())) return { date: isoDateTime.slice(0, 10), time: '' };
  return { date: isoOf(d), time: `${p2(d.getHours())}:${p2(d.getMinutes())}` };
}

/** `09:41` */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
