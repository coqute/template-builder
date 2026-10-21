import { useState } from 'react';
import { toast } from 'sonner';
import type { AiCompleteRequest, AiCompleteResult } from '../../electron/ai-types';
import { AiBusyCard } from '../components/AiBusyCard';
import { AiReviewDialog } from '../components/AiReviewDialog';
import type { ReviewData } from './review';
import { modelLabel } from './settings';
import { useAiRun } from './useAiRun';

type OkResult = Extract<AiCompleteResult, { ok: true }>;

export interface TidyJob<P> {
  title: string;
  /** 보낼 내용이 없을 때 안내 */
  empty: string;
  plan: () => P | null;
  request: (plan: P) => AiCompleteRequest;
  review: (plan: P, res: OkResult) => ReviewData;
  /** 고른 변경 적용 — 적용한 개수를 돌려준다 */
  apply: (plan: P, review: ReviewData, picked: Set<string>) => void;
}

interface Open {
  title: string;
  review: ReviewData;
  apply: (picked: Set<string>) => void;
}

/**
 * AI 정돈 실행 흐름 — 계획(마스킹) → 호출(main) → 확인 창 → 적용.
 * 호출 중에는 화면을 덮어 편집을 막는다(결과를 옛 내용에 덮어쓰지 않게). 취소하면 요청을 멈춘다.
 */
export function useAiTidy() {
  const ai = useAiRun();
  const [open, setOpen] = useState<Open | null>(null);

  async function run<P>(job: TidyJob<P>) {
    const api = window.reportApi;
    if (!api?.aiComplete) {
      toast.error('AI 정돈은 데스크톱 앱에서만 쓸 수 있습니다.');
      return;
    }
    let plan: P | null;
    try {
      plan = job.plan();
    } catch (err) {
      toast.error(`보낼 내용을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!plan) {
      toast.info(job.empty);
      return;
    }
    if (ai.busy) return;
    const req = job.request(plan);
    const res = await ai.call(req, `${modelLabel(req.model)}로 정돈하는 중`);
    if (!res.ok) {
      if (res.code === 'canceled') toast.info('정돈을 취소했습니다.');
      else toast.error(res.message, { duration: 8000 });
      return;
    }
    let review: ReviewData;
    try {
      review = job.review(plan, res);
    } catch (err) {
      toast.error(`응답을 확인하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const p = plan;
    setOpen({
      title: job.title,
      review,
      apply: (picked) => {
        setOpen(null);
        job.apply(p, review, picked);
      },
    });
  }

  const view = (
    <>
      {ai.busy && (
        <AiBusyCard
          label={ai.busy.label}
          startedAt={ai.busy.startedAt}
          progress={ai.busy.progress}
          note="끝나면 바뀔 곳을 보여 드립니다. 그동안 편집은 멈춥니다."
          onCancel={ai.cancel}
        />
      )}
      {open && <AiReviewDialog title={open.title} review={open.review} onApply={open.apply} onClose={() => setOpen(null)} />}
    </>
  );

  return { run, busy: !!ai.busy, view };
}
