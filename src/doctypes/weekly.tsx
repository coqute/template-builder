import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import {
  CalendarPlus,
  ClipboardCopy,
  FileDown,
  FileSpreadsheet,
  Inbox,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/MarkdownEditor';
import { HtmlPreview, ZoomToggle } from '../components/HtmlPreview';
import { StatusBar } from '../components/StatusBar';
import { Btn, OpenSplitButton } from '../components/ToolbarButton';
import { VisualWeeklyEditor } from './weekly-visual/VisualWeeklyEditor';
import { useWeeklyState } from '../hooks/useWeeklyState';
import { fileBaseName as baseName } from '../lib/recentFiles';
import { readWithFallback } from '../lib/storage';
import { useDocTypeHost, useRegisterDocTypeHandlers } from './DocTypeHost';
import type { DocTypeModule, DocTypeWorkspaceProps } from './registry';
import type { Theme } from '../hooks/useTheme';

const STORAGE_KEY_SPLIT = 'tb:split';
const LEGACY_KEY_SPLIT = 'weekly-report-builder:split';
const DEFAULT_SPLIT: [number, number] = [42, 58];

type EditorMode = 'visual' | 'text';
const STORAGE_KEY_EDITOR_MODE = 'tb:weekly-editor-mode:v1';

function loadEditorMode(): EditorMode {
  if (typeof localStorage === 'undefined') return 'visual';
  const v = localStorage.getItem(STORAGE_KEY_EDITOR_MODE);
  return v === 'text' ? 'text' : 'visual'; // 기본 비주얼 — 문법 몰라도 작성 가능 (팀 배포)
}

function loadSplit(): [number, number] {
  if (typeof localStorage === 'undefined') return DEFAULT_SPLIT;
  const raw = readWithFallback(STORAGE_KEY_SPLIT, LEGACY_KEY_SPLIT);
  if (!raw) return DEFAULT_SPLIT;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => typeof n === 'number' && n > 0)
    ) {
      return [parsed[0], parsed[1]] as [number, number];
    }
  } catch {
    // ignore
  }
  return DEFAULT_SPLIT;
}

