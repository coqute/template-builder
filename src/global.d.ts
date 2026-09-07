import type { ReportApi } from '../electron/preload';

declare global {
  interface Window {
    reportApi?: ReportApi;
  }
  /** package.json version — vite.config/vitest.config의 define으로 주입 (도움말 하단 표기) */
  const __APP_VERSION__: string;
}

export {};
