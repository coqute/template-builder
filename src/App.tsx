import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  importFromInput,
  serialize,
} from '@core/index';
import { Toolbar } from './components/Toolbar';
import { MarkdownEditor, type MarkdownEditorHandle } from './components/MarkdownEditor';
import { HtmlPreview, ZoomToggle, type ZoomMode } from './components/HtmlPreview';
import { StatusBar } from './components/StatusBar';
import { HelpDrawer } from './components/HelpDrawer';
import { useDebounced } from './hooks/useDebounced';
import { useReportState } from './hooks/useReportState';
import { copyHtmlToClipboard, readClipboard } from './hooks/useClipboard';
import { useAuthor } from './hooks/useAuthor';
import { buildWeeklyTemplate } from './hooks/useTemplate';
import { useTheme } from './hooks/useTheme';
import { useDocType } from './hooks/useDocType';
import { EmailWorkspace } from './email/components/EmailWorkspace';
import { EmailStatusBar } from './email/components/EmailStatusBar';
import { useEmailDoc } from './email/useEmailDoc';
import { useEmailState } from './email/useEmailState';
import { useEmailExport } from './email/useEmailExport';
import { readWithFallback } from './lib/storage';
import {
  fileBaseName as baseName,
  loadRecentFiles,
  pushRecentFile,
  removeRecentFile,
} from './lib/recentFiles';

const STORAGE_KEY_MD = 'tb:md-draft:v1';
const STORAGE_KEY_ZOOM = 'tb:preview-zoom';
const STORAGE_KEY_SPLIT = 'tb:split';
const STORAGE_KEY_FILE = 'tb:md-file-path:v1';
const LEGACY_KEY_MD = 'weekly-report-builder:md-draft:v1';
const LEGACY_KEY_ZOOM = 'weekly-report-builder:preview-zoom';
const LEGACY_KEY_SPLIT = 'weekly-report-builder:split';

const DEFAULT_SPLIT: [number, number] = [42, 58];

const FALLBACK_MD = `@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-08
@AUTHOR 박민수

# 2026-04-27(월)
@LOC 남산 데이터센터
@CUS 남산 IDC
@SUM [ABZ+] (이영희) 신규 수집 서버 설치 완료 후, 후속 작업 진행 (PoC)
1) 모니터링 에이전트 설치 방법 시연 및 안내
- Rocky 9, Ubuntu 22.04, Windows 각각 OS별 설치 가이드
2) 관리 콘솔 설치 진행
- 초기 설정 전, 서비스만 실행 중

# 2026-05-01(금)
@HOLIDAY 근로자의 날
`;