function WeeklyWorkspace({ theme, profile, zoom, onZoomChange }: DocTypeWorkspaceProps) {
  const { toolbarSlot } = useDocTypeHost();
  const w = useWeeklyState(profile.name);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const [splitSizes] = useState<[number, number]>(loadSplit);
  const [editorMode, setEditorMode] = useState<EditorMode>(loadEditorMode);

  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === 'visual') {
        // 문법 오류가 있으면 AST가 불완전 — 비주얼 전환 차단 (텍스트에서 수정 유도)
        const hasError = w.state.diagnostics.some((d) => d.severity === 'error');
        if (hasError) {
          toast.error('문법 오류가 있어 비주얼 모드로 전환할 수 없습니다. 하단 진단을 확인하세요.');
          return;
        }
      }
      setEditorMode(next);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY_EDITOR_MODE, next);
      }
    },
    [w.state.diagnostics],
  );

  const jumpToLine = useCallback(
    (line: number) => {
      // 진단 라인 점프는 텍스트 모드 전용 — 비주얼이면 먼저 전환
      if (editorMode !== 'text') {
        setEditorMode('text');
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY_EDITOR_MODE, 'text');
        }
        // 전환 직후 에디터 mount를 기다렸다 점프
        setTimeout(() => editorRef.current?.jumpToLine(line), 50);
        return;
      }
      editorRef.current?.jumpToLine(line);
    },
    [editorMode],
  );

  const handleSplitChange = useCallback((sizes: number[]) => {
    if (typeof localStorage === 'undefined') return;
    if (sizes.length !== 2) return;
    localStorage.setItem(STORAGE_KEY_SPLIT, JSON.stringify(sizes));
  }, []);

  useRegisterDocTypeHandlers({
    menu: {
      'menu:new': () => w.newDoc(),
      'menu:load-sample': () => void w.loadSample(),
      'menu:open': () => void w.openFile(),
      'menu:save': () => void w.saveFile(),
      'menu:import-gmail': () => void w.importGmail(),
      'menu:copy-html': () => void w.copyHtml(),
    },
    shortcut: (combo) => {
      switch (combo) {
        case 's':
          void w.saveFile();
          return true;
        case 'o':
          void w.openFile();
          return true;
        case 'l':
          void w.loadSample();
          return true;
        case 't':
          w.loadTemplate();
          return true;
        case 'shift+c':
          void w.copyHtml();
          return true;
        case 'shift+i':
          void w.importGmail();
          return true;
        default:
          return false;
      }
    },
  });

  const errorCount = w.state.diagnostics.filter((d) => d.severity === 'error').length;
  const subjectHint = w.state.subject ?? '제목은 @WEEK + @AUTHOR 기반으로 자동 생성됩니다.';
  const previewHtml = w.state.rendered?.html ?? '';

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            <Btn label="샘플" icon={<Sparkles size={14} />} onClick={() => void w.loadSample()} />
            <Btn
              label="템플릿"
              shortcut="Ctrl+T"
              icon={<CalendarPlus size={14} />}
              onClick={w.loadTemplate}
            />
            <Btn
              label="Gmail 가져오기"
              shortcut="Ctrl+Shift+I"
              icon={<Inbox size={14} />}
              onClick={() => void w.importGmail()}
            />
            <OpenSplitButton
              onOpen={() => void w.openFile()}
              recentFiles={w.recentFiles}
              onOpenRecent={(p) => void w.openRecentFile(p)}
            />
            <Btn
              label="저장"
              shortcut="Ctrl+S"
              icon={<FileDown size={14} />}
              onClick={() => void w.saveFile()}
            />
            <Btn
              label="HTML 복사"
              shortcut="Ctrl+Shift+C"
              icon={<ClipboardCopy size={14} />}
              primary
              disabled={!w.state.rendered || !!w.state.fatalError || errorCount > 0}
              onClick={() => void w.copyHtml()}
            />
          </>,
          toolbarSlot,
        )}
      <div className="flex h-full flex-col">
        <main className="min-h-0 flex-1">
          <Allotment defaultSizes={splitSizes} onChange={handleSplitChange}>
            <Allotment.Pane minSize={320}>
              <PaneHeader
                title={
                  w.filePath
                    ? `${baseName(w.filePath)}${w.dirty ? ' ●' : ''}`
                    : theme === 'mono'
                      ? 'INPUT.md'
                      : '입력'
                }
                hint={
                  editorMode === 'visual'
                    ? '폼으로 작성 — 저장은 .md 그대로'
                    : '@PREV · @CURRENT · @LOC · @CUS · # 일자 · @SUM · 1) · - · <- · -> · >'
                }
                actions={<EditorModeToggle mode={editorMode} onChange={switchMode} />}
                theme={theme}
              />
              <div className="h-[calc(100%-32px)]">
                {editorMode === 'visual' ? (
                  <VisualWeeklyEditor md={w.md} onMd={w.setMd} />
                ) : (
                  <MarkdownEditor ref={editorRef} value={w.md} onChange={w.setMd} />
                )}
              </div>
            </Allotment.Pane>
            <Allotment.Pane minSize={400}>
              <PaneHeader
                title={theme === 'mono' ? 'PREVIEW.html' : '미리보기'}
                hint={
                  w.state.stale ? '⚠ 입력 오류 — 마지막 정상 미리보기를 유지 중입니다' : subjectHint
                }
                actions={<ZoomToggle zoom={zoom} onZoomChange={onZoomChange} />}
                theme={theme}
              />
              <div className="h-[calc(100%-32px)]">
                <HtmlPreview html={previewHtml} zoom={zoom} />
              </div>
            </Allotment.Pane>
          </Allotment>
        </main>
        <StatusBar
          validation={w.state.validation}
          diagnostics={w.state.diagnostics}
          onJumpToLine={jumpToLine}
          fatalError={w.state.fatalError}
          subject={w.state.subject}
          theme={theme}
        />
      </div>
    </>
  );
}

function EditorModeToggle({
  mode,
  onChange,
}: {
  mode: EditorMode;
  onChange: (next: EditorMode) => void;
}) {
  const opt = (value: EditorMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={[
        'rounded-sharp px-1.5 py-0.5 text-[10px] leading-none transition',
        mode === value ? 'font-semibold' : 'text-fg-muted hover:text-fg',
      ].join(' ')}
      style={mode === value ? { background: 'var(--accent)', color: 'var(--bg)' } : undefined}
      title={value === 'visual' ? '폼 기반 작성 (문법 불필요)' : '.md 텍스트 직접 편집 (자동완성·린트)'}
    >
      {label}
    </button>
  );
  return (
    <div
      className="flex items-center gap-0.5 rounded-sharp border border-rule p-0.5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {opt('visual', '비주얼')}
      {opt('text', '텍스트')}
    </div>
  );
}

function PaneHeader({
  title,
  hint,
  actions,
  theme,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  theme: Theme;
}) {
  const isMono = theme === 'mono';
  return (
    <div className="flex h-8 flex-nowrap items-center justify-between gap-3 overflow-hidden border-b border-rule bg-bg-deep px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <span
          className={[
            'shrink-0 whitespace-nowrap text-fg-soft',
            isMono ? 'font-medium uppercase tracking-wider text-[10px]' : 'font-display text-[12px]',
          ].join(' ')}
        >
          {title}
        </span>
        {hint && (
          <span className="min-w-0 flex-1 truncate text-fg-muted" title={hint}>
            {hint}
          </span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center whitespace-nowrap">{actions}</div>}
    </div>
  );
}

export const weeklyModule: DocTypeModule = {
  id: 'weekly',
  label: '주간보고서',
  switchIcon: <FileSpreadsheet size={12} />,
  switchHint: '주간보고서 .md → HTML 표',
  badge: '.md → HTML 표',
  Workspace: WeeklyWorkspace,
};
