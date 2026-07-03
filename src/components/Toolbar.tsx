import { useEffect, useRef, useState } from 'react';
import {
  CalendarPlus,
  ChevronDown,
  ClipboardCopy,
  FileDown,
  FileText,
  HelpCircle,
  Inbox,
  Mails,
  Send,
  Sparkles,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { DocTypeSwitch } from './DocTypeSwitch';
import { StampLogo } from './StampLogo';
import { fileBaseName } from '../lib/recentFiles';
import type { Theme } from '../hooks/useTheme';
import type { DocType } from '../hooks/useDocType';

interface ToolbarProps {
  docType: DocType;
  onDocTypeChange: (next: DocType) => void;
  // weekly 핸들러
  onLoadSample: () => void;
  onLoadTemplate: () => void;
  onImportGmail: () => void;
  onOpen: () => void;
  recentFiles?: string[];
  onOpenRecent?: (path: string) => void;
  onSave: () => void;
  onCopyHtml: () => void;
  copyDisabled?: boolean;
  // email 핸들러 (Phase 4에서 연결)
  onEmailOpen?: () => void;
  onEmailSave?: () => void;
  onEmailCopyHtml?: () => void;
  onComposeGmail?: () => void;
  onCreateDraft?: () => void;
  emailActionDisabled?: boolean;
  // 공통
  onToggleHelp: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

interface BtnProps {
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** "열기" split-button — 본체는 다이얼로그 열기, 우측 화살표는 최근 파일 드롭다운 */
function OpenSplitButton({
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

function Btn({ label, shortcut, icon, primary, disabled, onClick }: BtnProps) {
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

export function Toolbar({
  docType,
  onDocTypeChange,
  onLoadSample,
  onLoadTemplate,
  onImportGmail,
  onOpen,
  recentFiles,
  onOpenRecent,
  onSave,
  onCopyHtml,
  copyDisabled,
  onEmailOpen,
  onEmailSave,
  onEmailCopyHtml,
  onComposeGmail,
  onCreateDraft,
  emailActionDisabled,
  onToggleHelp,
  theme,
  onThemeChange,
}: ToolbarProps) {
  const isMono = theme === 'mono';
  const badge = docType === 'weekly' ? '.md → HTML 표' : '폼 → 이메일';
  return (
    <header
      className="flex flex-nowrap items-center justify-between gap-2 overflow-hidden border-b border-rule bg-bg px-4"
      style={{ height: 'var(--gap-toolbar, 56px)' }}
    >
      <div className="flex min-w-0 shrink items-center gap-2">
        <StampLogo theme={theme} size={28} />
        <h1
          className={[
            'hidden whitespace-nowrap text-fg lg:block',
            isMono ? 'text-sm font-semibold' : 'font-display text-base',
          ].join(' ')}
        >
          {isMono ? '$ template-builder' : 'ExampleIT Template Builder'}
        </h1>
        <span
          className="ml-1 hidden whitespace-nowrap rounded-sharp border border-rule px-2 py-0.5 text-[10px] uppercase text-fg-muted 2xl:inline-block"
        >
          {badge}
        </span>
        <span className="mx-1 h-5 w-px shrink-0 bg-rule" />
        <DocTypeSwitch docType={docType} onChange={onDocTypeChange} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {docType === 'weekly' ? (
          <>
            <Btn label="샘플" icon={<Sparkles size={14} />} onClick={onLoadSample} />
            <Btn
              label="템플릿"
              shortcut="Ctrl+T"
              icon={<CalendarPlus size={14} />}
              onClick={onLoadTemplate}
            />
            <Btn
              label="Gmail 가져오기"
              shortcut="Ctrl+Shift+I"
              icon={<Inbox size={14} />}
              onClick={onImportGmail}
            />
            <OpenSplitButton
              onOpen={onOpen}
              recentFiles={recentFiles ?? []}
              onOpenRecent={onOpenRecent}
            />
            <Btn label="저장" shortcut="Ctrl+S" icon={<FileDown size={14} />} onClick={onSave} />
            <Btn
              label="HTML 복사"
              shortcut="Ctrl+Shift+C"
              icon={<ClipboardCopy size={14} />}
              primary
              disabled={copyDisabled}
              onClick={onCopyHtml}
            />
          </>
        ) : (
          <>
            <Btn
              label="열기"
              shortcut="Ctrl+O"
              icon={<FileText size={14} />}
              onClick={() => onEmailOpen?.()}
            />
            <Btn
              label="저장"
              shortcut="Ctrl+S"
              icon={<FileDown size={14} />}
              onClick={() => onEmailSave?.()}
            />
            <Btn
              label="HTML 복사"
              shortcut="Ctrl+Shift+C"
              icon={<ClipboardCopy size={14} />}
              disabled={emailActionDisabled}
              onClick={() => onEmailCopyHtml?.()}
            />
            <Btn
              label="Gmail 작성"
              icon={<Send size={14} />}
              disabled={emailActionDisabled}
              onClick={() => onComposeGmail?.()}
            />
            <Btn
              label="임시보관함"
              shortcut="Ctrl+Enter · 이미지 인라인 포함"
              icon={<Mails size={14} />}
              primary
              disabled={emailActionDisabled}
              onClick={() => onCreateDraft?.()}
            />
          </>
        )}
        <span className="mx-1 h-5 w-px bg-rule" />
        <Btn label="도움말" shortcut="F1" icon={<HelpCircle size={14} />} onClick={onToggleHelp} />
        <span className="mx-1 h-5 w-px bg-rule" />
        <ThemeToggle theme={theme} onChange={onThemeChange} />
      </div>
    </header>
  );
}
