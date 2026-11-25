/**
 * 홈 화면 상태 — 플래너 저장소 · 작업일지 후보 · 주간보고 표지 · Google 달력 · Notion을 읽어 한 모양으로 내준다.
 *
 * - 읽는 때: 화면을 열 때, 창이 다시 앞에 올 때, [새로 고침] — 저장소·작업일지·주간보고(이 PC의 파일)는 그때마다 읽는다.
 *   달력·Notion(인터넷 호출)은 읽은 지 5분이 지났을 때만 다시 부른다: main이 5분 기억하고(달력 목록·일정·Notion),
 *   홈이 보이는 동안에는 1분마다 "읽은 지 5분이 지났는가"를 본다. [새로 고침]은 기억을 건너뛴다.
 * - 마지막으로 읽은 것은 창이 떠 있는 동안 기억해 둔다(`Kept`) — 탭을 바꿨다 돌아와도 빈 화면에서 다시 시작하지 않는다.
 * - 원본(작업일지·주간보고·달력·Notion)은 여기서 바꾸지 않는다. 고치는 것은 플래너 저장소뿐이고 `apply(동작)` 하나로만 한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { plannerApi, plannerApiSource, type PlannerApi } from './api';
import { classifyEvents, detectClient, diffEvents, sortEvents, type EventChange, type HomeEvent } from './classify';
import { addDays, mondayOf, todayIso } from './dates';
import { agendaDays, buildStrip, closedInWorklog, groupTasks, recentPastEvents, summarize, visibleCandidates } from './model';
import { linkMeetingNotes, notionByDate, sourcesToRead } from './sources/notion';
import { scanWeekly, type WeeklyScan } from './sources/weekly';
import { scanWorklogs, type Candidate, type WorklogScan } from './sources/worklog';
import { DEFAULT_NOTION, DEFAULT_SETTINGS, undoOps } from './ops';
import { safeSetItem } from '../lib/storage';
import type { CalendarStatus, NotionPage, NotionStatus, PlannerLogEntry, PlannerOp, PlannerSettings, PlannerState, RawEvent, Task } from './types';

const DRAFT_KEY = 'tb:md-draft:v1';
const FOLDER_MAP_KEY = 'tb:worklog:weekly-map:v1';
/** 달력·Notion을 다시 읽는 주기 — main의 기억과 같은 길이다(읽은 시각 `readAt`이 두 쪽의 같은 시계) */
export const REMOTE_MS = 5 * 60 * 1000;
/** 홈이 보이는 동안 "읽은 지 REMOTE_MS가 지났는가"를 보는 간격 */
export const CHECK_MS = 60 * 1000;
/** 저장 파일이 바깥(명령줄·MCP 도구)에서 바뀌었는지 보는 주기 — 작업일지 탭과 같다 */
const STORE_POLL_MS = 3000;
/** Claude가 고친 할 일을 마지막으로 확인한 시각 (ISO) */
const SEEN_KEY = 'tb:home:seen-claude:v1';
/** 달력을 읽는 범위 — 지난주 월요일(지난 일정 → 일지)부터 4주 뒤까지 */
const PAST_DAYS = 7;
const AHEAD_DAYS = 28;
/** 설정 화면이 Notion 키를 넣거나 지웠을 때 창에 띄우는 이벤트 이름 */
export const NOTION_CHANGED = 'tb:notion-changed';
/** Notion을 보이는 범위 — 지난 주 월요일부터 오늘까지(띠의 지난 주 줄과 같다) */
export const notionFrom = (today: string): string => addDays(mondayOf(today), -7);
/** 후보의 "더 오래된 것"을 세려고 읽는 일지 범위 */
const WORKLOG_DAYS = 365;

export interface CalendarView {
  status: CalendarStatus | null;
  /** 이번에 읽은 달력 ID */
  calendars: string[];
  raw: RawEvent[];
  baseline: RawEvent[] | null;
  readAt: number | null;
  /** 읽지 못했을 때의 안내 — raw는 마지막으로 읽은 것 */
  error: string | null;
}

