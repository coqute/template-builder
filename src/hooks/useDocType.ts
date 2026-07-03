import { useCallback, useEffect, useState } from 'react';

export type DocType = 'weekly' | 'email';

const KEY = 'tb:doc-type';

function loadDocType(): DocType {
  if (typeof localStorage === 'undefined') return 'weekly';
  const v = localStorage.getItem(KEY);
  return v === 'email' ? 'email' : 'weekly';
}

export function useDocType(): { docType: DocType; setDocType: (next: DocType) => void } {
  const [docType, setDocTypeState] = useState<DocType>(loadDocType);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, docType);
    }
  }, [docType]);

  const setDocType = useCallback((next: DocType) => setDocTypeState(next), []);
  return { docType, setDocType };
}
