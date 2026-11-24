/**
 * 홈 — 남은 작업·앞으로 할 작업(할 일)과 이미 정해진 일정을 한 화면에 (설계 docs/home-schedule-design.md).
 * 켜면 먼저 보이는 화면이다. 원본(작업일지·주간보고·Google 달력)은 읽기만 하고, 사용자가 단추를 누를 때만 쓴다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, CheckSquare, EyeOff, FolderOpen, History, Home, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { sameCustomer } from '@core/index';
import { BTN_GHOST, BTN_SOLID, Modal, SOLID_STYLE } from '../components/Modal';
import { Btn, MoreMenu } from '../components/ToolbarButton';
import { Agenda, type EventActions } from '../planner/components/Agenda';
import { EventDialog } from '../planner/components/EventDialog';
import { ChangeBanner, EmptyBox, SummaryBar, WeekStrip } from '../planner/components/HomeParts';
import { TaskList, type TaskActions } from '../planner/components/TaskList';
import type { HomeEvent } from '../planner/classify';
import { clock, mdw, parseQuickAdd } from '../planner/dates';
import { eventKey, undoOps } from '../planner/ops';
import type { Candidate } from '../planner/sources/worklog';
import type { EventInput, PlannerLogEntry, Task, TaskOrigin } from '../planner/types';
import { folderClient, usePlanner } from '../planner/usePlanner';
import { appendToWorklog, doneBlock, eventBlock } from '../planner/worklogWrite';
import '../styles/planner.css';
import { useDocTypeHost, useRegisterDocTypeHandlers } from './DocTypeHost';
import type { DocTypeModule, DocTypeWorkspaceProps } from './registry';

const UNDO_MS = 8000;
const CALENDAR_URL = 'https://calendar.google.com/calendar/';

const OP_LABEL: Record<PlannerLogEntry['op'], string> = {
  'task.add': '더함',
  'task.update': '고침',
  'task.done': '끝냄',
  'task.remove': '지움',
  'task.restore': '되살림',
  'candidate.hide': '후보 무시',
  'event.hide': '일정 숨김',
  'title.hide': '제목 숨김',
  'link.set': '일정 ↔ 일지 이음',
  'link.remove': '이음 끊음',
  settings: '설정',
};

/** 기록 한 줄 → 화면에 보일 말 */
function logLine(e: PlannerLogEntry): { when: string; what: string; title: string } {
  const after = (e.after ?? {}) as { title?: string; doneAt?: string | null; hidden?: boolean; key?: string };
  const before = (e.before ?? {}) as { title?: string };
  const d = new Date(e.at);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const when = Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  let what = OP_LABEL[e.op] ?? e.op;
  if (e.op === 'task.done' && !after.doneAt) what = '끝냄 취소';
  if ((e.op === 'candidate.hide' || e.op === 'event.hide' || e.op === 'title.hide') && after.hidden === false) what = '되살림';
  return { when, what, title: after.title ?? before.title ?? '' };
}

