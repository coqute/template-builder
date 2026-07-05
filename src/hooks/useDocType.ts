import { useCallback, useEffect, useState } from 'react';

/** 문서 타입 id — doctypes 레지스트리의 모듈 id (플러그인 개방형이라 string) */
export type DocType = string;

const KEY = 'tb:doc-type';

export function useDocType(validIds: readonly string[]): {
  docType: DocType;
  setDocType: (next: DocType) => void;
} {
  const [docType, setDocTypeState] = useState<DocType>(() => {
    const fallback = validIds[0] ?? 'weekly';
    if (typeof localStorage === 'undefined') return fallback;
    const v = localStorage.getItem(KEY);
    return v && validIds.includes(v) ? v : fallback;
  });

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, docType);
    }
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
