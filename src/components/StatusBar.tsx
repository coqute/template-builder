import { useState } from 'react';
import type { Diagnostic, ValidationResult } from '@core/index';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';

interface Props {
  validation?: ValidationResult;
  /** 파서 + 검증기 병합 진단 (useReportState.diagnostics) */
  diagnostics?: Diagnostic[];
  /** 진단 행 클릭 시 에디터 라인 점프 */
  onJumpToLine?: (line: number) => void;
  /** 예기치 못한 내부 예외 */
  fatalError?: { message: string };
  subject?: string;
  theme: Theme;
}

export function StatusBar({
  validation,
  diagnostics = [],
  onJumpToLine,
  fatalError,
  subject,
  theme,
}: Props) {
  const [panelOpen, setPanelOpen] = useState(false);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const infos = diagnostics.filter((d) => d.severity === 'info');
  const isMono = theme === 'mono';
  const prefix = isMono ? '> ' : '';

  return (
    <footer
      className="relative flex items-center justify-between border-t border-rule bg-bg-deep px-4 text-xs text-fg-soft"
      style={{ height: 'var(--gap-statusbar, 32px)' }}
    >
      <div className="flex items-center gap-3">
        {fatalError ? (
          <span className="flex items-center gap-1.5" style={{ color: 'var(--stamp-red)' }}>
            <AlertCircle size={13} />
            {prefix}내부 오류: {trimMessage(fatalError.message)}
          </span>
        ) : validation ? (
          <>
            <span className="text-fg-muted">{prefix.trim()}</span>
            <Stat label="일자" value={validation.stats.days} />
            <Sep mono={isMono} />
            <Stat label="장소 블록" value={validation.stats.locations} />
            <Sep mono={isMono} />
            <Stat label="고객사 행" value={validation.stats.clientItems} />
            <Sep mono={isMono} />
            <Stat label="내용 항목" value={validation.stats.contentBlocks} />
            {errors.length > 0 && (
              <>
                <Sep mono={isMono} />
                <DiagChip
                  color="var(--stamp-red)"
                  icon={<AlertCircle size={13} />}
                  label={`오류 ${errors.length}`}
                  onClick={() => setPanelOpen((v) => !v)}
                />
              </>
            )}
            {warnings.length > 0 && (
              <>
                <Sep mono={isMono} />
                <DiagChip
                  color="var(--stamp-amber)"
                  icon={<AlertTriangle size={13} />}
                  label={`경고 ${warnings.length}`}
                  onClick={() => setPanelOpen((v) => !v)}
                />
              </>
            )}
            {infos.length > 0 && (
              <>
                <Sep mono={isMono} />
                <DiagChip
                  color="var(--fg-muted)"
                  icon={<Info size={13} />}
                  label={`정보 ${infos.length}`}
                  onClick={() => setPanelOpen((v) => !v)}
                />
              </>
            )}
            {errors.length === 0 && warnings.length === 0 && (
              <>
                <Sep mono={isMono} />
                <span className="flex items-center gap-1" style={{ color: 'var(--stamp-green)' }}>
                  <CheckCircle2 size={13} /> {isMono ? 'ok' : '모든 검증 통과'}
                </span>
              </>
            )}
          </>
        ) : (
          <span className="text-fg-muted">{prefix}입력을 기다리는 중…</span>
        )}
      </div>
      {subject && (
        <div className="truncate text-fg-muted" title={subject}>
          제목: <span className="text-fg-soft">{subject}</span>
        </div>
      )}

      {panelOpen && diagnostics.length > 0 && (
        <DiagnosticPanel
          diagnostics={diagnostics}
          onJumpToLine={(line) => {
            onJumpToLine?.(line);
            setPanelOpen(false);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </footer>
  );
}

function DiagChip({
  color,
  icon,
  label,
  onClick,
}: {
  color: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-sharp px-1 py-0.5 transition hover:bg-bg-sunken"
      style={{ color }}
      title="클릭하면 진단 목록을 펼칩니다"
    >
      {icon} {label}
    </button>
  );
}

function DiagnosticPanel({
  diagnostics,
  onJumpToLine,
  onClose,
}: {
  diagnostics: Diagnostic[];
  onJumpToLine: (line: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-[min(560px,90vw)] overflow-auto rounded-card border border-rule bg-bg-elevated shadow-themed scrollbar-thin"
      role="dialog"
      aria-label="진단 목록"
    >
      <div className="flex items-center justify-between border-b border-rule px-3 py-1.5 text-[11px] text-fg-muted">
        <span>진단 {diagnostics.length}건 — 행을 클릭하면 해당 라인으로 이동</span>
        <button type="button" onClick={onClose} className="text-fg-muted hover:text-fg">
          ✕
        </button>
      </div>
      <ul>
        {diagnostics.map((d, idx) => (
          <li key={`${d.line}-${idx}`}>
            <button
              type="button"
              onClick={() => d.line > 0 && onJumpToLine(d.line)}
              className={[
                'flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] transition',
                d.line > 0 ? 'hover:bg-bg-sunken' : 'cursor-default',
              ].join(' ')}
              title={d.line > 0 ? d.hint : (d.hint ?? '문서 수준 진단 — 이동할 라인이 없습니다')}
            >
              <SeverityIcon severity={d.severity} />
              <span className="shrink-0 tabular-nums text-fg-muted">
                {d.line > 0 ? `L${d.line}` : '문서'}
              </span>
              <span className="min-w-0 flex-1 text-fg">{d.message}</span>
              <span className="shrink-0 rounded-sharp border border-rule px-1 text-[10px] text-fg-faint">
                {d.source === 'parser' ? '구문' : '검증'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }) {
  if (severity === 'error') {
    return <AlertCircle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--stamp-red)' }} />;
  }
  if (severity === 'warning') {
    return (
      <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--stamp-amber)' }} />
    );
  }
  return <Info size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--fg-muted)' }} />;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-fg-muted">{label}</span>
      <span className="font-medium tabular-nums text-fg">{value}</span>
    </span>
  );
}

function Sep({ mono }: { mono: boolean }) {
  if (mono) {
    return <span className="text-fg-faint">│</span>;
  }
  return <span className="h-3 w-px bg-rule" />;
}

function trimMessage(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
