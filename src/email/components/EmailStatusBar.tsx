import { AlertTriangle, CheckCircle2, Mail } from 'lucide-react';
import type { EmailValidation } from '../validate';
import type { Theme } from '../../hooks/useTheme';

interface Props {
  validation?: EmailValidation;
  recipientHint?: string;
  theme: Theme;
}

/** 이메일 모드 하단 상태바 — weekly StatusBar와 동일 높이(32px)로 전환 시 비율 점프 방지 */
export function EmailStatusBar({ validation, recipientHint, theme }: Props) {
  const isMono = theme === 'mono';
  const warnings = validation?.issues ?? [];
  const prefix = isMono ? '> ' : '';

  return (
    <footer
      className="flex items-center justify-between border-t border-rule bg-bg-deep px-4 text-xs text-fg-soft"
      style={{ height: 'var(--gap-statusbar, 32px)' }}
    >
      <div className="flex min-w-0 items-center gap-3">
        {warnings.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1.5" style={{ color: 'var(--stamp-amber)' }}>
            <AlertTriangle size={13} className="shrink-0" />
            <span className="truncate">
              {prefix}경고 {warnings.length} — {warnings[0]?.message}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5" style={{ color: 'var(--stamp-green)' }}>
            <CheckCircle2 size={13} /> {isMono ? 'ok' : '입력 완료'}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-fg-muted">
        {recipientHint && (
          <span className="hidden items-center gap-1 sm:flex">
            <Mail size={12} /> {recipientHint}
          </span>
        )}
        <span className="hidden md:inline">Ctrl+Enter 임시보관함</span>
      </div>
    </footer>
  );
}
