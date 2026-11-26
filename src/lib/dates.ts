/**
 * 날짜 계산의 한 벌 — 모두 이 컴퓨터의 날짜(YYYY-MM-DD) 기준이다(UTC가 아니다: 한국 시간 09시 전에 UTC 날짜는 어제다).
 * 같은 계산(날짜 → 글, 날짜 더하기, 그 주 월요일, 요일)이 화면·문법·main에 열두 번 따로 적혀 있던 것을 모았다(v0.27.0).
 * 다른 모듈을 import하지 않는다 — renderer·main·플래너 도구가 모두 가져다 쓴다.
 */

/** 요일 한 글자 — `Date.getDay()` 순서(일요일이 0) */
export const DOW = '일월화수목금토';

const p2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` → 그날 자정(이 컴퓨터 시간대). 없는 날짜(2/30)는 다음 달로 넘어간다 — 검사가 필요하면 core의 isRealIsoDate를 쓴다 */
export function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 날짜 → `YYYY-MM-DD` */
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

/** 그 주 월요일 (주는 월요일에 시작한다) */
export function mondayOf(iso: string): string {
  return addDays(iso, -((toDate(iso).getDay() + 6) % 7));
}

/** 요일 한 글자 — 날짜가 아니면 undefined */
export function dowOf(iso: string): string {
  return DOW[toDate(iso).getDay()];
}