export interface NotionView {
  /** 키가 있는가 — 아직 확인 전이면 null */
  status: NotionStatus | null;
  pages: NotionPage[];
  /** 읽지 못한 DB의 ID */
  failed: string[];
  readAt: number | null;
  error: string | null;
}

export interface WorklogView {
  /** 작업일지 폴더를 골랐는가 */
  ready: boolean;
  folders: string[];
  scan: WorklogScan | null;
  error: string | null;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 폴더의 고객사·구분 — 주간보고 가져오기에서 정해 둔 값, 없으면 폴더 이름에서 아는 고객사 표기를 찾는다 */
export function folderClient(folder: string): string {
  const saved = readJson<Record<string, { client?: string }>>(FOLDER_MAP_KEY);
  return saved?.[folder]?.client?.trim() || detectClient(folder);
}

/**
 * 마지막으로 읽은 것 — 탭을 바꾸면 홈 화면이 새로 만들어지는데, 그때 빈 화면("달력 확인 중")에서 다시 시작하지 않게
 * 창이 떠 있는 동안 기억해 둔다. 파일로 남기지 않는다. 통로(main 또는 미리보기)마다 하나.
 */
interface Kept {
  state: PlannerState | null;
  storePath: string;
  cal: CalendarView;
  wl: WorklogView;
  weekly: WeeklyScan | null;
  notion: NotionView;
  /** 이 화면에서 내가 고치거나 지운 일정 */
  own: Set<string>;
  /** 달력·Notion을 마지막으로 읽은 시각(읽지 못했으면 읽으려 한 시각) — 주기 확인이 이것으로 "다시 읽을 때가 됐는가"를 본다 */
  calAt: number;
  notionAt: number;
}

const kept = new WeakMap<object, Kept>();

function keptOf(source: object): Kept {
  let k = kept.get(source);
  if (!k) {
    k = {
      state: null,
      storePath: '',
      cal: { status: null, calendars: [], raw: [], baseline: null, readAt: null, error: null },
      wl: { ready: false, folders: [], scan: null, error: null },
      weekly: null,
      notion: { status: null, pages: [], failed: [], readAt: null, error: null },
      own: new Set<string>(),
      calAt: 0,
      notionAt: 0,
    };
    kept.set(source, k);
  }
  return k;
}

export function usePlanner() {
  const api: PlannerApi = useMemo(plannerApi, []);
  /** 지난번에 읽어 둔 것 — 처음이면 비어 있다 */
  const keep = useMemo(() => keptOf(plannerApiSource()), []);
  const [today, setToday] = useState(todayIso);
  const [state, setState] = useState<PlannerState | null>(keep.state);
  const [storePath, setStorePath] = useState(keep.storePath);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [cal, setCal] = useState<CalendarView>(keep.cal);
  /** 이 화면에서 내가 고치거나 지운 일정 — '바뀜'으로 띄우지 않는다 */
  const own = useRef(keep.own);
  const [wl, setWl] = useState<WorklogView>(keep.wl);
  const [weekly, setWeekly] = useState<WeeklyScan | null>(keep.weekly);
  const [notion, setNotion] = useState<NotionView>(keep.notion);
  // 읽은 것을 기억해 둔다 — 다음에 홈을 열면 여기서 시작한다
  useEffect(() => {
    Object.assign(keep, { state, storePath, cal, wl, weekly, notion });
  }, [keep, state, storePath, cal, wl, weekly, notion]);
  const [busy, setBusy] = useState(true);
  const [seenAt, setSeenAt] = useState(() => (typeof localStorage === 'undefined' ? '' : (localStorage.getItem(SEEN_KEY) ?? '')));
  /** 마지막으로 읽기 직전에 본 저장 파일의 시각 — 이것과 달라지면 다시 읽는다 */
  const known = useRef(0);
  const stateRef = useRef<PlannerState | null>(null);
  stateRef.current = state;
  const alive = useRef(true);
  // 개발 모드는 effect를 한 번 정리했다가 다시 건다 — 다시 걸릴 때 true로 되돌리지 않으면 그 뒤의 읽기가 전부 버려진다
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadPlanner = useCallback(async (): Promise<PlannerState | null> => {
    // 시각을 먼저 본다 — 읽는 사이 밖에서 또 고쳤다면 다음 확인 때 시각이 달라 다시 읽는다(읽고 나서 시각을 보면 그 변경을 놓친다)
    const s = await api.plannerStat();
    const r = await api.plannerGet();
    if (!alive.current) return null;
    if (!r.ok) {
      setStoreError(r.error);
      return null;
    }
    if (s.ok) known.current = s.mtimeMs;
    setState(r.state);
    setStorePath(r.path);
    setStoreError(null);
    if (r.warning) toast.warning(r.warning, { duration: 12000 });
    return r.state;
  }, [api]);

  const loadCalendar = useCallback(
    async (settings: PlannerSettings, force = false): Promise<{ raw: RawEvent[]; baseline: RawEvent[] | null } | null> => {
      const status = await api.calendarStatus();
      if (!alive.current) return null;
      if (!status.canRead) {
        keep.calAt = Date.now();
        setCal({ status, calendars: [], raw: [], baseline: null, readAt: null, error: null });
        return null;
      }
      // 읽을 달력 = 설정에서 고른 것 + (켜 두었으면) 구독 중인 공휴일 달력
      let calendars = settings.calendars;
      if (settings.holidays && status.canList) {
        const list = await api.calendarList({ force });
        if (!alive.current) return null;
        if (list.ok) calendars = [...new Set([...calendars, ...list.calendars.filter((c) => c.holiday).map((c) => c.id)])];
      }
      const day = todayIso();
      const r = await api.calendarEvents({ from: addDays(mondayOf(day), -PAST_DAYS), to: addDays(day, AHEAD_DAYS), calendars, force });
      if (!alive.current) return null;
      // main이 기억해 둔 것을 돌려줬으면 readAt은 그때의 시각이다 — 그 시각에서 5분이 지나면 다시 읽을 때다
      keep.calAt = r.ok ? r.readAt : Date.now();
      if (r.ok) {
        setCal({ status, calendars, raw: r.events, baseline: r.baseline, readAt: r.readAt, error: null });
        return { raw: r.events, baseline: r.baseline };
      }
      setCal((prev) => ({ status, calendars, raw: r.cached?.events ?? prev.raw, baseline: null, readAt: r.cached?.readAt ?? prev.readAt, error: r.message }));
      return null;
    },
    [api, keep],
  );

  const loadWorklog = useCallback(
    async (lookbackDays: number) => {
      const config = await api.worklogConfig();
      if (!alive.current) return;
      if (!config.root || config.error) {
        setWl({ ready: false, folders: [], scan: null, error: config.error ?? null });
        return;
      }
      const day = todayIso();
      const r = await api.worklogReadAll({ from: addDays(day, -WORKLOG_DAYS) });
      if (!alive.current) return;
      const folders = config.folders.map((f) => f.name);
      if (!r.ok) {
        setWl({ ready: true, folders, scan: null, error: r.error });
        return;
      }
      setWl({ ready: true, folders, scan: scanWorklogs(r.files, { today: day, lookbackDays, clientOf: folderClient }), error: null });
    },
    [api],
  );

  const loadWeekly = useCallback(async () => {
    const draft = typeof localStorage === 'undefined' ? '' : (localStorage.getItem(DRAFT_KEY) ?? '');
    const history = await api.worklogWeeklyHistory([]).catch(() => []);
    if (!alive.current) return;
    setWeekly(scanWeekly([{ name: '', text: draft }, ...history], todayIso()));
  }, [api]);

  /** Notion — 키가 있고 볼 DB를 골랐을 때만 읽는다. 읽지 못해도 홈의 나머지는 그대로다 */
  const loadNotion = useCallback(
    async (settings: PlannerSettings, force = false) => {
      // 통로가 없는 실행(옛 preload)에서도, Notion 쪽에서 무슨 일이 나도 홈의 나머지 읽기를 막지 않는다
      if (typeof api.notionStatus !== 'function' || typeof api.notionRecent !== 'function') return;
      try {
        const status = await api.notionStatus();
        if (!alive.current) return;
        const want = settings.notion ?? DEFAULT_NOTION;
        const sources = sourcesToRead(want);
        if (!status?.connected || sources.length === 0) {
          keep.notionAt = Date.now();
          setNotion({ status, pages: [], failed: [], readAt: null, error: null });
          return;
        }
        const since = new Date(`${notionFrom(todayIso())}T00:00:00`).toISOString();
        const r = await api.notionRecent({ sources, since, loose: want.loose, force });
        if (!alive.current) return;
        keep.notionAt = r.ok ? r.readAt : Date.now();
        if (r.ok) setNotion({ status, pages: r.pages, failed: r.failed, readAt: r.readAt, error: null });
        else setNotion((prev) => ({ status, pages: prev.pages, failed: [], readAt: prev.readAt, error: r.message }));
      } catch (err) {
        keep.notionAt = Date.now();
        if (alive.current) setNotion((prev) => ({ ...prev, error: err instanceof Error ? err.message : '알 수 없는 오류' }));
      }
    },
    [api, keep],
  );

  /**
   * 다시 읽는다 — 저장소·작업일지·주간보고는 늘 파일에서, 달력·Notion은 main이 기억해 둔 것(5분)이 있으면 그것을 받는다.
   * force([새로 고침])면 그 기억도 건너뛰고 지금 것을 부른다.
   */
  const refresh = useCallback(
    async (force = false) => {
      setBusy(true);
      setToday(todayIso());
      const s = (await loadPlanner()) ?? stateRef.current;
      const settings = s?.settings ?? DEFAULT_SETTINGS;
      await Promise.all([loadCalendar(settings, force), loadWorklog(settings.lookbackDays), loadWeekly(), loadNotion(settings, force)]);
      if (alive.current) setBusy(false);
    },
    [loadPlanner, loadCalendar, loadWorklog, loadWeekly, loadNotion],
  );

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    // 홈이 보이는 동안: 읽은 지 5분이 지난 것만 다시 읽는다. 전에는 화면을 연 때부터 5분마다 불렀는데,
    // main의 기억도 5분이라 한 번 걸러 기억해 둔 것이 돌아왔다(실제로는 10분에 한 번) — 이제 읽은 시각으로 잰다.
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setToday(todayIso());
      const settings = stateRef.current?.settings ?? DEFAULT_SETTINGS;
      const now = Date.now();
      if (now - keep.calAt >= REMOTE_MS) void loadCalendar(settings);
      if (now - keep.notionAt >= REMOTE_MS) void loadNotion(settings);
    }, CHECK_MS);
    // 명령줄·MCP 도구가 저장 파일을 고치면 3초 안에 받아 온다 (창이 보일 때만)
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api.plannerStat().then((s) => {
        if (!alive.current || !s.ok || s.mtimeMs === known.current) return;
        known.current = s.mtimeMs;
        void loadPlanner();
      });
    }, STORE_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
    // 처음 한 번 — refresh·loadCalendar는 api에만 묶여 바뀌지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 설정(읽을 달력·공휴일·후보 기간)이 바뀌면 — 설정(F1)에서 고쳤든 밖에서 고쳤든 — 달력과 일지를 그 설정으로 다시 읽는다.
  // 전에는 [새로 고침]을 누르거나 창이 다시 앞에 올 때까지 예전 설정으로 읽은 내용이 남아 있었다.
  const settingsKey = state ? `${[...state.settings.calendars].sort().join(',')}|${state.settings.holidays}|${state.settings.lookbackDays}` : '';
  const lastSettings = useRef('');
  useEffect(() => {
    const s = stateRef.current?.settings;
    if (!settingsKey || !s) return;
    if (lastSettings.current && lastSettings.current !== settingsKey) {
      void loadCalendar(s);
      void loadWorklog(s.lookbackDays);
    }
    lastSettings.current = settingsKey;
  }, [settingsKey, loadCalendar, loadWorklog]);

  // Notion 설정(볼 DB·회의록 DB)이 바뀌면 그 설정으로 다시 읽는다
  const notionKey = state ? JSON.stringify([sourcesToRead(state.settings.notion ?? DEFAULT_NOTION).sort(), (state.settings.notion ?? DEFAULT_NOTION).loose]) : '';
  const lastNotion = useRef('');
  useEffect(() => {
    const s = stateRef.current?.settings;
    if (!notionKey || !s) return;
    if (lastNotion.current && lastNotion.current !== notionKey) void loadNotion(s);
    lastNotion.current = notionKey;
  }, [notionKey, loadNotion]);

  /** Notion을 다시 읽는다 — [다시 읽기], 설정에서 키를 넣은 뒤 */
  const reloadNotion = useCallback(() => loadNotion(stateRef.current?.settings ?? DEFAULT_SETTINGS, true), [loadNotion]);
  // 설정(F1)에서 키를 넣거나 지우면 알려 온다 — 키는 저장소 밖에 있어 설정 변화로는 알 수 없다
  useEffect(() => {
    const on = () => void reloadNotion();
    window.addEventListener(NOTION_CHANGED, on);
    return () => window.removeEventListener(NOTION_CHANGED, on);
  }, [reloadNotion]);

  /** 저장소를 고친다 — 실패하면 알리고 null */
  const apply = useCallback(
    async (op: PlannerOp): Promise<PlannerState | null> => {
      const r = await api.plannerApply(op);
      if (!r.ok) {
        toast.error(`저장하지 못했습니다: ${r.error}`);
        return null;
      }
      // 내가 쓴 뒤의 파일 시각은 따로 적지 않는다 — 다음 확인 때 한 번 더 읽을 뿐이고, 그 사이 밖에서 고친 것을 놓치지 않는다
      if (alive.current) setState(r.state);
      return r.state;
    },
    [api],
  );

  /** 바뀐 기록 — 최근 것부터 */
  const readLog = useCallback(async (): Promise<PlannerLogEntry[]> => {
    const r = await api.plannerLog(60);
    return r.ok ? r.entries : [];
  }, [api]);

  /** 기록 한 줄을 되돌린다 — 되돌릴 수 없는 기록이면 false */
  const undo = useCallback(
    async (entry: PlannerLogEntry): Promise<boolean> => {
      const ops = undoOps(entry);
      if (!ops) return false;
      for (const op of ops) if (!(await apply(op))) return false;
      return true;
    },
    [apply],
  );

  /** Claude가 고친 할 일을 확인했다 */
  const ackClaude = useCallback(() => {
    const now = new Date().toISOString();
    safeSetItem(SEEN_KEY, now);
    setSeenAt(now);
  }, []);

  /**
   * 달력을 다시 읽는다. `changed`는 이 화면에서 방금 고치거나 지운 일정 — '바뀜'으로 띄우지 않는다.
   * 다른 곳에서 바뀐 것이 없으면 지금 일정을 견줄 기준으로 삼아, 내가 고친 것이 다음 실행 때 '바뀜'으로 나오지 않게 한다.
   */
  const reloadCalendar = useCallback(
    async (changed: string[] = []) => {
      for (const key of changed) own.current.add(key);
      const got = await loadCalendar(stateRef.current?.settings ?? DEFAULT_SETTINGS, true);
      if (!got || changed.length === 0) return;
      const others = diffEvents(got.baseline, got.raw, todayIso()).filter((c) => !own.current.has(c.key));
      if (others.length > 0) return;
      await api.calendarAck();
      // 기준이 지금 일정으로 바뀌었으니 "내가 고친 일정" 표시는 더 필요 없다 — 남겨 두면 그 일정이 나중에 밖에서 바뀌어도 알리지 않는다
      own.current.clear();
      if (alive.current) setCal((c) => ({ ...c, baseline: c.raw }));
    },
    [api, loadCalendar],
  );

  /** 바뀐 일정을 확인했다 — 다음부터는 지금 일정이 기준이 된다 */
  const ackChanges = useCallback(async () => {
    await api.calendarAck();
    own.current.clear();
    if (alive.current) setCal((c) => ({ ...c, baseline: c.raw }));
  }, [api]);

  const view = useMemo(() => {
    const tasks = state?.tasks ?? [];
    const groups = groupTasks(tasks, today);
    const open = tasks.filter((t) => !t.doneAt && t.state === 'todo');
    const gcal = classifyEvents(cal.raw, { hiddenEvents: state?.hiddenEvents, hiddenTitles: state?.hiddenTitles });
    // 주간보고 `@PLAN`은 달력에 같은 날·같은 제목이 없을 때만 보탠다(달력에서 가져온 줄이면 겹친다)
    const plans = (weekly?.plans ?? []).filter((p) => !gcal.some((e) => e.date === p.date && e.title === p.title));
    const events: HomeEvent[] = sortEvents([...gcal, ...plans]);
    const all: Candidate[] = [...(wl.scan?.candidates ?? []), ...(weekly?.candidates ?? [])];
    const candidates = state ? visibleCandidates(all, state) : [];
    // 읽지 않게 된 달력의 일정이 '취소됨'으로 나오지 않게, 이번에 읽은 달력의 것만 견준다
    const read = new Set(cal.calendars);
    // 남의 달력의 일정이 바뀐 것은 알리지 않는다 — 내 일정이 아니다
    const baseline = cal.baseline ? cal.baseline.filter((e) => read.has(e.calendarId) && !e.other) : null;
    const changes: EventChange[] = diffEvents(baseline, cal.raw.filter((e) => !e.other), today).filter((c) => !own.current.has(c.key));
    // 명령줄·MCP 도구로 Claude가 고친 할 일 — 마지막으로 확인한 뒤의 것
    const claudeChanged: Task[] = tasks.filter((t) => t.by === 'claude' && t.updatedAt > seenAt);
    // Notion — 회의록 DB의 페이지는 본인 일정에 잇고, 고른 DB의 최근 페이지는 DB별로 묶는다
    const ns = state?.settings.notion ?? DEFAULT_NOTION;
    const notes = linkMeetingNotes(ns.meetings ? notion.pages.filter((x) => x.sourceId === ns.meetings) : [], events);
    // Notion을 읽고 있으면 띠에 지난 주 줄을 붙인다 — 쓴 것은 지난 날에 있다
    const notionOn = !!notion.status?.connected && sourcesToRead(ns).length > 0;
    return {
      groups,
      events,
      candidates,
      olderCandidates: wl.scan?.older ?? 0,
      closed: closedInWorklog(tasks, wl.scan),
      strip: buildStrip(today, events, open, notionOn ? 1 : 0),
      summary: summarize(today, groups, events),
      agenda: agendaDays(today, events),
      past: recentPastEvents(today, events),
      changes,
      claudeChanged,
      notes,
      notionDays: notionOn ? notionByDate(notion.pages, ns, notionFrom(today), today) : [],
    };
  }, [state, today, cal.raw, cal.baseline, cal.calendars, wl.scan, weekly, seenAt, notion.pages, notion.status]);

  return { api, today, state, storePath, storeError, cal, wl, weekly, notion, busy, refresh, apply, reloadCalendar, reloadNotion, ackChanges, readLog, undo, ackClaude, ...view };
}

export type PlannerView = ReturnType<typeof usePlanner>;
