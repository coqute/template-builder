/** AI 정돈 확인 창의 공용 모델 — 주간보고·작업일지 모두 "바뀔 곳 목록"으로 보여 주고 고른 것만 적용한다. */
import type { AiUsage } from '../../electron/ai-types';

export interface ReviewChange {
  id: string;
  /** 묶음 머리 — 주간보고는 항목 머리, 이메일은 '칸' / '본문' */
  group: string;
  /** 줄 이름 — '제목', '-> 상대', '도입 문장' … */
  label: string;
  before: string;
  after: string;
  /** before/after가 HTML(이메일 본문) */
  html?: boolean;
  /** 검증 통과 — false면 적용할 수 없고 reason을 보여 준다 */
  ok: boolean;
  reason?: string;
}

export interface ReviewNote {
  group: string;
  text: string;
}

export interface ReviewData {
  changes: ReviewChange[];
  notes: ReviewNote[];
  model: string;
  usage: AiUsage;
  usd: number;
  ms: number;
  fallbackUsed: boolean;
  /** 종류별 가린 개수 */
  masked: Record<string, number>;
}

/** 확인 창에 보여 줄 가림 요약 — "IP 2 · URL 1" */
export function maskedSummary(masked: Record<string, number>): string {
  const names: Record<string, string> = { IP: 'IP', URL: 'URL', MAIL: '메일 주소', TEL: '전화번호', KEY: '키·라이선스', P: '사람 이름', IMG: '이미지', TABLE: '표', CODE: '코드 블록' };
  const parts = Object.entries(masked)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${names[k] ?? k} ${n}`);
  return parts.join(', ');
}
