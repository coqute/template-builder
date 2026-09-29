/**
 * 지난주 미결 이월 목록 보관 — 보고 주(@PREV 시작일)별 1벌.
 * .md에 넣지 않으므로 앱을 다시 켜도 같은 주 보고서를 열면 목록이 다시 보인다.
 */
import type { CarryItem } from '@core/index';
import { safeRemoveItem, safeSetItem } from './storage';

const KEY = 'tb:carry:v1';

export interface CarryList {
  /** 대상 보고 주 — 새 주간보고의 @PREV 시작일 */
  week: string;
  /** 어디서 가져왔는지 (파일명 또는 "현재 초안") */
  from: string;
  items: CarryItem[];
}

export function loadCarry(week: string): CarryList | null {
  if (typeof localStorage === 'undefined' || !week) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CarryList;
    if (parsed.week !== week || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCarry(list: CarryList): void {
  if (list.items.length === 0) {
    safeRemoveItem(KEY);
    return;
  }
  safeSetItem(KEY, JSON.stringify(list));
}

/** 이어 썼거나 닫은 항목을 목록에서 뺀다 — 남은 목록 반환 */
export function dropCarry(week: string, index: number): CarryList | null {
  const cur = loadCarry(week);
  if (!cur) return null;
  const next = { ...cur, items: cur.items.filter((_, i) => i !== index) };
  saveCarry(next);
  return next.items.length > 0 ? next : null;
}

export function clearCarry(): void {
  safeRemoveItem(KEY);
}
