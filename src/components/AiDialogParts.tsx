/**
 * 붙여 넣은 글을 AI로 바꾸는 창(작업일지의 대화 → 블록, 이메일의 서술 → 문의)이 함께 쓰는 조각.
 * 두 창이 같은 코드를 따로 갖고 있었다(v0.27.0에서 하나로) — 한쪽만 고쳐져 모양이 갈리지 않게.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { AlertTriangle, Loader2, Wand2 } from 'lucide-react';
import { maskedSummary } from '../ai/review';
import type { AiMeta } from '../ai/result';
import { modelLabel } from '../ai/settings';
import type { AiBusy } from '../ai/useAiRun';
import { AiProgressLine } from './AiBusyCard';
import { BTN_GHOST, BTN_SOLID, SOLID_STYLE } from './Modal';

export const DESKTOP_ONLY = '데스크톱 앱에서만 쓸 수 있습니다.';

/** 결과 창의 부제 — `모델 (대체 모델이 이어 받음) · {extra} · 약 $0.012 · 9초 · 보내기 전 가림: IP 2` */
export function aiResultLine(r: Pick<AiMeta, 'model' | 'usd' | 'ms' | 'masked'> & { fallbackUsed?: boolean }, extra = ''): string {
  const masked = maskedSummary(r.masked);
  return `${modelLabel(r.model)}${r.fallbackUsed ? ' (대체 모델이 이어 받음)' : ''}${extra ? ` · ${extra}` : ''} · 약 $${r.usd.toFixed(3)} · ${Math.max(1, Math.round(r.ms / 1000))}초${masked ? ` · 보내기 전 가림: ${masked}` : ''}`;
}

/** 실행 실패 한 줄 */
export function AiError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mb-3 flex items-start gap-1.5 rounded-sharp border border-rule px-2.5 py-2 text-[12px]" style={{ color: 'var(--stamp-red)' }}>
      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
    </p>
  );
}

/** 확인할 점 — 꼭 봐야 할 것(warnings, 빨간 표시)과 참고할 것(notes) */
export function AiNotes({ warnings, notes, className = '' }: { warnings: string[]; notes: string[]; className?: string }) {
  if (warnings.length === 0 && notes.length === 0) return null;
  return (
    <section className={`rounded-card border border-rule bg-bg p-3 ${className}`.trim()} aria-label="확인할 점">
      <h3 className="mb-1 text-xs font-semibold text-fg">확인할 점</h3>
      <ul className="space-y-0.5 text-fg-soft">
        {warnings.map((w, i) => (
          <li key={`w${i}`} className="flex gap-1">
            <AlertTriangle size={12} className="mt-1 shrink-0" style={{ color: 'var(--stamp-red)' }} /> {w}
          </li>
        ))}
        {notes.map((q, i) => (
          <li key={`q${i}`}>· {q}</li>
        ))}
      </ul>
    </section>
  );
}

interface RunFooterProps {
  ai: { busy: AiBusy | null; cancel: () => void };
  /** 돌고 있지 않을 때의 안내 한 줄 */
  idle: ReactNode;
  /** 돌고 있을 때 단추의 글 — "정리하는 중…" */
  busyLabel: string;
  /** 실행 단추의 글 — "블록 만들기" */
  runLabel: string;
  canRun: boolean;
  onRun: () => void;
  onClose: () => void;
}

/** 실행 전의 바닥 줄 — 진행 표시(또는 안내) · 멈추기/취소 · 실행 */
export function AiRunFooter({ ai, idle, busyLabel, runLabel, canRun, onRun, onClose }: RunFooterProps) {
  const busy = !!ai.busy;
  return (
    <>
      <span className="min-w-0 flex-1 text-[11px] text-fg-muted">{ai.busy ? <AiProgressLine startedAt={ai.busy.startedAt} progress={ai.busy.progress} /> : idle}</span>
      {busy ? (
        <button type="button" className={BTN_GHOST} onClick={ai.cancel}>
          멈추기
        </button>
      ) : (
        <button type="button" className={BTN_GHOST} onClick={onClose}>
          취소
        </button>
      )}
      <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={busy || !canRun} onClick={onRun}>
        {busy ? (
          <span className="flex items-center gap-1.5">
            <Loader2 size={13} className="animate-spin" /> {busyLabel}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Wand2 size={13} /> {runLabel}
          </span>
        )}
      </button>
    </>
  );
}

/** 입력 칸에서 Ctrl+Enter로 실행 */
export function ctrlEnter(can: boolean, run: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && can) {
      e.preventDefault();
      run();
    }
  };
}
