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

/**
 * 예외 없는 쓰기 — QuotaExceededError(큰 이미지가 다른 키를 채운 경우 등)·접근 차단을 삼킨다.
 * React effect 안에서 던져지면 ErrorBoundary가 없어 앱 전체가 언마운트되므로 모든 setItem은 이 함수를 경유한다.
 * @returns 저장 성공 여부 — 호출부가 1회성 경고 토스트 등에 사용
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return true; // 저장소 없는 환경(테스트 등) — 실패로 취급하지 않음
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
