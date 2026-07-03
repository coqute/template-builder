import type { ReportApi } from '../electron/preload';

declare global {
  interface Window {
    reportApi?: ReportApi;
  }
}

export {};
