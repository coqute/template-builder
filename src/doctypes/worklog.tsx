import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { CalendarCheck, FileDown, FolderOpen, FolderSearch, MessagesSquare, NotebookPen, RefreshCw, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Btn, MoreMenu } from '../components/ToolbarButton';
import { WorklogEditor, type WorklogEditorHandle } from '../components/WorklogEditor';
import { useAiTidy } from '../ai/useAiTidy';
import { applyWorklogTidy, planWorklogTidy, reviewWorklogTidy } from '../ai/worklogAi';
import { loadAiModel } from '../ai/settings';
import { useWorklog } from '../worklog/useWorklog';
import { WorklogSidebar, type WorklogSidebarHandle } from '../worklog/components/WorklogSidebar';
import { WorklogCreateDialog } from '../worklog/components/WorklogCreateDialog';
import { WorklogStatusBar } from '../worklog/components/WorklogStatusBar';
import { BlockFromChatDialog } from '../worklog/components/BlockFromChatDialog';
import { parseWorklog, weekdayOf } from '../worklog/format';
import { lintWorklog } from '../worklog/lint';
import { MARKERS, type MarkerKind } from '../worklog/editor';
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
  const { toolbarSlot } = useDocTypeHost();
  const wl = useWorklog();
  const editorRef = useRef<WorklogEditorHandle | null>(null);
  const sidebarRef = useRef<WorklogSidebarHandle | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState<string | null>(null);
  const ai = useAiTidy();

  const fileCtx = useMemo(() => (wl.current ? { date: wl.current.date, title: wl.current.title } : null), [wl.current]);
  const doc = useMemo(() => parseWorklog(wl.text), [wl.text]);
  const issues = useMemo(() => (wl.current ? lintWorklog(wl.text, fileCtx, doc) : []), [wl.text, fileCtx, doc, wl.current]);
  const counts = useMemo(
    () => ({ cases: doc.blocks.filter((b) => b.kind === 'case').length, acts: doc.blocks.reduce((n, b) => n + b.acts.length, 0) }),
    [doc],
  );
  const names = useMemo(() => [...wl.vocab.requesters.map((r) => r.name), profile.name].filter(Boolean), [wl.vocab, profile.name]);

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
  const tidyWithAi = async () => {
    if (!wl.current) {
      toast.info('일지를 먼저 여세요.');
      return;
    }
    const base = wl.text;
    const file = wl.current;
    await ai.run({
      title: `AI 정돈 — ${wl.current.date} 작업일지`,
      empty: '다듬을 줄(■ ▶ - > ※)이 없습니다.',
      plan: () => planWorklogTidy(base, names, loadAiModel()),
      request: (p) => p.request,
      review: (p, res) => reviewWorklogTidy(p, res),
      apply: (p, review, picked) => {
        if (textRef.current !== base) {
          toast.error('정돈하는 동안 내용이 바뀌어 적용하지 않았습니다(작업일지 루틴이 덧붙였을 수 있음). 다시 실행하세요.');
          return;
        }
        // 정돈하는 동안 다른 일지를 열었으면 그 일지에 이 일지의 내용을 넣게 된다
        if (!wl.setTextFor(file, applyWorklogTidy(base, p, review, picked), '정돈하는 동안 다른 일지를 열어 적용하지 않았습니다. 다시 실행하세요.')) return;
        toast.success(`${picked.size}줄을 다듬었습니다.`, {
          duration: 8000,
          action: { label: '되돌리기', onClick: () => void wl.setTextFor(file, base, '그 사이 다른 일지를 열어 되돌리지 않았습니다.') },
        });
      },
    });
  };

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
        case 'shift+a':
          if (!ai.busy) void tidyWithAi();
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
              label="AI 정돈"
              shortcut="Ctrl+Shift+A · 일지 문장을 Claude로 다듬고 바뀔 곳을 확인한 뒤 적용"
              icon={<Wand2 size={14} />}
              disabled={ai.busy || !wl.current}
              onClick={() => void tidyWithAi()}
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
      {ai.view}
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
                    <WorklogEditor ref={editorRef} value={wl.text} onChange={wl.setText} file={fileCtx} vocab={wl.vocab} onFix={wl.applyFix} onBlur={() => void wl.save()} />
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
