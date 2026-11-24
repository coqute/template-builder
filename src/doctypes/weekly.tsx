import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import {
  CalendarPlus,
  ClipboardCopy,
  FileDown,
  FileSpreadsheet,
  Inbox,
  Layers,
  Mails,
  NotebookPen,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { parseTolerant, serialize } from '@core/index';
import { useAiTidy } from '../ai/useAiTidy';
import { applyWeekly, planWeeklyTidy, reviewWeekly } from '../ai/weeklyTidy';
import { loadAiModel } from '../ai/settings';
import { lineOfKey, locateLine } from '../lib/locate';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/MarkdownEditor';
import { HtmlPreview, ZoomToggle } from '../components/HtmlPreview';
import { StatusBar, type PendingItem } from '../components/StatusBar';
import { Btn, MoreMenu, OpenSplitButton } from '../components/ToolbarButton';
import { VisualWeeklyEditor, type VisualEditorHandle } from './weekly-visual/VisualWeeklyEditor';
import { WeeklyImportDialog } from '../worklog/components/WeeklyImportDialog';
import { useWeeklyState, type CombineEntry } from '../hooks/useWeeklyState';
import { copyHtmlToClipboard } from '../hooks/useClipboard';
import { fileBaseName as baseName } from '../lib/recentFiles';
import { readWithFallback, safeSetItem } from '../lib/storage';
import { plannerApi } from '../planner/api';
import { classifyEvents } from '../planner/classify';
import { insertPlanLines, plansFromEvents } from '../planner/sources/weekly';
import { useDocTypeHost, useRegisterDocTypeHandlers } from './DocTypeHost';
import type { DocTypeModule, DocTypeWorkspaceProps } from './registry';
import type { Theme } from '../hooks/useTheme';

const STORAGE_KEY_SPLIT = 'tb:split';
const LEGACY_KEY_SPLIT = 'weekly-report-builder:split';
const DEFAULT_SPLIT: [number, number] = [42, 58];
const APP_TITLE = 'Template Builder';

type EditorMode = 'visual' | 'text';
const STORAGE_KEY_EDITOR_MODE = 'tb:weekly-editor-mode:v1';

/**
 * 파서가 "건너뜁니다"로 버리는 진단 코드 — 이 줄들은 AST에 담기지 않아 비주얼 편집 1회(serialize)로 사라진다.
 * 그 상태에서 Ctrl+S가 원본 .md를 덮어쓰면 데이터가 유실되므로, 이런 md는 비주얼 모드 진입을 막는다.
 */
const LOSSY_CODES = new Set([
  'unknown-syntax',
  'content-before-day',
  'loc-before-day',
  'cus-before-day',
  'sum-before-day',
  'holiday-before-day',
  'halfday-before-day',
  'plan-invalid-date',
  // 휴일(@HOLIDAY)로 표시한 날 아래의 내용 — 저장(serialize)은 휴일 날의 블록을 쓰지 않는다
  'content-on-holiday',
]);

/** 비주얼 편집 시 유실되는 줄 번호 목록 (없으면 안전) */
export function lossyLines(md: string): number[] {
  if (!md.trim()) return [];
  return parseTolerant(md)
    .diagnostics.filter((d) => d.code !== undefined && LOSSY_CODES.has(d.code))
    .map((d) => d.line);
}

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
  const { toolbarSlot, intent, clearIntent } = useDocTypeHost();
  const w = useWeeklyState(profile.name);
  const ai = useAiTidy();
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const visualRef = useRef<VisualEditorHandle | null>(null);
  const [splitSizes] = useState<[number, number]>(loadSplit);
  const [editorMode, setEditorModeState] = useState<EditorMode>(loadEditorMode);
  const [worklogImport, setWorklogImport] = useState(false);

  const setEditorMode = useCallback((next: EditorMode) => {
    setEditorModeState(next);
    safeSetItem(STORAGE_KEY_EDITOR_MODE, next);
  }, []);

  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === editorMode) return;
      // 쓰던 위치를 들고 간다 — 모드를 바꿔도 같은 항목에서 이어 쓰도록
      const report = parseTolerant(w.md).report;
      if (next === 'visual') {
        // 막는 경우는 비주얼 편집으로 실제로 사라질 줄이 있을 때뿐이다.
        // 쓰다 만 항목(고객사 빈칸 등 검증 오류)은 비주얼에서도 그대로 보이고 고칠 수 있어 막지 않는다.
        const lossy = lossyLines(w.md);
        if (lossy.length > 0) {
          toast.error(
            `인식되지 않는 줄 ${lossy.length}개(L${lossy[0]} 등)가 있어 비주얼 모드로 전환할 수 없습니다 — 비주얼 편집 시 해당 줄이 사라집니다. 텍스트 모드에서 수정하세요.`,
          );
          return;
        }
        const at = locateLine(report, editorRef.current?.cursorLine() ?? 0);
        setEditorMode(next);
        setTimeout(() => {
          if (at.key) visualRef.current?.reveal(at.key);
          else if (at.date) visualRef.current?.revealDay(at.date);
        }, 60);
        return;
      }
      const line = lineOfKey(report, visualRef.current?.focusedItemKey() ?? null);
      setEditorMode(next);
      if (line > 0) setTimeout(() => editorRef.current?.jumpToLine(line), 60);
    },
    [editorMode, w.md, setEditorMode],
  );

  // 외부에서 들어온 md(파일 열기·Gmail 가져오기·초안 복원)에 유실 대상 줄이 있으면 비주얼 모드를 강제 해제.
  // 비주얼 모드가 기본값이라, 손으로 쓴 메모 줄이 섞인 .md를 열자마자 한 글자만 고쳐도 그 줄이 사라지고
  // Ctrl+S가 원본 파일을 덮어쓰던 데이터 손실 경로를 막는다.
  useEffect(() => {
    if (editorMode !== 'visual') return;
    const lossy = lossyLines(w.md);
    if (lossy.length === 0) return;
    setEditorMode('text');
    toast.warning(
      `인식되지 않는 줄 ${lossy.length}개(L${lossy[0]} 등)가 있어 텍스트 모드로 전환했습니다 — 비주얼 편집 시 해당 줄이 사라집니다.`,
      { duration: 8000 },
    );
  }, [w.md, editorMode, setEditorMode]);

  // 창 제목에 파일명·미저장 표시 — 여러 보고서를 오갈 때 어떤 파일을 편집 중인지 즉시 확인
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = w.filePath ? `${w.dirty ? '● ' : ''}${baseName(w.filePath)} — ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [w.filePath, w.dirty]);

  const jumpToLine = useCallback(
    (line: number) => {
      // 비주얼 모드 — 그 줄의 항목(없으면 일자)을 펼쳐 보여 준다. 항목 밖 줄(@PREV 등)만 텍스트로 전환
      if (editorMode === 'visual') {
        const at = locateLine(parseTolerant(w.md).report, line);
        if (at.key) {
          visualRef.current?.reveal(at.key);
          return;
        }
        if (at.date) {
          visualRef.current?.revealDay(at.date);
          return;
        }
      }
      if (editorMode !== 'text') {
        setEditorMode('text');
        // 전환 직후 에디터 mount를 기다렸다 점프
        setTimeout(() => editorRef.current?.jumpToLine(line), 50);
        return;
      }
      editorRef.current?.jumpToLine(line);
    },
    [editorMode, setEditorMode, w.md],
  );

  const handleSplitChange = useCallback((sizes: number[]) => {
    if (sizes.length !== 2) return;
    safeSetItem(STORAGE_KEY_SPLIT, JSON.stringify(sizes));
  }, []);

  // 홈에서 "주간보고의 이 줄"로 넘어온 경우 — 지금 문서의 그 줄로 간다
  useEffect(() => {
    if (intent?.kind !== 'weekly-line') return;
    const line = intent.line;
    clearIntent();
    setTimeout(() => jumpToLine(line), 80);
  }, [intent, clearIntent, jumpToLine]);

  useRegisterDocTypeHandlers({
    menu: {
      // 빈 문서는 쓸모가 없어 '새로 만들기'는 곧 새 주간보고(지난 주 골격)
      'menu:new': () => void w.loadTemplate(),
      'menu:draft': () => {
        if (canSend) void w.createDraft();
      },
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
          void w.loadTemplate();
          return true;
        case 'shift+c':
          void w.copyHtml();
          return true;
        case 'shift+i':
          void w.importGmail();
          return true;
        case 'shift+a':
          if (!ai.busy) void tidyWithAi();
          return true;
        case 'enter':
          if (canSend) void w.createDraft();
          return true;
        default:
          return false;
      }
    },
  });

  const errorCount = w.state.diagnostics.filter((d) => d.severity === 'error').length;
  const canSend = !!w.output && !w.state.fatalError && errorCount === 0;
  // 발송 버튼이 꺼진 이유를 버튼 툴팁으로 — 상태바를 열어 보지 않아도 알 수 있게
  const blockedHint =
    errorCount > 0 ? `오류 ${errorCount}건을 고쳐야 보낼 수 있습니다 — 상태바의 오류를 누르면 위치로 이동` : undefined;
  const subject = w.output?.subject ?? w.state.subject;
  const subjectHint = subject ?? '제목은 @PREV(보고 대상 주)로 자동 생성됩니다.';
  const previewHtml = w.output?.html ?? '';

  // 미결 대응 목록 — 발송 전 점검 (상태바 '미결 N' → 항목 바로가기)
  const pendingItems = useMemo<PendingItem[]>(() => {
    const out: PendingItem[] = [];
    w.state.report?.days.forEach((d, di) =>
      d.blocks.forEach((b, bi) =>
        b.items.forEach((it, ii) => {
          for (const c of it.content) {
            if (c.kind !== 'dialog') continue;
            for (const t of c.turns) {
              if (!t.pending || !t.text.trim()) continue;
              out.push({
                key: `${di}-${bi}-${ii}`,
                line: it.srcLine ?? 0,
                label: `${d.date.slice(5)} [${it.client}] ${it.workType}`,
                text: `${t.kind === 'in' ? '*->' : '*<-'} ${t.text.split('\n')[0]}`,
              });
            }
          }
        }),
      ),
    );
    return out;
  }, [w.state.report]);

  const jumpToPending = useCallback(
    (p: PendingItem) => {
      if (editorMode === 'visual') {
        // 접힌 일자·항목도 펼쳐서 미결 턴에 포커스
        visualRef.current?.reveal(p.key, 'textarea[data-pending="true"]');
        return;
      }
      if (p.line > 0) editorRef.current?.jumpToLine(p.line);
    },
    [editorMode],
  );

  const copySubject = useCallback(async () => {
    if (!subject) return;
    try {
      await copyHtmlToClipboard({ html: subject, plain: subject });
      toast.success(`제목 복사: ${subject}`);
    } catch {
      toast.error('제목을 복사하지 못했습니다.');
    }
  }, [subject]);

  // AI 정돈 — 지금 .md를 기준으로 계획하고, 적용 직전에 내용이 그대로인지 확인한다
  const mdRef = useRef(w.md);
  mdRef.current = w.md;
  /** 다음 주(일정 예정 범위)의 달력 일정을 `@PLAN` 줄로 넣는다 — 이미 있는 줄은 두고 없는 것만 */
  const importPlans = async () => {
    const baseMd = w.md;
    const report = parseTolerant(baseMd).report;
    const range = report.currentWeekRange;
    if (!range.start || !range.end) return void toast.info('일정 예정 범위(@CURRENT)가 없어 가져올 수 없습니다.');
    const api = plannerApi();
    const status = await api.calendarStatus();
    if (!status.canRead) return void toast.info('Google 달력이 연결되지 않았습니다 — 홈 화면의 도움말·설정(F1)에서 연결 방법을 확인하세요.');
    const store = await api.plannerGet();
    const s = store.ok ? store.state : null;
    // 홈과 다른 기간을 읽는다 — 홈이 견줄 기준(마지막으로 읽은 일정)을 덮지 않게 한 번 쓰고 버리는 읽기로
    const r = await api.calendarEvents({ from: range.start, to: range.end, calendars: s?.settings.calendars ?? ['primary'], transient: true });
    if (!r.ok) return void toast.error(`달력을 읽지 못했습니다: ${r.message}`);
    // 남의 달력(동료 등)의 일정은 내 일정 예정이 아니다
    const events = classifyEvents(r.events, { hiddenEvents: s?.hiddenEvents, hiddenTitles: s?.hiddenTitles }).filter((e) => !e.other);
    const have = report.plans ?? [];
    const add = plansFromEvents(events, range).filter((p) => !have.some((h) => h.date === p.date && h.text.trim() === p.text));
    if (add.length === 0) return void toast.info(`${range.start} ~ ${range.end}에 새로 넣을 달력 일정이 없습니다.`);
    if (mdRef.current !== baseMd) return void toast.error('가져오는 동안 내용이 바뀌어 넣지 않았습니다. 다시 실행하세요.');
    w.setMd(insertPlanLines(baseMd, add));
    const gen = w.docGen();
    toast.success(`달력 일정 ${add.length}건을 일정 예정(@PLAN)에 넣었습니다.`, {
      duration: 8000,
      action: {
        label: '되돌리기',
        onClick: () => {
          if (w.docGen() !== gen) return void toast.info('그 사이 다른 문서를 열어 되돌리지 않았습니다.');
          w.setMd(baseMd);
        },
      },
    });
  };

  const tidyWithAi = async () => {
    const baseMd = w.md;
    const report = parseTolerant(baseMd).report;
    await ai.run({
      title: 'AI 정돈 — 주간보고 문장',
      empty: '다듬을 항목이 없습니다. 항목을 쓴 뒤 실행하세요.',
      plan: () => planWeeklyTidy(report, loadAiModel()),
      request: (p) => p.request,
      review: (p, res) => reviewWeekly(report, p, res),
      apply: (p, review, picked) => {
        if (mdRef.current !== baseMd) {
          toast.error('정돈하는 동안 내용이 바뀌어 적용하지 않았습니다. 다시 실행하세요.');
          return;
        }
        w.setMd(serialize(applyWeekly(report, p, review, picked)));
        const gen = w.docGen();
        toast.success(`${picked.size}곳을 다듬었습니다.`, {
          duration: 8000,
          action: {
            label: '되돌리기',
            onClick: () => {
              // 그 사이 다른 문서를 열었으면 정돈 전 내용을 그 문서에 덮어쓰게 된다
              if (w.docGen() !== gen) {
                toast.info('그 사이 다른 문서를 열어 되돌리지 않았습니다.');
                return;
              }
              w.setMd(baseMd);
            },
          },
        });
      },
    });
  };

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            <Btn
              label="새 주간보고"
              shortcut="Ctrl+N · 지난 주 월~일 골격, 되돌리기 가능"
              icon={<CalendarPlus size={14} />}
              onClick={() => void w.loadTemplate()}
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
            <span className="mx-0.5 h-5 w-px shrink-0 bg-rule" aria-hidden="true" />
            <Btn
              label="AI 정돈"
              shortcut="Ctrl+Shift+A · 문장을 Claude로 다듬고 바뀔 곳을 확인한 뒤 적용"
              icon={<Wand2 size={14} />}
              disabled={ai.busy}
              onClick={() => void tidyWithAi()}
            />
            <Btn
              label="HTML 복사"
              shortcut="Ctrl+Shift+C"
              icon={<ClipboardCopy size={14} />}
              primary
              disabled={!canSend}
              hint={blockedHint}
              onClick={() => void w.copyHtml()}
            />
            <Btn
              label={w.draftBusy ? '생성 중…' : '임시보관함'}
              shortcut="Ctrl+Enter · 받는사람·참조는 도움말(F1)"
              icon={<Mails size={14} />}
              primary
              disabled={!canSend || w.draftBusy}
              hint={blockedHint}
              onClick={() => void w.createDraft()}
            />
            <MoreMenu
              items={[
                {
                  label: 'Gmail 본문 가져오기',
                  shortcut: 'Ctrl+Shift+I',
                  icon: <Inbox size={13} />,
                  hint: '발송한 보고 메일 본문을 복사해 둔 뒤 실행 — .md로 되살림 (되돌리기 가능)',
                  onClick: () => void w.importGmail(),
                },
                {
                  label: '작업일지에서 가져오기',
                  icon: <NotebookPen size={13} />,
                  hint: '한 주의 작업일지(■ ▶ -)로 주간보고를 만듭니다 — 요청자별 고객사|작업구분은 지난 보고에서 (되돌리기 가능)',
                  onClick: () => setWorklogImport(true),
                },
                {
                  label: '다음 주 일정 가져오기 (달력)',
                  icon: <CalendarPlus size={13} />,
                  hint: '일정 예정 범위의 Google 달력 일정을 @PLAN 줄로 넣습니다 — 이미 있는 줄은 그대로 (되돌리기 가능)',
                  onClick: () => void importPlans(),
                },
                {
                  label: '샘플 보기',
                  shortcut: 'Ctrl+L',
                  icon: <Sparkles size={13} />,
                  hint: '형식 예시 (되돌리기 가능)',
                  onClick: () => void w.loadSample(),
                },
              ]}
            />
          </>,
          toolbarSlot,
        )}
      {ai.view}
      {worklogImport && (
        <WeeklyImportDialog
          currentMd={w.md}
          author={profile.name}
          company={profile.company}
          recentFiles={w.recentFiles}
          onApply={(md, message) => {
            setWorklogImport(false);
            w.replaceWith(md, message);
          }}
          onClose={() => setWorklogImport(false)}
        />
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
                    : '@PREV · @CURRENT · @LOC · @CUS · # 일자 · @SUM · @HOLIDAY · @HALFDAY · 1) · - · <- · -> · >'
                }
                actions={<EditorModeToggle mode={editorMode} onChange={switchMode} />}
                theme={theme}
              />
              <div className="h-[calc(100%-32px)]">
                {editorMode === 'visual' ? (
                  <VisualWeeklyEditor ref={visualRef} md={w.md} onMd={w.setMd} />
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
                actions={
                  <div className="flex items-center gap-2">
                    <CombineControl
                      extras={w.extras}
                      onAdd={() => void w.addCombineFiles()}
                      onRemove={w.removeExtra}
                      onClear={w.clearExtras}
                    />
                    <ZoomToggle zoom={zoom} onZoomChange={onZoomChange} />
                  </div>
                }
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
          subject={subject}
          onCopySubject={() => void copySubject()}
          pending={w.state.validation?.stats.pending ?? 0}
          pendingItems={pendingItems}
          onJumpPending={jumpToPending}
          theme={theme}
        />
      </div>
    </>
  );
}

/** 합본 — 이전 주 .md를 골라 최근 주부터 이어 붙인다 (미리보기·복사·임시보관함 모두 합본 기준) */
function CombineControl({
  extras,
  onAdd,
  onRemove,
  onClear,
}: {
  extras: CombineEntry[];
  onAdd: () => void;
  onRemove: (filePath: string) => void;
  onClear: () => void;
}) {
  const label = (e: CombineEntry) => `${e.report.prevWeekRange.start.slice(5).replace('-', '/')}주`;
  return (
    <div className="flex items-center gap-1">
      {extras.map((e) => (
        <span
          key={e.filePath}
          className="flex items-center gap-0.5 rounded-sharp border border-rule px-1 py-0.5 text-[10px] text-fg-soft"
          title={e.filePath}
        >
          {label(e)}
          <button type="button" onClick={() => onRemove(e.filePath)} aria-label="합본에서 제외" className="hover:text-fg">
            <X size={10} />
          </button>
        </span>
      ))}
      {extras.length > 1 && (
        <button type="button" onClick={onClear} className="text-[10px] text-fg-muted hover:text-fg" title="합본 전체 해제">
          해제
        </button>
      )}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1 rounded-sharp border border-rule px-1.5 py-0.5 text-[10px] text-fg-soft transition hover:bg-bg-sunken hover:text-fg"
        title="건너뛴 주가 있으면 이전 주 .md를 골라 한 메일로 합본 (최근 주가 위)"
      >
        <Layers size={11} />
        {extras.length > 0 ? `합본 ${extras.length + 1}주` : '합본'}
      </button>
    </div>
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
      role="radio"
      aria-checked={mode === value}
      onClick={() => onChange(value)}
      className={[
        'rounded-sharp px-1.5 py-0.5 text-[10px] leading-none transition',
        mode === value ? 'font-semibold' : 'text-fg-soft hover:text-fg',
      ].join(' ')}
      style={mode === value ? { background: 'var(--accent)', color: 'var(--bg)' } : undefined}
      title={value === 'visual' ? '폼 기반 작성 (문법 불필요)' : '.md 텍스트 직접 편집 (자동완성·린트)'}
    >
      {label}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label="편집 방식"
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
  Workspace: WeeklyWorkspace,
};
