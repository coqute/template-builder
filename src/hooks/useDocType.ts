import { useCallback, useEffect, useState } from 'react';
import { safeSetItem } from '../lib/storage';

/** 문서 타입 id — doctypes 레지스트리의 모듈 id (플러그인 개방형이라 string) */
export type DocType = string;

const KEY = 'tb:doc-type';
/** 시작 화면 — 'home'(기본: 켤 때 늘 홈) · 'last'(마지막으로 보던 화면) */
const START_KEY = 'tb:start:v1';
/** 홈 화면의 id — 탭 줄에는 없고 로고가 이 화면으로 간다 */
export const HOME_ID = 'home';

export type StartMode = 'home' | 'last';

export function loadStartMode(): StartMode {
  if (typeof localStorage === 'undefined') return 'home';
  return localStorage.getItem(START_KEY) === 'last' ? 'last' : 'home';
}

export function saveStartMode(mode: StartMode): void {
  safeSetItem(START_KEY, mode);
}

export function useDocType(validIds: readonly string[]): {
  docType: DocType;
  setDocType: (next: DocType) => void;
} {
  const [docType, setDocTypeState] = useState<DocType>(() => {
    const fallback = validIds[0] ?? 'weekly';
    if (typeof localStorage === 'undefined') return fallback;
    const v = localStorage.getItem(KEY);
    const last = v && validIds.includes(v) ? v : null;
    // 홈이 등록돼 있으면 켤 때 늘 홈으로 연다 — 설정에서 "마지막으로 보던 화면"을 고른 경우만 예전처럼
    if (validIds.includes(HOME_ID) && !(loadStartMode() === 'last' && last)) return HOME_ID;
    return last ?? fallback;
  });

  useEffect(() => {
    safeSetItem(KEY, docType);
  }, [docType]);

  const setDocType = useCallback(
    (next: DocType) => {
      if (validIds.includes(next)) setDocTypeState(next);
    },
    // validIds는 레지스트리 상수에서 파생 — 내용 불변
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return { docType, setDocType };
}
