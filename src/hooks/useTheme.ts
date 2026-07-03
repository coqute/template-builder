import { useCallback, useEffect, useState } from 'react';
import { readWithFallback } from '../lib/storage';

export type Theme = 'paper' | 'mono';

const KEY = 'tb:theme';
const LEGACY_KEY = 'weekly-report-builder:theme';
const DEFAULT_THEME: Theme = 'paper';

function readInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const ds = (document.documentElement.dataset.theme ?? '').toLowerCase();
    if (ds === 'mono' || ds === 'paper') return ds;
  }
  if (typeof localStorage !== 'undefined') {
    const stored = readWithFallback(KEY, LEGACY_KEY);
    if (stored === 'mono' || stored === 'paper') return stored;
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) return 'mono';
  }
  return DEFAULT_THEME;
}

export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, theme);
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === 'paper' ? 'mono' : 'paper'));
  }, []);

  return { theme, setTheme, toggle };
}
