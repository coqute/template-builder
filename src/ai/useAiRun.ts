import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiCompleteRequest, AiCompleteResult, AiProgress } from '../../electron/ai-types';
import { startAi, type AiRun } from './client';

export interface AiBusy {
  label: string;
  startedAt: number;
  progress: AiProgress | null;
}

/**
 * AI 요청 하나의 화면 상태 — 호출 중 표시(라벨·진행·지난 시간)와 취소.
 * call은 한 번에 하나만 돈다. 화면이 사라지면 진행 중인 요청을 멈춘다.
 */
export function useAiRun() {
  const [busy, setBusy] = useState<AiBusy | null>(null);
  const current = useRef<AiRun | null>(null);

  const call = useCallback(async (req: AiCompleteRequest, label: string): Promise<AiCompleteResult> => {
    const run = startAi(req, (p) => {
      if (current.current === run) setBusy((b) => (b ? { ...b, progress: p } : b));
    });
    current.current = run;
    setBusy({ label, startedAt: Date.now(), progress: null });
    try {
      return await run.promise;
    } finally {
      if (current.current === run) {
        current.current = null;
        setBusy(null);
      }
    }
  }, []);

  const cancel = useCallback(() => current.current?.cancel(), []);

  useEffect(() => () => current.current?.cancel(), []);

  return { busy, call, cancel };
}
