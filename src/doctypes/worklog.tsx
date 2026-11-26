import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { CalendarCheck, CalendarPlus, FileDown, FolderOpen, FolderSearch, MessagesSquare, NotebookPen, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Btn, MoreMenu } from '../components/ToolbarButton';
import { WorklogEditor, type WorklogEditorHandle } from '../components/WorklogEditor';
import { sameRef, useWorklog } from '../worklog/useWorklog';
import { WorklogSidebar, type WorklogSidebarHandle } from '../worklog/components/WorklogSidebar';
import { WorklogCreateDialog } from '../worklog/components/WorklogCreateDialog';
import { WorklogStatusBar } from '../worklog/components/WorklogStatusBar';
import { BlockFromChatDialog } from '../worklog/components/BlockFromChatDialog';
import { isoToday, parseWorklog, weekdayOf } from '../worklog/format';
import { lintWorklog } from '../worklog/lint';
import { MARKERS, type LinePin, type MarkerKind } from '../worklog/editor';
import { anchorOf, caseAtLine, findAnchor, insertScheduleLine } from '../planner/anchor';
import { plannerApi } from '../planner/api';
import { LinkDialog, type LinkRequest } from '../planner/components/LinkDialog';
import { md } from '../planner/dates';
import { eventKey } from '../planner/ops';
import type { PlannerState, WorklogAnchor } from '../planner/types';
import { folderClient } from '../planner/usePlanner';
import '../styles/planner.css';
import { useDocTypeHost, useRegisterDocTypeHandlers } from './DocTypeHost';
import type { DocTypeModule, DocTypeWorkspaceProps } from './registry';

const MARKER_BUTTONS: Array<{ kind: MarkerKind; label: string; hint: string }> = [
  { kind: 'case', label: '■ 사안', hint: 'Ctrl+1 · 무엇을 해야 했는가 — ■ (요청자/채널) 사안' },
  { kind: 'act', label: '▶ 수행', hint: 'Ctrl+2 · 내가 한 일 (시간순)' },
  { kind: 'fact', label: '- 사실', hint: 'Ctrl+3 · 그 결과 확정된 사실 (Tab → 부연)' },
  { kind: 'detail', label: '> 부연', hint: 'Ctrl+4 · 사실을 이해하는 데 필요한 한 줄 (Shift+Tab → 사실)' },
  { kind: 'note', label: '※ 참고', hint: 'Ctrl+5 · ■ 아래 배경·상태, ▶ 뒤에는 전달물(원문 그대로)' },
];