function loadZoom(): ZoomMode {
  if (typeof localStorage === 'undefined') return 'fit';
  const v = readWithFallback(STORAGE_KEY_ZOOM, LEGACY_KEY_ZOOM);
  return v === 'fit' || v === '50' || v === '75' || v === '100' ? v : 'fit';
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

export function App() {
  const [md, setMd] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return FALLBACK_MD;
    return readWithFallback(STORAGE_KEY_MD, LEGACY_KEY_MD) ?? FALLBACK_MD;
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const [splitSizes] = useState<[number, number]>(loadSplit);
  // 현재 편집 중인 .md의 디스크 경로 (열기/다른이름저장으로 확정 → Ctrl+S 덮어쓰기 대상)
  const [filePath, setFilePath] = useState<string | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY_FILE) || null;
  });
  // 마지막으로 디스크에 저장한 내용 (수정 여부 ● 표시용)
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // 최근 파일 MRU (최대 5) — 열기/저장 성공 시 갱신, 열기 실패 시 제거
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  const { author, setAuthor } = useAuthor();
  const { theme, setTheme } = useTheme();
  const { docType, setDocType } = useDocType();

  const debouncedMd = useDebounced(md, 200);
  const state = useReportState(debouncedMd);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  // 이메일 문서 상태 (App이 소유 → Toolbar + EmailWorkspace 공유)
  const emailDoc = useEmailDoc();
  const emailState = useEmailState(emailDoc.doc);
  const emailExport = useEmailExport(emailDoc.doc, emailState.rendered, emailDoc.loadDoc);

  const jumpToLine = useCallback((line: number) => {
    editorRef.current?.jumpToLine(line);
  }, []);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_MD, md);
    }
  }, [md]);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_ZOOM, zoom);
    }
  }, [zoom]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (filePath) localStorage.setItem(STORAGE_KEY_FILE, filePath);
    else localStorage.removeItem(STORAGE_KEY_FILE);
  }, [filePath]);

  const dirty = filePath != null && savedSnapshot != null && md !== savedSnapshot;

  // main 프로세스에 dirty 통지 — 창 닫기 전 확인 다이얼로그용
  useEffect(() => {
    window.reportApi?.setDirty?.(dirty);
  }, [dirty]);

  const handleSplitChange = useCallback((sizes: number[]) => {
    if (typeof localStorage === 'undefined') return;
    if (sizes.length !== 2) return;
    localStorage.setItem(STORAGE_KEY_SPLIT, JSON.stringify(sizes));
  }, []);

  // 새 콘텐츠 로드 시 기존 파일 연결 해제 → 다음 Ctrl+S는 "다른 이름으로 저장"
  const detachFile = useCallback(() => {
    setFilePath(null);
    setSavedSnapshot(null);
  }, []);

  const loadSample = useCallback(async () => {
    detachFile();
    if (window.reportApi?.loadSample) {
      const sample = await window.reportApi.loadSample();
      if (sample) {
        setMd(sample);
        toast.success('샘플을 불러왔습니다.');
        return;
      }
    }
    setMd(FALLBACK_MD);
    toast.success('내장 샘플을 불러왔습니다.');
  }, [detachFile]);

  const loadTemplate = useCallback(() => {
    detachFile();
    const { md: tpl, prevStart, prevEnd } = buildWeeklyTemplate({ authorName: author });
    setMd(tpl);
    toast.success(`지난 주 (${prevStart} ~ ${prevEnd}) 빈 템플릿을 생성했습니다.`);
  }, [author, detachFile]);

  const importGmail = useCallback(async () => {
    try {
      const { html, plain } = await readClipboard();
      if (!html && !plain) {
        toast.error('클립보드가 비어 있습니다. Gmail 본문을 먼저 복사하세요.');
        return;
      }
      const { report, warnings } = importFromInput({ html, plain });
      const generated = serialize(report);
      detachFile();
      setMd(generated);
      if (warnings.length > 0) {
        toast.warning(`가져왔습니다 (경고 ${warnings.length}건). 검증 결과를 확인하세요.`);
      } else {
        toast.success('Gmail 본문을 .md로 변환했습니다.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'import 실패');
    }
  }, [detachFile]);

  const openFile = useCallback(async () => {
    if (!window.reportApi?.openMd) {
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
      return;
    }
    const result = await window.reportApi.openMd();
    if (result.canceled) return;
    setMd(result.content);
    setFilePath(result.filePath);
    setSavedSnapshot(result.content);
    setRecentFiles(pushRecentFile(result.filePath));
    toast.success(`불러옴: ${baseName(result.filePath)}`);
  }, []);

  // 최근 파일 — 다이얼로그 없이 직접 열기. 실패(삭제/이동) 시 목록에서 제거
  const openRecentFile = useCallback(async (path: string) => {
    const api = window.reportApi;
    if (!api?.readPath) {
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
      return;
    }
    const result = await api.readPath(path);
    if (!result.ok) {
      setRecentFiles(removeRecentFile(path));
      toast.error(`파일을 열 수 없어 목록에서 제거했습니다: ${baseName(path)}`);
      return;
    }
    setMd(result.content);
    setFilePath(path);
    setSavedSnapshot(result.content);
    setRecentFiles(pushRecentFile(path));
    toast.success(`불러옴: ${baseName(path)}`);
  }, []);

  const saveFile = useCallback(async () => {
    const api = window.reportApi;
    if (!api?.save) {
      toast.error('데스크탑 모드에서만 파일 저장을 지원합니다.');
      return;
    }
    // 기존 파일이 확정돼 있으면 다이얼로그 없이 그 경로에 덮어쓰기
    if (filePath && api.saveToPath) {
      const result = await api.saveToPath(filePath, md);
      if (result.ok) {
        setSavedSnapshot(md);
        setRecentFiles(pushRecentFile(result.filePath));
        toast.success(`저장됨: ${baseName(result.filePath)}`);
        return;
      }
      // 경로가 사라졌거나 쓰기 실패 → 무효화 후 아래 "다른 이름으로 저장"으로 폴백
      toast.error(`기존 경로에 저장하지 못했습니다 — 위치를 다시 지정하세요. (${result.error})`);
      setFilePath(null);
    }
    // 신규/경로 미확정 — 다른 이름으로 저장 다이얼로그
    const defaultName = state.subject
      ? state.subject.replace(/[\\/:*?"<>|]/g, '_')
      : 'weekly-report';
    const result = await api.save({ defaultName, content: md, kind: 'md' });
    if (!result.canceled) {
      setFilePath(result.filePath);
      setSavedSnapshot(md);
      setRecentFiles(pushRecentFile(result.filePath));
      toast.success(`저장됨: ${baseName(result.filePath)}`);
    }
  }, [md, state.subject, filePath]);

  const copyHtml = useCallback(async () => {
    if (!state.rendered) {
      toast.error('렌더링할 내용이 없습니다.');
      return;
    }
    try {
      await copyHtmlToClipboard({
        html: state.rendered.html,
        plain: state.rendered.plain,
      });
      toast.success('HTML 복사 완료 — Gmail/Outlook 본문에 Ctrl+V 하세요.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '복사 실패');
    }
  }, [state.rendered]);

  useEffect(() => {
    const off = window.reportApi?.onMenu((channel) => {
      const isEmail = docType === 'email';
      switch (channel) {
        case 'menu:new':
          if (!isEmail) {
            detachFile();
            setMd('');
          }
          break;
        case 'menu:load-sample':
          if (!isEmail) void loadSample();
          break;
        case 'menu:open':
          if (isEmail) void emailExport.openEmail();
          else void openFile();
          break;
        case 'menu:save':
          if (isEmail) void emailExport.saveEmail();
          else void saveFile();
          break;
        case 'menu:import-gmail':
          if (!isEmail) void importGmail();
          break;
        case 'menu:copy-html':
          if (isEmail) void emailExport.copyEmailHtml();
          else void copyHtml();
          break;
        case 'menu:help':
          setHelpOpen((v) => !v);
          break;
      }
    });
    return () => off?.();
  }, [docType, loadSample, openFile, saveFile, importGmail, copyHtml, emailExport, detachFile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) {
        if (e.key === 'F1') {
          e.preventDefault();
          setHelpOpen((v) => !v);
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (docType === 'email') {
        if (key === 's') {
          e.preventDefault();
          void emailExport.saveEmail();
        } else if (key === 'o') {
          e.preventDefault();
          void emailExport.openEmail();
        } else if (key === 'c' && e.shiftKey) {
          e.preventDefault();
          void emailExport.copyEmailHtml();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          void emailExport.createDraft();
        }
        return;
      }
      // weekly 단축키
      if (key === 's') {
        e.preventDefault();
        void saveFile();
      } else if (key === 'o') {
        e.preventDefault();
        void openFile();
      } else if (key === 'l') {
        e.preventDefault();
        void loadSample();
      } else if (key === 't') {
        e.preventDefault();
        loadTemplate();
      } else if (key === 'c' && e.shiftKey) {
        e.preventDefault();
        void copyHtml();
      } else if (key === 'i' && e.shiftKey) {
        e.preventDefault();
        void importGmail();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [docType, saveFile, openFile, loadSample, loadTemplate, copyHtml, importGmail, emailExport]);

  const previewHtml = state.rendered?.html ?? '';
  const errorCount = state.diagnostics.filter((d) => d.severity === 'error').length;

  const subjectHint = useMemo(
    () => state.subject ?? '제목은 @WEEK + @AUTHOR 기반으로 자동 생성됩니다.',
    [state.subject],
  );

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="reveal reveal-1">
        <Toolbar
          docType={docType}
          onDocTypeChange={setDocType}
          onLoadSample={loadSample}
          onLoadTemplate={loadTemplate}
          onImportGmail={importGmail}
          onOpen={openFile}
          recentFiles={recentFiles}
          onOpenRecent={openRecentFile}
          onSave={saveFile}
          onCopyHtml={copyHtml}
          copyDisabled={!state.rendered || !!state.fatalError || errorCount > 0}
          onEmailOpen={emailExport.openEmail}
          onEmailSave={emailExport.saveEmail}
          onEmailCopyHtml={emailExport.copyEmailHtml}
          onComposeGmail={emailExport.composeInGmail}
          onCreateDraft={emailExport.createDraft}
          emailActionDisabled={!emailState.rendered}
          onToggleHelp={() => setHelpOpen((v) => !v)}
          theme={theme}
          onThemeChange={setTheme}
        />
      </div>

      {/* 콘텐츠 영역 — 항상 flex-1 (푸터가 양쪽 모드 공통이라 높이 불변, 전환 시 비율 점프 없음) */}
      <main className="min-h-0 flex-1">
        {docType === 'weekly' ? (
          <Allotment defaultSizes={splitSizes} onChange={handleSplitChange}>
            <Allotment.Pane minSize={320}>
              <PaneHeader
                title={
                  filePath
                    ? `${baseName(filePath)}${dirty ? ' ●' : ''}`
                    : theme === 'mono'
                      ? 'INPUT.md'
                      : '입력'
                }
                hint="@PREV · @CURRENT · @LOC · @CUS · # 일자 · @SUM · 1) · - · <- · -> · >"
                theme={theme}
              />
              <div className="h-[calc(100%-32px)]">
                <MarkdownEditor ref={editorRef} value={md} onChange={setMd} />
              </div>
            </Allotment.Pane>
            <Allotment.Pane minSize={400}>
              <PaneHeader
                title={theme === 'mono' ? 'PREVIEW.html' : '미리보기'}
                hint={
                  state.stale
                    ? '⚠ 입력 오류 — 마지막 정상 미리보기를 유지 중입니다'
                    : subjectHint
                }
                actions={<ZoomToggle zoom={zoom} onZoomChange={setZoom} />}
                theme={theme}
              />
              <div className="h-[calc(100%-32px)]">
                <HtmlPreview html={previewHtml} zoom={zoom} />
              </div>
            </Allotment.Pane>
          </Allotment>
        ) : (
          <EmailWorkspace
            template={emailState.template}
            doc={emailDoc.doc}
            bodyKey={emailDoc.bodyKey}
            rendered={emailState.rendered}
            onTemplateChange={emailDoc.setTemplateId}
            onField={emailDoc.setField}
            onBody={emailDoc.setBody}
            onSubject={emailDoc.setSubject}
            onRegenerateSubject={emailDoc.regenerateSubject}
            zoom={zoom}
            onZoomChange={setZoom}
            theme={theme}
          />
        )}
      </main>

      {/* 통합 푸터 — 양쪽 모드 동일 높이(32px) 상시 렌더 */}
      {docType === 'weekly' ? (
        <StatusBar
          validation={state.validation}
          diagnostics={state.diagnostics}
          onJumpToLine={jumpToLine}
          fatalError={state.fatalError}
          subject={state.subject}
          theme={theme}
        />
      ) : (
        <EmailStatusBar
          validation={emailState.validation}
          recipientHint={emailState.template?.recipientHint}
          theme={theme}
        />
      )}

      <HelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        author={author}
        onAuthorChange={setAuthor}
        theme={theme}
        docType={docType}
      />
      <Toaster
        theme={theme === 'mono' ? 'dark' : 'light'}
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            border: `${theme === 'mono' ? '1.5px' : '1px'} solid var(--rule)`,
            color: 'var(--fg)',
            borderRadius: theme === 'mono' ? '0px' : '6px',
            fontFamily:
              theme === 'mono'
                ? "'JetBrains Mono', 'D2Coding', Consolas, monospace"
                : "'Pretendard Variable', Pretendard, system-ui, sans-serif",
          },
        }}
      />
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
  theme: 'paper' | 'mono';
}) {
  const isMono = theme === 'mono';
  return (
    <div className="flex h-8 flex-nowrap items-center justify-between gap-3 overflow-hidden border-b border-rule bg-bg-deep px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <span
          className={[
            'shrink-0 whitespace-nowrap text-fg-soft',
            isMono
              ? 'font-medium uppercase tracking-wider text-[10px]'
              : 'font-display text-[12px]',
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
      {actions && (
        <div className="flex shrink-0 items-center whitespace-nowrap">{actions}</div>
      )}
    </div>
  );
}
