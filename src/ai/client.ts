/** AI 호출 한 건 — renderer 쪽 진입점. 진행 상황을 받고, 도중에 멈출 수 있다. */
import type { AiCompleteRequest, AiCompleteResult, AiProgress } from '../../electron/ai-types';
import { modelLabel } from './settings';

export interface AiRun {
  id: string;
  /** 실패도 { ok: false }로 돌려준다(던지지 않는다) */
  promise: Promise<AiCompleteResult>;
  /** 진행 중인 요청을 멈춘다 — promise는 code 'canceled'로 끝난다 */
  cancel: () => void;
}

let seq = 0;

export function startAi(req: AiCompleteRequest, onProgress?: (p: AiProgress) => void): AiRun {
  const api = typeof window === 'undefined' ? undefined : window.reportApi;
  const id = `ai-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  if (!api?.aiComplete) {
    return {
      id,
      promise: Promise.resolve({ ok: false, code: 'error', message: 'AI 기능은 데스크톱 앱에서만 쓸 수 있습니다.' }),
      cancel: () => {},
    };
  }
  const off = onProgress && api.onAiProgress ? api.onAiProgress((p) => p.id === id && onProgress(p)) : undefined;
  const promise = api
    .aiComplete({ ...req, id })
    .catch((err: unknown): AiCompleteResult => ({ ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) }))
    .finally(() => off?.());
  return { id, promise, cancel: () => void api.aiCancel?.(id) };
}

/** 진행 상황 한 줄 — "생각하는 중", "쓰는 중 · 3,120자" */
export function progressText(p: Pick<AiProgress, 'phase' | 'chars' | 'model'> | null): string {
  if (!p || p.phase === 'connecting') return '연결하는 중';
  if (p.phase === 'retry') return '응답이 길어 한도를 올려 다시 요청하는 중';
  const by = p.model ? `${modelLabel(p.model)}(대체 모델) ` : '';
  if (p.phase === 'fallback') return `${by}이어 받는 중`;
  if (p.phase === 'thinking') return `${by}생각하는 중`;
  return `${by}쓰는 중 · ${p.chars.toLocaleString()}자`;
}

/** 지난 시간 — "42초", "2분 05초" */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
}
