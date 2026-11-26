/**
 * AI 결과에 붙는 공통 정보와 검증 — 주간보고 정돈·대화 → 블록·서술 → 글이 같은 것을 따로 조립하고 있었다(v0.27.0에서 하나로).
 */
import type { AiCompleteResult, AiUsage } from '../../electron/ai-types';
import { missingFacts, tokensOf, type Masker } from './mask';
import { estimateUsd } from './settings';

/** 성공한 응답 */
export type OkResult = Extract<AiCompleteResult, { ok: true }>;

/** 확인 창·결과 창에 보여 주는 정보 — 어떤 모델이 얼마에 몇 초 걸려 답했고, 보내기 전에 무엇을 가렸나 */
export interface AiMeta {
  model: string;
  usage: AiUsage;
  usd: number;
  ms: number;
  /** 고른 모델이 거부해 대체 모델이 이어 받았다 */
  fallbackUsed: boolean;
  /** 종류별 가린 개수 */
  masked: Record<string, number>;
}

export function aiMeta(res: OkResult, masker: Masker): AiMeta {
  return { model: res.model, usage: res.usage, usd: estimateUsd(res.model, res.usage), ms: res.ms, fallbackUsed: res.fallbackUsed, masked: masker.summary() };
}

/**
 * 돌아온 글이 보낸 글에 없는 것을 지어냈는가 — 보낸 글에 없는 숫자·버전과, 보낸 적 없는 자리표시.
 * 경고 문구는 쓰는 쪽이 만든다(무엇을 "대화"·"서술"이라 부르는지가 다르다).
 */
export function inventedIn(text: string, sent: string, known: ReadonlySet<string>): { numbers: string[]; tokens: string[] } {
  return { numbers: missingFacts(text, sent), tokens: [...new Set(tokensOf(text).filter((t) => !known.has(t)))] };
}
