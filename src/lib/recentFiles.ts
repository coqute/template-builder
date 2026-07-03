/** 최근 파일 목록 — localStorage 기반 MRU (최대 5개). App/Toolbar가 공유 */

const KEY = 'tb:recent-files:v1';
export const MAX_RECENT_FILES = 5;

export function loadRecentFiles(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FILES);
  } catch {
    return [];
  }
}

function persist(list: string[]): string[] {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      // quota 등 — 목록 유실은 치명적이지 않음
    }
  }
  return list;
}

/** 맨 앞 삽입 + 중복 제거 + 상한 유지. 갱신된 목록 반환 */
export function pushRecentFile(path: string): string[] {
  const rest = loadRecentFiles().filter((p) => p !== path);
  return persist([path, ...rest].slice(0, MAX_RECENT_FILES));
}

/** 목록에서 제거 (파일 삭제/이동으로 열기 실패 시). 갱신된 목록 반환 */
export function removeRecentFile(path: string): string[] {
  return persist(loadRecentFiles().filter((p) => p !== path));
}

export function fileBaseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
