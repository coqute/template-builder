import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import type { WorklogEntry } from '../../../electron/worklog-types';
import type { WlFix, WlIssue } from '../lint';
import type { SaveStatus } from '../useWorklog';

interface Props {
  current: WorklogEntry | null;
  status: SaveStatus;
  dirty: boolean;
  savedAt: number | null;
  error: string | null;
  issues: WlIssue[];
  counts: { cases: number; acts: number };
  onJump: (line: number) => void;
  onFix: (fix: WlFix) => void;
}

function hhmmss(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function WorklogStatusBar({ current, status, dirty, savedAt, error, issues, counts, onJump, onFix }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const state =
    status === 'conflict' ? (
      <span className="flex items-center gap-1" style={{ color: 'var(--stamp-red)' }}>
        <AlertTriangle size={13} /> 파일이 바깥에서 바뀜 — 위 안내에서 고르세요
      </span>
    ) : status === 'error' ? (
      <span className="flex items-center gap-1" style={{ color: 'var(--stamp-red)' }} title={error ?? undefined}>
        <AlertTriangle size={13} /> 저장 실패 — 내용은 앱에 보관 중
      </span>
    ) : status === 'saving' ? (
      <span className="flex items-center gap-1">
        <Loader2 size={12} className="animate-spin" /> 저장 중…
      </span>
    ) : dirty ? (
      <span>● 저장 전 (멈추면 자동 저장)</span>
    ) : savedAt ? (
      <span className="flex items-center gap-1">
        <CheckCircle2 size={13} /> 저장됨 {hhmmss(savedAt)}
      </span>
    ) : current ? (
      <span>파일과 같음</span>
    ) : null;

  return (
    <footer className="relative flex items-center justify-between gap-3 border-t border-rule bg-bg-deep px-4 text-xs text-fg-soft" style={{ height: 'var(--gap-statusbar, 32px)' }}>
      <div className="flex min-w-0 items-center gap-3">
        {state}
        {current && (
          <span className="text-fg-muted">
            ■ {counts.cases} · ▶ {counts.acts}
          </span>
        )}
        {issues.length > 0 && (
          <div ref={boxRef} className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex items-center gap-1 rounded-sharp border border-rule px-1.5 py-0.5 text-[11px] hover:bg-bg-sunken"
            >
              <Info size={12} /> 형식 제안 {issues.length}
            </button>
            {open && (
              <div className="absolute bottom-full left-0 z-40 mb-1 w-[min(520px,80vw)] rounded-sharp border border-rule-strong bg-bg-elevated py-1 shadow-pop" role="dialog" aria-label="형식 제안">
                <p className="px-3 pb-1 pt-0.5 text-[10.5px] text-fg-muted">제안일 뿐입니다 — 수기 내용은 그대로 두어도 됩니다.</p>
                <ul className="max-h-[40vh] overflow-y-auto">
                  {issues.map((i, k) => (
                    <li key={k} className="flex items-start gap-2 px-3 py-1.5 text-[12px] hover:bg-bg-sunken">
                      <button type="button" onClick={() => onJump(i.line)} className="shrink-0 tabular-nums text-fg-muted hover:text-fg" title="그 줄로 이동">
                        {i.line}행
                      </button>
                      <span className="min-w-0 flex-1 text-fg-soft">{i.message}</span>
                      {i.fixes?.map((f) => (
                        <button
                          key={f.label}
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            onFix(f.fix);
                          }}
                          className="shrink-0 rounded-sharp border border-rule px-1.5 py-0.5 text-[11px] text-fg hover:border-fg"
                        >
                          {f.label}
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      {current && (
        <span className="min-w-0 truncate text-fg-muted" title={`${current.folder ? `${current.folder} › ` : ''}${current.name}`}>
          {current.folder ? `${current.folder} › ` : ''}
          {current.name}
        </span>
      )}
    </footer>
  );
}
