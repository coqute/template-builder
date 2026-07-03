import { useCallback, useEffect, useState } from 'react';
import { readWithFallback } from '../lib/storage';

const KEY = 'tb:author';
const LEGACY_KEY = 'weekly-report-builder:author';
const DEFAULT_AUTHOR = '박민수';

export function useAuthor(): {
  author: string;
  setAuthor: (next: string) => void;
} {
  const [author, setAuthorState] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return DEFAULT_AUTHOR;
    return readWithFallback(KEY, LEGACY_KEY) ?? DEFAULT_AUTHOR;
  });

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, author);
  }, [author]);

  const setAuthor = useCallback((next: string) => {
    const trimmed = next.trim();
    setAuthorState(trimmed || DEFAULT_AUTHOR);
  }, []);

  return { author, setAuthor };
}
