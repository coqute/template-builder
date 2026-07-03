/**
 * localStorage 키 마이그레이션 — 신키 `tb:*`로 통일하되 구키 `weekly-report-builder:*`를
 * 읽기 폴백으로 보존(기존 사용자 초안/설정 유실 방지).
 */

/** 신키 → 구키 읽기 폴백. 첫 쓰기부터 신키로 저장된다. */
export function readWithFallback(newKey: string, legacyKey: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(newKey);
  if (v != null) return v;
  return localStorage.getItem(legacyKey);
}
