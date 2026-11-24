import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AiProgress } from '../../electron/ai-types';
import { elapsedText, progressText } from '../ai/client';

interface Props {
  label: string;
  startedAt: number;
  progress: AiProgress | null;
  /** 아래 작은 안내 한 줄 */
  note?: string;
  onCancel: () => void;
}

/** 진행 한 줄 — 단계와 지난 시간. 1초마다 스스로 갱신한다 */
export function AiProgressLine({ startedAt, progress }: Pick<Props, 'startedAt' | 'progress'>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="tabular-nums" aria-hidden="true">
      {progressText(progress)} · {elapsedText(now - startedAt)}
    </span>
  );
}

/** AI 호출 중 화면을 덮는 카드 — 지금 무엇을 하는지(연결·생각·쓰는 중)와 지난 시간을 보여 주고, 멈출 수 있다 */
export function AiBusyCard({ label, startedAt, progress, note, onCancel }: Props) {
  return (
    <div className="tb-scrim fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--scrim)' }} role="alertdialog" aria-label={label}>
      <div className="flex items-center gap-3 rounded-card border border-rule-strong bg-bg-elevated px-5 py-4" style={{ boxShadow: 'var(--shadow-pop)' }}>
        <Loader2 size={16} className="shrink-0 animate-spin text-fg-muted" aria-hidden="true" />
        <div className="min-w-[230px]">
          <div className="text-[13px] font-semibold text-fg" aria-live="polite">
            {label}
          </div>
          <div className="text-[11.5px] text-fg-soft">
            <AiProgressLine startedAt={startedAt} progress={progress} />
          </div>
          {note && <div className="text-[11px] text-fg-muted">{note}</div>}
        </div>
        <button type="button" onClick={onCancel} className="ml-2 shrink-0 rounded-sharp border border-rule px-2.5 py-1 text-[11.5px] text-fg-soft hover:bg-bg-sunken">
          취소
        </button>
      </div>
    </div>
  );
}
