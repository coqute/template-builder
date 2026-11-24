import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { fadeIn, growFrom, leave } from '../lib/motion';

interface Props {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** 최대 너비(px) */
  width?: number;
  labelId?: string;
}

/**
 * 공용 대화 상자 틀 — 바깥 클릭·Esc로 닫힌다 (AI 확인 창과 같은 모양).
 * 가운데에서 살짝 작게 시작해 부드럽게 커지며 열리고, 바깥·Esc·[×]로 닫을 때는 줄어든 뒤에 사라진다(lib/motion).
 * 안의 단추가 직접 닫는 경우(저장·취소)는 바로 사라진다.
 */
export function Modal({ title, subtitle, children, footer, onClose, width = 720, labelId = 'modal-title' }: Props) {
  const panel = useRef<HTMLDivElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    growFrom(panel.current, null);
    fadeIn(scrim.current);
  }, []);
  const close = useCallback(() => leave(panel.current, scrim.current, null, onClose), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div ref={scrim} className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'var(--scrim)' }} onMouseDown={close}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className="flex max-h-[88vh] w-full flex-col rounded-card border border-rule-strong bg-bg-elevated"
        style={{ boxShadow: 'var(--shadow-pop)', maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-3">
          <div className="min-w-0">
            <h2 id={labelId} className="text-sm font-semibold text-fg">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-[11px] text-fg-muted">{subtitle}</div>}
          </div>
          <button type="button" onClick={close} aria-label="닫기 (Esc)" className="rounded-sharp p-1 text-fg-muted hover:bg-bg-sunken hover:text-fg">
            <X size={16} />
          </button>
        </header>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
        {footer && <footer className="flex items-center gap-2 border-t border-rule px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export const BTN_GHOST = 'rounded-sharp border border-rule px-3 py-1.5 text-xs text-fg-soft hover:bg-bg-sunken disabled:opacity-40';
export const BTN_SOLID = 'rounded-sharp px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40';
export const SOLID_STYLE = { background: 'var(--accent)', color: 'var(--bg)' } as const;
export const INPUT = 'w-full rounded-sharp border border-rule-input bg-bg px-2 py-1.5 text-[13px] text-fg outline-none focus:border-fg';
