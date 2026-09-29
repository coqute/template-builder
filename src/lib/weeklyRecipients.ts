/**
 * 주간보고 발송 설정 — 임시보관함 초안의 받는사람·참조 (예: 팀장 / 팀 공용 주소).
 * 개인 식별 주소라 코드에 두지 않고 사용자 로컬 저장소에만 둔다.
 */
import { safeSetItem } from './storage';

const KEY = 'tb:weekly-recipients:v1';

export interface WeeklyRecipients {
  /** 받는사람 — 쉼표 구분 */
  to: string;
  /** 참조 — 쉼표 구분 */
  cc: string;
}

export function loadWeeklyRecipients(): WeeklyRecipients {
  try {
    if (typeof localStorage === 'undefined') return { to: '', cc: '' };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { to: '', cc: '' };
    const p = JSON.parse(raw) as Partial<WeeklyRecipients>;
    return { to: typeof p.to === 'string' ? p.to : '', cc: typeof p.cc === 'string' ? p.cc : '' };
  } catch {
    return { to: '', cc: '' };
  }
}

export function saveWeeklyRecipients(r: WeeklyRecipients): void {
  safeSetItem(KEY, JSON.stringify({ to: r.to.trim(), cc: r.cc.trim() }));
}