function HomeWorkspace(_props: DocTypeWorkspaceProps) {
  const { toolbarSlot, navigate, intent, clearIntent } = useDocTypeHost();
  const p = usePlanner();
  const { api, today, state, apply } = p;
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [log, setLog] = useState<PlannerLogEntry[] | null>(null);
  const [eventDialog, setEventDialog] = useState<{ event: HomeEvent | null } | null>(null);
  const [removing, setRemoving] = useState<HomeEvent | null>(null);
  const [writing, setWriting] = useState(false);
  const addRef = useRef<HTMLInputElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const canWrite = !!p.cal.status?.canWrite;

  // 다른 화면에서 "이 항목을 보여 달라"고 넘어온 경우 — 목록이 그려진 뒤 그 줄로 가서 잠깐 테두리를 두른다
  const loaded = !!state;
  useEffect(() => {
    if (intent?.kind !== 'home-focus' || !loaded) return;
    const key = intent.taskId ?? intent.eventKey ?? null;
    clearIntent();
    setFlash(key);
    if (!key) return;
    window.setTimeout(() => {
      const hit = [...(mainRef.current?.querySelectorAll('[data-task], [data-event]') ?? [])].find(
        (el) => el.getAttribute('data-task') === key || el.getAttribute('data-event') === key,
      );
      hit?.scrollIntoView({ block: 'center' });
    }, 60);
    window.setTimeout(() => setFlash((cur) => (cur === key ? null : cur)), 2600);
  }, [intent, loaded, clearIntent]);

  const focusAdd = useCallback(() => {
    addRef.current?.focus();
    addRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const addTask = async () => {
    const { title, due } = parseQuickAdd(draft, today);
    if (!title) return;
    if (await apply({ type: 'task.add', draft: { title, due } })) setDraft('');
  };

  /** 그 고객사의 작업일지 폴더 — 없으면 파일이 가장 많은 폴더 */
  const folderFor = useCallback(
    (client: string): string => p.wl.folders.find((f) => !!client && sameCustomer(folderClient(f), client)) ?? p.wl.folders[0] ?? '',
    [p.wl.folders],
  );

  const logDone = async (task: Task) => {
    const folder = task.origin.kind === 'worklog' ? task.origin.anchor.folder : folderFor(task.client);
    const r = await appendToWorklog(api, { folder, date: today, title: task.title, block: doneBlock(task, today) });
    if (r.ok) toast.success(r.created ? `오늘 일지를 만들어 기록했습니다: ${r.name}` : `오늘 일지 끝에 기록했습니다: ${r.name}`);
    else toast.error(`일지에 기록하지 못했습니다: ${r.error}`);
  };

  const taskActions: TaskActions = {
    toggleDone: async (task) => {
      const done = !task.doneAt;
      if (!(await apply({ type: 'task.done', id: task.id, done })) || !done) return;
      toast.success(`끝냄 — ${task.title}`, {
        duration: UNDO_MS,
        action: { label: '되돌리기', onClick: () => void apply({ type: 'task.done', id: task.id, done: false }) },
        cancel: p.wl.ready ? { label: '오늘 일지에 기록', onClick: () => void logDone(task) } : undefined,
      });
    },
    update: (id, patch) => void apply({ type: 'task.update', id, patch }),
    remove: async (task) => {
      if (!(await apply({ type: 'task.remove', id: task.id }))) return;
      toast.success(`지움 — ${task.title}`, { duration: UNDO_MS, action: { label: '되돌리기', onClick: () => void apply({ type: 'task.restore', task }) } });
    },
    openOrigin: (origin: TaskOrigin) => {
      if (origin.kind === 'worklog') navigate('worklog', { kind: 'worklog-open', anchor: origin.anchor });
      else if (origin.kind === 'weekly') navigate('weekly', !origin.file && origin.line > 0 ? { kind: 'weekly-line', line: origin.line } : undefined);
    },
    promote: async (c: Candidate) => {
      const origin: TaskOrigin = c.anchor ? { kind: 'worklog', anchor: c.anchor } : { kind: 'weekly', file: c.weekly?.file ?? '', line: c.weekly?.line ?? 0 };
      const s = await apply({
        type: 'task.add',
        draft: { title: c.title, client: c.client, who: c.who, due: c.due, state: c.cls === 'wait' ? 'waiting' : 'todo', waitingOn: c.waitingOn, note: c.phrase, origin },
      });
      if (s) toast.success(c.cls === 'wait' ? '기다리는 중으로 올렸습니다.' : '할 일로 올렸습니다.');
    },
    ignore: async (c: Candidate) => {
      if (!(await apply({ type: 'candidate.hide', key: c.key, hidden: true }))) return;
      toast.success(`후보에서 뺐습니다 — ${c.title}`, { duration: UNDO_MS, action: { label: '되돌리기', onClick: () => void apply({ type: 'candidate.hide', key: c.key, hidden: false }) } });
    },
    toCalendar: canWrite
      ? async (task) => {
          if (!task.due) return;
          const r = await api.calendarInsert({ summary: task.title, allDay: true, start: task.due, end: task.due });
          if (!r.ok) return void toast.error(`달력에 올리지 못했습니다: ${r.message}`);
          await apply({ type: 'task.update', id: task.id, patch: { event: { calendarId: r.event.calendarId, eventId: r.event.id } } });
          await p.reloadCalendar();
          toast.success(`${mdw(task.due)} 종일 일정으로 달력에 올렸습니다.`);
        }
      : undefined,
  };

  const linked = useMemo(() => new Set((state?.links ?? []).map(eventKey)), [state?.links]);
  const claudeIds = useMemo(() => new Set(p.claudeChanged.map((t) => t.id)), [p.claudeChanged]);

  const openLog = async () => setLog(await p.readLog());
  const undoEntry = async (entry: PlannerLogEntry) => {
    if (await p.undo(entry)) {
      toast.success('되돌렸습니다.');
      setLog(await p.readLog());
    } else toast.error('되돌리지 못했습니다 — 그 뒤에 다시 바뀌었을 수 있습니다.');
  };

  const eventActions: EventActions = {
    open: (e) => void (e.htmlLink && api.openExternal(e.htmlLink)),
    hide: async (e, byTitle) => {
      if (!e.ref) return;
      const on = (hidden: boolean) => (byTitle ? apply({ type: 'title.hide', title: e.title, hidden }) : apply({ type: 'event.hide', ref: e.ref!, hidden }));
      if (!(await on(true))) return;
      toast.success(byTitle ? `'${e.title}' 제목의 일정을 늘 숨깁니다.` : `숨겼습니다 — ${e.title}`, { duration: UNDO_MS, action: { label: '되돌리기', onClick: () => void on(false) } });
    },
    openCase: (e) => {
      const link = state?.links.find((l) => eventKey(l) === e.key);
      if (link) navigate('worklog', { kind: 'worklog-open', anchor: link.anchor });
    },
    toWorklog: async (e) => {
      const r = await appendToWorklog(api, { folder: folderFor(e.client), date: e.date, title: e.title, block: eventBlock(e), skipIfEventExists: true });
      if (r.ok) toast.success(r.created ? `${mdw(e.date)} 일지를 만들어 회의 블록을 넣었습니다.` : `${mdw(e.date)} 일지 끝에 회의 블록을 덧붙였습니다.`);
      else if (r.duplicate) toast.info(r.error);
      else toast.error(`일지에 쓰지 못했습니다: ${r.error}`);
    },
    edit: canWrite ? (e) => setEventDialog({ event: e }) : undefined,
    remove: canWrite ? (e) => setRemoving(e) : undefined,
  };

  const submitEvent = async (input: EventInput) => {
    const target = eventDialog?.event ?? null;
    setWriting(true);
    const r = target?.ref ? await api.calendarPatch({ ref: target.ref, patch: input }) : await api.calendarInsert(input);
    setWriting(false);
    if (!r.ok) return void toast.error(`달력에 쓰지 못했습니다: ${r.message}`);
    setEventDialog(null);
    await p.reloadCalendar(target ? [target.key] : []);
    toast.success(target ? '일정을 고쳤습니다.' : '일정을 달력에 만들었습니다.');
  };

  const confirmRemove = async () => {
    const e = removing;
    if (!e?.ref) return;
    setWriting(true);
    const r = await api.calendarDelete(e.ref);
    setWriting(false);
    setRemoving(null);
    if (!r.ok) return void toast.error(`지우지 못했습니다: ${r.message}`);
    if (state?.links.some((l) => eventKey(l) === e.key)) await apply({ type: 'link.remove', ref: e.ref });
    await p.reloadCalendar([e.key]);
    toast.success(`달력에서 지웠습니다 — ${e.title}`);
  };

  const jump = (target: 'late' | 'today' | 'week' | 'agenda' | 'waiting') => {
    const sel = target === 'agenda' ? '[data-testid="home-agenda"]' : `[data-bucket="${target}"]`;
    mainRef.current?.querySelector(sel)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  useRegisterDocTypeHandlers({
    menu: { 'menu:new': focusAdd },
    shortcut: (combo) => {
      if (combo === 'n') {
        focusAdd();
        return true;
      }
      return false;
    },
  });

  const openTasks = p.groups.buckets.late.length + p.groups.buckets.today.length + p.groups.buckets.week.length + p.groups.buckets.later.length + p.groups.buckets.none.length;
  const nothing = !!state && openTasks === 0 && p.groups.waiting.length === 0 && p.candidates.length === 0 && !showDone;
  const hiddenCount = (state?.hiddenCandidates.length ?? 0) + (state?.hiddenEvents.length ?? 0) + (state?.hiddenTitles.length ?? 0);
  const agendaCount = p.agenda.reduce((n, d) => n + d.events.filter((e) => e.kind === 'meeting' || e.kind === 'work').length, 0);

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <>
            <Btn label="할 일 추가" shortcut="Ctrl+N" icon={<Plus size={14} />} primary onClick={focusAdd} />
            <Btn label="새로 고침" shortcut="작업일지·주간보고·달력을 다시 읽음" icon={<RefreshCw size={14} />} disabled={p.busy} onClick={() => void p.refresh(true)} />
            <MoreMenu
              items={[
                { label: showDone ? '끝낸 일 접기' : '끝낸 일 보기', icon: <CheckSquare size={13} />, onClick: () => setShowDone((v) => !v) },
                { label: `무시한 후보·숨긴 일정 (${hiddenCount})`, icon: <EyeOff size={13} />, disabled: hiddenCount === 0, onClick: () => setHiddenOpen(true) },
                { label: '바뀐 기록', icon: <History size={13} />, hint: '앱·명령줄·Claude가 고친 것 — 되돌릴 수 있습니다', onClick: () => void openLog() },
                { label: 'Google 달력 열기', icon: <CalendarDays size={13} />, onClick: () => void api.openExternal(CALENDAR_URL) },
                { label: '저장 폴더 열기', icon: <FolderOpen size={13} />, hint: p.storePath, onClick: () => void api.plannerReveal() },
              ]}
            />
          </>,
          toolbarSlot,
        )}
      {eventDialog && <EventDialog event={eventDialog.event} date={focus ?? today} busy={writing} onSubmit={(input) => void submitEvent(input)} onClose={() => setEventDialog(null)} />}
      {removing && (
        <Modal
          title="이 일정을 달력에서 지웁니다"
          subtitle={`${removing.title} · ${mdw(removing.date)}${removing.startTime ? ` ${removing.startTime}` : ''}`}
          width={420}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <span className="flex-1" />
              <button type="button" className={BTN_GHOST} onClick={() => setRemoving(null)}>
                취소
              </button>
              <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={writing} onClick={() => void confirmRemove()}>
                {writing ? '지우는 중…' : '지우기'}
              </button>
            </>
          }
        >
          <p className="text-[12.5px] leading-relaxed text-fg-soft">Google 달력에서 이 일정이 없어집니다. 홈에서만 가리려면 [이 일정 숨기기]를 쓰세요.</p>
        </Modal>
      )}
      {log && (
        <Modal title="바뀐 기록" subtitle="앱·명령줄·Claude가 할 일 저장소를 고친 것 — 최근 것부터. 할 일마다 가장 최근 기록을 되돌릴 수 있습니다." width={620} onClose={() => setLog(null)}>
          {log.length === 0 && <p className="text-[12.5px] text-fg-muted">아직 기록이 없습니다.</p>}
          {log.map((e, i) => {
            const line = logLine(e);
            // 할 일 기록은 그 할 일의 가장 최근 것만 되돌린다 — 옛 기록을 되돌리면 그 뒤에 고친 것까지 함께 돌아간다
            const newest = !e.id || log.findIndex((x) => x.id === e.id) === i;
            return (
              <div className="hm-row" key={`${e.rev}:${e.at}`}>
                <span className="hm-when hm-num" style={{ width: 84, textAlign: 'left' }}>
                  {line.when}
                </span>
                <span className={e.by === 'claude' ? 'hm-tag' : 'hm-chip'}>{e.by === 'claude' ? 'Claude' : '앱'}</span>
                <span className="hm-chip">{line.what}</span>
                <span className="hm-ttl" style={{ cursor: 'default' }} title={line.title}>
                  {line.title}
                </span>
                <span className="hm-sp" />
                {newest && undoOps(e) && (
                  <button type="button" className="hm-mini" onClick={() => void undoEntry(e)}>
                    되돌리기
                  </button>
                )}
              </div>
            );
          })}
        </Modal>
      )}
      {hiddenOpen && state && (
        <Modal title="무시한 후보 · 숨긴 일정" subtitle="되살리면 다시 홈에 나옵니다. 달력과 작업일지는 바뀌지 않습니다." width={520} onClose={() => setHiddenOpen(false)}>
          {hiddenCount === 0 && <p className="text-[12.5px] text-fg-muted">숨긴 것이 없습니다.</p>}
          {state.hiddenTitles.map((title) => (
            <div className="hm-row" key={`t:${title}`}>
              <span className="hm-chip">제목</span>
              <span className="hm-ttl" style={{ cursor: 'default' }}>
                {title}
              </span>
              <span className="hm-sp" />
              <button type="button" className="hm-mini" onClick={() => void apply({ type: 'title.hide', title, hidden: false })}>
                되살리기
              </button>
            </div>
          ))}
          {state.hiddenEvents.map((key) => {
            const [calendarId, ...rest] = key.split('/');
            const raw = p.cal.raw.find((e) => `${e.calendarId}/${e.id}` === key);
            return (
              <div className="hm-row" key={`e:${key}`}>
                <span className="hm-chip">일정</span>
                <span className="hm-ttl" style={{ cursor: 'default' }}>
                  {raw?.summary || '(지금 읽는 범위 밖의 일정)'}
                </span>
                <span className="hm-sp" />
                <button type="button" className="hm-mini" onClick={() => void apply({ type: 'event.hide', ref: { calendarId, eventId: rest.join('/') }, hidden: false })}>
                  되살리기
                </button>
              </div>
            );
          })}
          {state.hiddenCandidates.map((key) => (
            <div className="hm-row" key={`c:${key}`}>
              <span className="hm-chip">후보</span>
              <span className="hm-ttl" style={{ cursor: 'default' }} title={key.replace(/\u0000/g, ' · ')}>
                {key.split('\u0000').slice(1).join(' · ')}
              </span>
              <span className="hm-sp" />
              <button type="button" className="hm-mini" onClick={() => void apply({ type: 'candidate.hide', key, hidden: false })}>
                되살리기
              </button>
            </div>
          ))}
        </Modal>
      )}
      <div className="flex h-full flex-col">
        <main className="hm min-h-0 flex-1" ref={mainRef}>
          <SummaryBar today={today} summary={p.summary} calendar={!!p.cal.status?.canRead} onJump={jump} />
          <WeekStrip weeks={p.strip} focus={focus} onFocus={setFocus} />
          <div className="hm-cols">
            <section aria-label="할 일">
              <div className="hm-h">
                <h2>할 일</h2>
                <small>남은 작업과 앞으로 할 작업</small>
                {focus && <span className="hm-r">{mdw(focus)}만 또렷이 — 날짜 칸을 다시 누르면 풀림</span>}
              </div>
              <input
                ref={addRef}
                className="hm-in"
                value={draft}
                aria-label="할 일 추가"
                placeholder="할 일을 적고 Enter — 끝에 11/27 처럼 쓰면 기한이 됩니다"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void addTask();
                  if (e.key === 'Escape') setDraft('');
                }}
              />
              {p.storeError && (
                <p className="hm-note" role="alert">
                  할 일 저장 파일을 읽지 못했습니다: {p.storeError}
                </p>
              )}
              {p.claudeChanged.length > 0 && (
                <div className="hm-chg" role="status" style={{ marginTop: 8 }}>
                  <b>Claude가 바꾼 할 일 {p.claudeChanged.length}건</b>
                  <span title={p.claudeChanged.map((t) => t.title).join('\n')}>{p.claudeChanged.map((t) => t.title).join(' · ')}</span>
                  <button type="button" className="hm-mini" onClick={() => void openLog()}>
                    기록 보기
                  </button>
                  <button type="button" className="hm-mini" onClick={p.ackClaude}>
                    확인
                  </button>
                </div>
              )}
              {nothing ? (
                <div style={{ marginTop: 10 }}>
                  <EmptyBox title="남은 할 일이 없습니다" action={{ label: '할 일 추가', onClick: focusAdd }}>
                    위 입력칸에 바로 적거나, 작업일지에 ‘회신 대기’·‘확인 필요’ 같은 상태를 적어 두면 여기에 후보로 올라옵니다.
                    {!p.wl.ready && ' 작업일지 폴더는 작업일지 탭에서 고릅니다.'}
                  </EmptyBox>
                </div>
              ) : (
                <TaskList
                  today={today}
                  groups={p.groups}
                  candidates={p.candidates}
                  olderCandidates={p.olderCandidates}
                  lookbackDays={state?.settings.lookbackDays ?? 30}
                  closed={p.closed}
                  focus={focus}
                  flash={flash}
                  changed={claudeIds}
                  showDone={showDone}
                  actions={taskActions}
                />
              )}
            </section>
            <section aria-label="확정 일정">
              <div className="hm-h">
                <h2>확정 일정</h2>
                <small>앞으로 2주</small>
                {p.cal.readAt && <span className="hm-r hm-num">Google 달력 · {clock(p.cal.readAt)} 확인</span>}
              </div>
              <ChangeBanner changes={p.changes} onAck={() => void p.ackChanges()} />
              <Agenda
                today={today}
                days={p.agenda}
                past={p.past}
                cal={p.cal}
                changes={p.changes}
                linked={linked}
                focus={focus}
                flash={flash}
                canLog={p.wl.ready}
                actions={eventActions}
                onRetry={() => void p.reloadCalendar()}
                onHelp={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }))}
              />
            </section>
          </div>
        </main>
        <footer className="hm-sb" data-testid="home-status">
          <span>
            <b>할 일 {openTasks}</b> · 기다림 {p.groups.waiting.length} · 후보 {p.candidates.length}
          </span>
          <span>일정 {agendaCount}건 (2주)</span>
          <span>
            <i className={p.cal.status?.canRead && !p.cal.error ? 'is-on' : undefined} />
            {!p.cal.status
              ? '달력 확인 중'
              : !p.cal.status.canRead
                ? 'Google 달력 미연결'
                : p.cal.error
                  ? '달력을 읽지 못함'
                  : `Google 달력 연결됨${canWrite ? ' (쓰기 가능)' : ''}${p.cal.readAt ? ` · ${clock(p.cal.readAt)} 확인` : ''}`}
          </span>
          <span className="hm-r">
            {api.preview ? '미리보기 — 합성 데이터, 저장되지 않음' : p.wl.ready ? `작업일지 ${p.wl.scan?.files ?? 0}개 읽음 (최근 ${state?.settings.lookbackDays ?? 30}일)` : '작업일지 폴더 없음'}
          </span>
        </footer>
      </div>
    </>
  );
}

export const homeModule: DocTypeModule = {
  id: 'home',
  label: '홈',
  switchIcon: <Home size={12} />,
  switchHint: '남은 작업과 정해진 일정 — 켜면 먼저 보이는 화면',
  Workspace: HomeWorkspace,
};