function WorklogWorkspace({ profile }: DocTypeWorkspaceProps) {
  const { toolbarSlot, navigate, intent, clearIntent } = useDocTypeHost();
  // 홈에서 "이 사안 열기"로 넘어왔으면 오늘 일지 대신 그 파일을 먼저 연다
  const openAnchor = intent?.kind === 'worklog-open' ? intent.anchor : null;
  const wl = useWorklog({ initial: openAnchor ? { folder: openAnchor.folder, name: openAnchor.name } : null });
  const editorRef = useRef<WorklogEditorHandle | null>(null);
  const sidebarRef = useRef<WorklogSidebarHandle | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState<string | null>(null);

  const fileCtx = useMemo(() => (wl.current ? { date: wl.current.date, title: wl.current.title } : null), [wl.current]);
  const doc = useMemo(() => parseWorklog(wl.text), [wl.text]);
  const issues = useMemo(() => (wl.current ? lintWorklog(wl.text, fileCtx, doc) : []), [wl.text, fileCtx, doc, wl.current]);
  const counts = useMemo(
    () => ({ cases: doc.blocks.filter((b) => b.kind === 'case').length, acts: doc.blocks.reduce((n, b) => n + b.acts.length, 0) }),
    [doc],
  );

  // ── 홈(플래너)과 잇기 — 넘어온 사안으로 이동, 사안에 일정·할 일 달기, ■ 줄 표지 ──────────────
  const planner = useMemo(plannerApi, []);
  const [plan, setPlan] = useState<PlannerState | null>(null);
  const [canEvent, setCanEvent] = useState(false);
  const [linkTarget, setLinkTarget] = useState<WorklogAnchor | null>(null);
  const [linking, setLinking] = useState(false);
  useEffect(() => {
    let alive = true;
    void planner.plannerGet().then((r) => alive && r.ok && setPlan(r.state));
    void planner.calendarStatus().then((s) => alive && setCanEvent(s.canWrite));
    return () => {
      alive = false;
    };
  }, [planner]);

  useEffect(() => {
    if (!openAnchor || wl.files.length === 0) return;
    const target = wl.files.find((f) => f.folder === openAnchor.folder && f.name === openAnchor.name);
    if (!target) {
      toast.info('그 일지 파일을 찾지 못했습니다 — 이름이 바뀌었거나 지워졌습니다.');
      clearIntent();
      return;
    }
    if (!wl.current) return; // 처음 여는 중
    if (!sameRef(wl.current, target)) {
      void wl.open(target);
      return;
    }
    const line = findAnchor(doc, openAnchor)?.startLine ?? openAnchor.line;
    clearIntent();
    setTimeout(() => editorRef.current?.jumpToLine(line), 40);
    // wl.open은 열린 파일이 바뀔 때만 다시 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAnchor, wl.files, wl.current, doc, clearIntent]);

  /** 이 일지의 ■ 줄에 붙일 표지 — 그 사안에 달린 할 일·달력 일정 */
  const pins = useMemo((): LinePin[] => {
    if (!plan || !wl.current) return [];
    const cur = wl.current;
    const mine = (a: WorklogAnchor) => a.folder === cur.folder && a.name === cur.name;
    const byLine = new Map<number, { labels: string[]; id: string }>();
    const add = (a: WorklogAnchor, label: string, id: string) => {
      const line = findAnchor(doc, a)?.startLine;
      if (!line) return;
      const hit = byLine.get(line);
      if (hit) hit.labels.push(label);
      else byLine.set(line, { labels: [label], id });
    };
    for (const task of plan.tasks) {
      if (task.doneAt || task.origin.kind !== 'worklog' || !mine(task.origin.anchor)) continue;
      add(task.origin.anchor, task.state === 'waiting' ? '기다리는 중' : task.due ? `${md(task.due)} 할 일` : '할 일', `task:${task.id}`);
    }
    for (const link of plan.links) if (mine(link.anchor)) add(link.anchor, '달력 일정', `event:${eventKey(link)}`);
    return [...byLine].map(([line, v]) => ({ line, id: v.id, label: v.labels.length > 1 ? `${v.labels[0]} 외 ${v.labels.length - 1}` : v.labels[0] }));
  }, [plan, wl.current, doc]);

  const onPin = useCallback(
    (id: string) => {
      const [kind, ...rest] = id.split(':');
      const key = rest.join(':');
      navigate('home', kind === 'task' ? { kind: 'home-focus', taskId: key } : { kind: 'home-focus', eventKey: key });
    },
    [navigate],
  );

  const openLink = () => {
    if (!wl.current) return void toast.info('일지를 먼저 여세요.');
    const block = caseAtLine(doc, editorRef.current?.cursorLine() ?? 0);
    if (!block || !block.title.trim()) return void toast.info('커서를 ■ 사안 안에 두고 다시 실행하세요.');
    setLinkTarget(anchorOf({ folder: wl.current.folder, name: wl.current.name, date: wl.current.date }, doc, block));
  };

  const submitLink = async (req: LinkRequest) => {
    const anchor = linkTarget;
    const file = wl.current;
    if (!anchor || !file) return;
    setLinking(true);
    let focus: { kind: 'home-focus'; taskId?: string; eventKey?: string } | null = null;
    let next: PlannerState | null = null;
    if (req.as === 'task') {
      const id = `t_${Date.now().toString(36)}`;
      const r = await planner.plannerApply({
        type: 'task.add',
        id,
        draft: { title: req.title, due: req.date, client: folderClient(anchor.folder), who: anchor.source.split('/')[0].trim(), origin: { kind: 'worklog', anchor } },
      });
      if (r.ok) {
        next = r.state;
        focus = { kind: 'home-focus', taskId: id };
      } else toast.error(`달지 못했습니다: ${r.error}`);
    } else {
      const ev = await planner.calendarInsert({ summary: req.title, allDay: false, start: `${req.date}T${req.start}`, end: `${req.date}T${req.end}` });
      if (!ev.ok) toast.error(`달력에 만들지 못했습니다: ${ev.message}`);
      else {
        const ref = { calendarId: ev.event.calendarId, eventId: ev.event.id };
        const r = await planner.plannerApply({ type: 'link.set', link: { ...ref, anchor } });
        if (r.ok) {
          next = r.state;
          focus = { kind: 'home-focus', eventKey: eventKey(ref) };
        } else toast.error(`달력에는 만들었지만 일지와 잇지 못했습니다: ${r.error}`);
      }
    }
    setLinking(false);
    if (!next || !focus) return;
    setPlan(next);
    setLinkTarget(null);
    if (req.logLine) {
      // 달기 창을 여는 사이 다른 일지를 열었으면 그 일지에는 넣지 않는다
      const block = findAnchor(parseWorklog(textRef.current), anchor);
      if (block) wl.setTextFor(file, insertScheduleLine(textRef.current, block, req.logLine), '그 사이 다른 일지를 열어 일지에는 적지 않았습니다.');
    }
    const target = focus;
    toast.success(req.as === 'task' ? `${md(req.date)} 할 일로 달았습니다.` : `${md(req.date)} ${req.start} 일정을 달력에 만들고 이 사안과 이었습니다.`, {
      duration: 8000,
      action: { label: '홈에서 보기', onClick: () => navigate('home', target) },
    });
  };

  const openAt = useCallback(
    async (entry: Parameters<typeof wl.open>[0], line?: number) => {
      const ok = await wl.open(entry);
      if (ok && line) setTimeout(() => editorRef.current?.jumpToLine(line), 30);
    },
    [wl],
  );

  /** 오늘 일지 — 있으면 열고(같은 날 파일 중복 방지), 없으면 만들기 */
  const openToday = useCallback(() => {
    const today = wl.todayFiles();
    if (today.length > 0) {
      void wl.open(today[0]).then(() => {
        if (today.length > 1) toast.info(`오늘 일지가 ${today.length}개 폴더에 있습니다 — 목록에서 고르세요.`);
        setTimeout(() => editorRef.current?.focus(), 30);
      });
      return;
    }
    setCreateOpen(true);
  }, [wl]);

  const textRef = useRef(wl.text);
  textRef.current = wl.text;
  const openChat = () => {
    if (!wl.current) {
      toast.info('블록을 넣을 일지를 먼저 여세요 (오늘 일지: Ctrl+N).');
      return;
    }
    setChatOpen(editorRef.current?.selectedText() ?? '');
  };

  useRegisterDocTypeHandlers({
    menu: {
      'menu:new': openToday,
      'menu:save': () => void wl.save(),
      'menu:open': () => sidebarRef.current?.focusSearch(),
    },
    shortcut: (combo) => {
      switch (combo) {
        case 'n':
          openToday();
          return true;
        case 's':
          void wl.save();
          return true;
        case 'f':
          sidebarRef.current?.focusSearch();
          return true;
        case 'shift+b':
          openChat();
          return true;
        case 'shift+d':
          openLink();
          return true;
        default:
          return false;
      }
    },
  });

  const noRoot = wl.config !== null && !wl.config.root;
  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            <Btn label="오늘 일지" shortcut="Ctrl+N · 있으면 열고, 없으면 새로 만듦" icon={<CalendarCheck size={14} />} onClick={openToday} />
            <Btn label="저장" shortcut="Ctrl+S · 쓰기를 멈추면 자동 저장" icon={<FileDown size={14} />} disabled={!wl.current} onClick={() => void wl.save()} />
            <span className="mx-0.5 h-5 w-px shrink-0 bg-rule" aria-hidden="true" />
            <Btn
              label="대화 → 블록"
              shortcut="Ctrl+Shift+B · 메신저·카톡 대화를 붙여 넣으면 ■ ▶ - 블록으로 정리 (Claude)"
              icon={<MessagesSquare size={14} />}
              primary
              disabled={!wl.current}
              onClick={openChat}
            />
            <Btn
              label="일정·할 일 달기"
              shortcut="Ctrl+Shift+D · 커서가 있는 ■ 사안에 기한(할 일)이나 달력 일정을 달아 홈에 올림"
              icon={<CalendarPlus size={14} />}
              disabled={!wl.current}
              onClick={openLink}
            />
            <MoreMenu
              items={[
                { label: '새 일지 (날짜 고르기)', icon: <NotebookPen size={13} />, onClick: () => setCreateOpen(true) },
                { label: '목록 새로 고침', icon: <RefreshCw size={13} />, onClick: () => void wl.refreshList().then(() => wl.refreshCorpus()) },
                {
                  label: '탐색기에서 보기',
                  icon: <FolderSearch size={13} />,
                  onClick: () => void window.reportApi?.worklogReveal(wl.current ?? undefined),
                },
                { label: '작업일지 폴더 바꾸기', icon: <FolderOpen size={13} />, hint: wl.config?.root, onClick: () => void wl.pickRoot() },
              ]}
            />
          </>,
          toolbarSlot,
        )}
      {linkTarget && (
        <LinkDialog anchor={linkTarget} today={isoToday()} canEvent={canEvent} busy={linking} onSubmit={(req) => void submitLink(req)} onClose={() => setLinkTarget(null)} />
      )}
      {createOpen && wl.config && (
        <WorklogCreateDialog
          folders={wl.config.folders}
          files={wl.files}
          defaultFolder={wl.current?.folder}
          onCreate={wl.create}
          onOpen={(e) => void wl.open(e)}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {chatOpen !== null && wl.current && (
        <BlockFromChatDialog
          date={wl.current.date}
          myName={profile.name}
          vocab={wl.vocab}
          initialChat={chatOpen}
          onInsert={(text, where) => {
            setChatOpen(null);
            if (where === 'end') editorRef.current?.appendBlock(text);
            else editorRef.current?.insertBlock(text);
            toast.success('블록을 넣었습니다 — 잠시 뒤 자동 저장됩니다.');
          }}
          onClose={() => setChatOpen(null)}
        />
      )}
      <div className="flex h-full flex-col">
        <main className="min-h-0 flex-1">
          {noRoot ? (
            <EmptyRoot onPick={() => void wl.pickRoot()} />
          ) : (
            <Allotment defaultSizes={[26, 74]}>
              <Allotment.Pane minSize={220} preferredSize={280}>
                <WorklogSidebar ref={sidebarRef} files={wl.files} corpus={wl.corpus} current={wl.current} dirty={wl.dirty} onOpen={(e, line) => void openAt(e, line)} />
              </Allotment.Pane>
              <Allotment.Pane minSize={420}>
                <div className="flex h-8 items-center justify-between gap-2 overflow-hidden border-b border-rule bg-bg-deep px-3 text-[11px]">
                  <span className="min-w-0 truncate font-display text-[12px] text-fg-soft" title={wl.current?.name}>
                    {wl.current ? `${wl.current.date} (${weekdayOf(wl.current.date)}) ${wl.current.title}${wl.dirty ? ' ●' : ''}` : '작업일지'}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5" role="toolbar" aria-label="줄 기호">
                    {MARKER_BUTTONS.map((m) => (
                      <button
                        key={m.kind}
                        type="button"
                        disabled={!wl.current}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => editorRef.current?.setMarker(m.kind)}
                        title={m.hint}
                        aria-label={`${MARKERS[m.kind].trim()} 줄로 바꾸기`}
                        className="rounded-sharp border border-transparent px-1.5 py-0.5 text-[11px] text-fg-soft hover:border-rule hover:bg-bg-sunken hover:text-fg disabled:opacity-40"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                {wl.conflict && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2 text-[12px]" style={{ background: 'var(--bg-sunken)' }} role="alert">
                    <span className="min-w-0 flex-1 text-fg">
                      다른 프로그램에서 이 파일이 바뀌었습니다(작업일지 루틴의 덧붙이기가 아닌 변경). 자동 저장을 멈췄습니다 — 어느 쪽을 쓸지 고르세요.
                    </span>
                    <button type="button" onClick={wl.takeDisk} className="rounded-sharp border border-rule px-2 py-1 hover:border-fg">
                      파일 내용 불러오기
                    </button>
                    <button type="button" onClick={wl.keepMine} className="rounded-sharp px-2 py-1 font-semibold" style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
                      내 내용으로 덮어쓰기 (백업 후)
                    </button>
                  </div>
                )}
                <div className={wl.conflict ? 'h-[calc(100%-32px-41px)]' : 'h-[calc(100%-32px)]'}>
                  {wl.current ? (
                    <WorklogEditor ref={editorRef} value={wl.text} onChange={wl.setText} file={fileCtx} vocab={wl.vocab} onFix={wl.applyFix} onBlur={() => void wl.save()} pins={pins} onPin={onPin} />
                  ) : (
                    <EmptyFile hasFiles={wl.files.length > 0} onToday={openToday} />
                  )}
                </div>
              </Allotment.Pane>
            </Allotment>
          )}
        </main>
        <WorklogStatusBar
          current={wl.current}
          status={wl.status}
          dirty={wl.dirty}
          savedAt={wl.savedAt}
          error={wl.error}
          issues={issues}
          counts={counts}
          onJump={(line) => editorRef.current?.jumpToLine(line)}
          onFix={wl.applyFix}
        />
      </div>
    </>
  );
}

function EmptyRoot({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <NotebookPen size={28} className="text-fg-muted" aria-hidden="true" />
      <div>
        <p className="text-sm font-semibold text-fg">작업일지 폴더를 고르세요</p>
        <p className="mt-1 max-w-[440px] text-[12px] leading-relaxed text-fg-muted">
          [YYYY-MM-DD] 제목.txt 파일이 든 폴더, 또는 그런 폴더들이 들어 있는 위 폴더를 고르면 됩니다. 파일은 그 자리에서 읽고 쓰며 다른 곳으로 옮기지 않습니다.
        </p>
      </div>
      <button type="button" onClick={onPick} className="rounded-sharp px-3.5 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
        폴더 고르기
      </button>
    </div>
  );
}

function EmptyFile({ hasFiles, onToday }: { hasFiles: boolean; onToday: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-[12.5px] text-fg-muted">{hasFiles ? '왼쪽 목록에서 일지를 고르거나 오늘 일지를 여세요.' : '아직 일지가 없습니다.'}</p>
      <button type="button" onClick={onToday} className="rounded-sharp px-3.5 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
        오늘 일지 (Ctrl+N)
      </button>
    </div>
  );
}

export const worklogModule: DocTypeModule = {
  id: 'worklog',
  label: '작업일지',
  switchIcon: <NotebookPen size={12} />,
  switchHint: '작업일지 .txt — 루틴과 함께 쓰는 일일 기록',
  Workspace: WorklogWorkspace,
};
