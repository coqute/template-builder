import {
  CalendarPlus,
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
            <Btn label="열기" shortcut="Ctrl+O" icon={<FileText size={14} />} onClick={onOpen} />
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
