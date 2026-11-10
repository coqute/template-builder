/**
 * 고객사 표기 규칙 단일 소스 — 검증기(validator)와 비주얼 편집의 자동 채움(edit)이 함께 쓴다.
 *
 * 고객사|작업구분 칸에는 두 가지 쓰임이 있다 (주간보고 형식 명세 §3.2).
 * - 고객사 이름: `MX`, `제트플러스`, `AB Z+` — 항목 `[고객사]`와 같아야 한다.
 * - 고객사 안의 팀·부서: `한강 SRE`, `IT 인프라`, `한강 관제 개발팀 / (네트워크 부문)` — 항목은 `[AB Z+]`처럼 고객사를 쓴다.
 * 그래서 이 칸을 항목과 비교하는 것은 칸의 값이 고객사 이름일 때만이다.
 */
import type { LocationBlock, WeekReport } from './types';
import { WORK_CATEGORIES } from './types';
import { site } from './site-config';

/**
 * 같은 고객사의 다른 표기 — 비교할 때 하나로 모은다. 표기 목록은 site-config.ts(실제 값은 그 파일에만).
 * 예: AB Z+ = ABZ+ = AB제트플러스 = 제트플러스 = Z+ (표준 표기는 `AB Z+`)
 */

/** 비교 키 — 공백·슬래시·가운뎃점·점 제거, 소문자, 별칭 통일 (`다솜/라이프` = `다솜라이프`, `ABZ+` = `AB Z+`) */
export function customerKey(s: string): string {
  let k = s.replace(/[\s/·.]/g, '').toLowerCase();
  for (const a of site().customers) {
    a.pattern.lastIndex = 0;
    k = k.replace(a.pattern, a.key);
  }
  return k;
}

/** 고객사 표준 표기 — `ABZ+`·`제트플러스`·`AB제트플러스` → `AB Z+`. 모르는 고객사·팀명(`AB Z+ 북악`)은 그대로 */
export function canonicalClient(s: string): string {
  const t = s.trim();
  const k = customerKey(t);
  return site().customers.find((a) => a.key === k)?.canonical ?? t;
}


export function sameCustomer(a: string, b: string): boolean {
  const x = customerKey(a);
  return !!x && x === customerKey(b);
}

/** 한 글자 차이(바꿈·넣기·빼기) — `제조사분의` ↔ `제조사문의` 같은 오타 */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === t[i]) i++;
  if (s.length === t.length) return s.slice(i + 1) === t.slice(i + 1);
  return s.slice(i) === t.slice(i + 1);
}

/** 항목 머리에 쓰인 고객사 — 키 → 표기별 횟수 */
export function knownClients(report: WeekReport): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const d of report.days)
    for (const b of d.blocks)
      for (const it of b.items) {
        const c = it.client.trim();
        const k = customerKey(c);
        if (!k || k === '-') continue;
        const m = out.get(k) ?? new Map<string, number>();
        m.set(c, (m.get(c) ?? 0) + 1);
        out.set(k, m);
      }
  return out;
}

function mostUsed(m: Map<string, number> | undefined): string {
  if (!m) return '';
  let best = '';
  let n = 0;
  for (const [s, c] of m) if (c > n) [best, n] = [s, c];
  return best;
}

export type RowCustomerCheck =
  /** 칸이 비었거나 팀·부서 같은 자유 값 — 비교하지 않는다 */
  | { kind: 'skip' }
  /** 칸이 고객사 이름 — 다른 고객사 항목 */
  | { kind: 'mismatch'; clients: string[] }
  /** 칸이 고객사·작업구분과 한 글자 다르다 — 오타로 보인다 */
  | { kind: 'typo'; near: string };

/**
 * 행의 고객사|작업구분과 그 행 항목 `[고객사]`의 관계.
 * @param known 보고서 전체의 항목 고객사 (knownClients)
 */
export function checkRowCustomer(block: Pick<LocationBlock, 'customer'>, clients: readonly string[], known: Map<string, Map<string, number>>): RowCustomerCheck {
  const row = block.customer.trim();
  const k = customerKey(row);
  if (!k) return { kind: 'skip' };
  if (known.has(k) || WORK_CATEGORIES.some((w) => customerKey(w) === k)) {
    const bad = [...new Set(clients.map((c) => c.trim()).filter((c) => c && !sameCustomer(row, c)))];
    return bad.length ? { kind: 'mismatch', clients: bad } : { kind: 'skip' };
  }
  // 고객사 이름이 아니면 팀·부서명이다. 다만 아는 값과 한 글자만 다르면 오타로 본다 (세 글자 이상만)
  if (k.length >= 3) {
    const candidates = [...[...known.values()].map(mostUsed), ...WORK_CATEGORIES];
    const near = candidates.find((c) => oneEditApart(k, customerKey(c)));
    if (near) return { kind: 'typo', near };
  }
  return { kind: 'skip' };
}

/** 고객사|작업구분 칸을 팀·부서로 쓰는 보고서인가 — 항목이 있는 행 중 칸 값과 항목 고객사가 다른 행이 더 많으면 */
function teamStyle(report: WeekReport): boolean {
  let team = 0;
  let customer = 0;
  for (const d of report.days)
    for (const b of d.blocks) {
      const row = b.customer.trim();
      if (!row || WORK_CATEGORIES.includes(row)) continue;
      const clients = b.items.map((it) => it.client.trim()).filter(Boolean);
      if (!clients.length) continue;
      if (clients.some((c) => sameCustomer(row, c))) customer++;
      else team++;
    }
  return team > customer;
}

/**
 * 행의 빈 항목에 채울 고객사 — 비주얼 편집에서 행을 쓰거나 항목을 더할 때.
 * 1. 칸 값이 이 보고서 항목에 쓰인 고객사면 그 표기 (`제트플러스` → 보고서가 쓴 `AB Z+`)
 * 2. 이 보고서에서 같은 칸 값 아래(이 행 포함) 쓴 항목 고객사 (`한강 SRE` 행 → `AB Z+`)
 * 3. 칸에 팀·부서를 쓰는 보고서면 비워 둔다(모르는 팀에 팀명을 고객사로 넣지 않는다), 아니면 칸 값 그대로
 * 제조사문의·미팅·테스트 같은 작업구분은 고객사가 아니므로 채우지 않는다.
 */
export function clientForRow(report: WeekReport, block: Pick<LocationBlock, 'customer'>): string {
  const row = block.customer.trim();
  if (!row || WORK_CATEGORIES.includes(row)) return '';
  const k = customerKey(row);
  const known = knownClients(report);
  if (known.has(k)) return mostUsed(known.get(k));
  const learned = new Map<string, number>();
  for (const d of report.days)
    for (const b of d.blocks) {
      if (customerKey(b.customer) !== k) continue;
      for (const it of b.items) {
        const c = it.client.trim();
        if (c && c !== '-') learned.set(c, (learned.get(c) ?? 0) + 1);
      }
    }
  const fromRows = mostUsed(learned);
  if (fromRows) return fromRows;
  return teamStyle(report) ? '' : row;
}
