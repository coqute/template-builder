import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { fileBaseName } from '../lib/recentFiles';

interface BtnProps {
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** 툴바 표준 버튼 — DocType 모듈들이 슬롯 포털에 렌더 */
export function Btn({ label, shortcut, icon, primary, disabled, onClick }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sharp px-2 py-1.5 text-xs transition',
        'border border-accent disabled:opacity-40',
        primary ? 'font-semibold' : 'font-medium hover:opacity-90',
      ].join(' ')}
      style={{ background: 'var(--accent)', color: 'var(--bg)' }}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <span style={{ color: 'var(--bg)' }}>{icon}</span>
      {/* 1차 액션은 항상 라벨, 2차는 lg+에서만 (좁은 폭 가로 스크롤 방지) */}
      <span className={primary ? '' : 'hidden lg:inline'}>{label}</span>
    </button>
  );
}

/** "열기" split-button — 본체는 다이얼로그 열기, 우측 화살표는 최근 파일 드롭다운 */
export function OpenSplitButton({
  onOpen,
  recentFiles,
  onOpenRecent,
}: {
  onOpen: () => void;
  recentFiles: string[];
  onOpenRecent?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className="group flex items-center gap-1.5 whitespace-nowrap rounded-l-sharp border border-accent px-2 py-1.5 text-xs font-medium transition hover:opacity-90"
        style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        title="열기 (Ctrl+O)"
      >
        <span style={{ color: 'var(--bg)' }}>
          <FileText size={14} />
        </span>
        <span className="hidden lg:inline">열기</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={recentFiles.length === 0}
        className="flex items-center rounded-r-sharp border border-l-0 border-accent px-1 transition hover:opacity-90 disabled:opacity-40"
        style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        title={recentFiles.length ? '최근 파일' : '최근 파일 없음'}
        aria-label="최근 파일"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 min-w-[240px] rounded-sharp border border-rule bg-bg-elevated py-1 shadow-lg"
          role="menu"
        >
          {recentFiles.map((path) => (
            <button
              key={path}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenRecent?.(path);
              }}
              className="flex w-full flex-col items-start gap-0 px-3 py-1.5 text-left hover:bg-bg-sunken"
              title={path}
            >
              <span className="w-full truncate text-xs text-fg">{fileBaseName(path)}</span>
              <span className="w-full truncate text-[10px] text-fg-muted">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
