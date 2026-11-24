/**
 * 플래너 저장소를 고치는 동작 — 순수 함수(상태 → 상태). 입력 검사도 여기서 한다.
 * 앱 화면(main의 electron/planner.ts를 거쳐)과 나중의 명령줄·MCP 도구가 같은 동작을 쓴다 (설계 §8·§9).
 * main도 읽으므로 상대 경로로만 import한다.
 */
import { isRealIsoDate } from '../core/types';
import type {
  EventLink,
  EventRef,
  NotionSettings,
  NotionSource,
  PlannerLogEntry,
  PlannerOp,
  PlannerSettings,
  PlannerState,
  Task,
  TaskDraft,
  TaskOrigin,
  TaskPatch,
  WorklogAnchor,
} from './types';

export const DEFAULT_NOTION: NotionSettings = { sources: [], meetings: '', loose: true, days: 7 };
export const DEFAULT_SETTINGS: PlannerSettings = { lookbackDays: 30, calendars: ['primary'], holidays: true, notion: DEFAULT_NOTION };
const MAX = { title: 200, short: 60, note: 2000, list: 500, calendars: 20, id: 300, sources: 40, url: 400 };

export class PlannerError extends Error {}

export interface OpContext {
  /** ISO 시각 */
  now: string;
  /** 오늘 YYYY-MM-DD (이 컴퓨터의 날짜) */
  today: string;
  by: 'app' | 'claude';
  newId(): string;
}

export function emptyState(): PlannerState {
  return { version: 1, rev: 0, tasks: [], links: [], hiddenCandidates: [], hiddenEvents: [], hiddenTitles: [], settings: { ...DEFAULT_SETTINGS } };
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function eventKey(ref: EventRef): string {
  return `${ref.calendarId}/${ref.eventId}`;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const strList = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, each)).filter(Boolean))].slice(0, max) : [];
const dateOrNull = (v: unknown): string | null => (typeof v === 'string' && isRealIsoDate(v) ? v : null);

function cleanAnchor(v: unknown): WorklogAnchor | null {
  const a = v as Partial<WorklogAnchor> | null;
  if (!a || typeof a !== 'object') return null;
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  const date = dateOrNull(a.date);
  const caseKey = typeof a.caseKey === 'string' ? a.caseKey.slice(0, MAX.id) : '';
  if (!name || !date || !caseKey || /[\\/]/.test(name)) return null;
  return {
    folder: typeof a.folder === 'string' ? a.folder : '',
    name,
    date,
    caseKey,
    nth: Number.isInteger(a.nth) && (a.nth as number) >= 0 ? (a.nth as number) : 0,
    line: Number.isInteger(a.line) && (a.line as number) > 0 ? (a.line as number) : 1,
    title: str(a.title, MAX.title),
    source: str(a.source, MAX.short * 2),
  };
}

function cleanRef(v: unknown): EventRef | null {
  const r = v as Partial<EventRef> | null;
  if (!r || typeof r !== 'object') return null;
  const calendarId = typeof r.calendarId === 'string' ? r.calendarId.trim().slice(0, MAX.id) : '';
  const eventId = typeof r.eventId === 'string' ? r.eventId.trim().slice(0, MAX.id) : '';
  return calendarId && eventId ? { calendarId, eventId } : null;
}

function cleanOrigin(v: unknown): TaskOrigin {
  const o = v as { kind?: string; anchor?: unknown; file?: unknown; line?: unknown } | null;
  if (o?.kind === 'worklog') {
    const anchor = cleanAnchor(o.anchor);
    if (anchor) return { kind: 'worklog', anchor };
  }
  if (o?.kind === 'weekly' && typeof o.file === 'string' && o.file) {
    return { kind: 'weekly', file: o.file.slice(0, 600), line: Number.isInteger(o.line) && (o.line as number) > 0 ? (o.line as number) : 1 };
  }
  return { kind: 'manual' };
}

function cleanTask(v: unknown): Task | null {
  const t = v as Partial<Task> | null;
  if (!t || typeof t !== 'object') return null;
  const id = typeof t.id === 'string' ? t.id.trim().slice(0, MAX.short) : '';
  const title = str(t.title, MAX.title);
  if (!id || !title) return null;
  const state = t.state === 'waiting' ? 'waiting' : 'todo';
  const createdAt = typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date(0).toISOString();
  return {
    id,
    title,
    client: str(t.client, MAX.short),
    who: str(t.who, MAX.short),
    due: dateOrNull(t.due),
    state,
    waitingOn: state === 'waiting' ? str(t.waitingOn, MAX.short) : '',
    waitingSince: state === 'waiting' ? dateOrNull(t.waitingSince) : null,
    note: text(t.note, MAX.note),
    origin: cleanOrigin(t.origin),
    event: cleanRef(t.event),
    createdAt,
    updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : createdAt,
    doneAt: typeof t.doneAt === 'string' && t.doneAt ? t.doneAt : null,
    by: t.by === 'claude' ? 'claude' : 'app',
  };
}

/** Notion 주소는 https의 Notion 호스트만 남긴다 — 저장 파일을 손으로 고쳐도 다른 곳으로 가는 링크가 되지 않게 */
const notionUrl = (v: unknown): string => {
  const s = str(v, MAX.url);
  return /^https:\/\/(www\.notion\.so|notion\.so|app\.notion\.com)\//.test(s) ? s : '';
};

function cleanNotion(v: unknown, base: NotionSettings = DEFAULT_NOTION): NotionSettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const n = v as Partial<NotionSettings>;
  const seen = new Set<string>();
  const sources: NotionSource[] = [];
  for (const x of Array.isArray(n.sources) ? n.sources : base.sources) {
    const id = str((x as NotionSource | null)?.id, MAX.id);
    if (!id || seen.has(id) || sources.length >= MAX.sources) continue;
    seen.add(id);
    sources.push({ id, name: str((x as NotionSource).name, MAX.title) || '이름 없는 DB', url: notionUrl((x as NotionSource).url) });
  }
  const days = Number.isFinite(n.days) ? Math.round(n.days as number) : base.days;
  return {
    sources,
    meetings: n.meetings === undefined ? base.meetings : str(n.meetings, MAX.id),
    loose: typeof n.loose === 'boolean' ? n.loose : base.loose,
    days: Math.min(30, Math.max(1, days)),
  };
}

function cleanSettings(v: unknown, base: PlannerSettings = DEFAULT_SETTINGS): PlannerSettings {
  const s = (v ?? {}) as Partial<PlannerSettings>;
  const days = Number.isFinite(s.lookbackDays) ? Math.round(s.lookbackDays as number) : base.lookbackDays;
  const calendars = s.calendars === undefined ? base.calendars : strList(s.calendars, MAX.calendars, MAX.id);
  return {
    lookbackDays: Math.min(180, Math.max(7, days)),
    calendars: calendars.length ? calendars : ['primary'],
    holidays: typeof s.holidays === 'boolean' ? s.holidays : base.holidays,
    notion: cleanNotion(s.notion, base.notion ?? DEFAULT_NOTION),
  };
}

/** 파일에서 읽은 값을 저장 모양으로 — 모르는 칸은 버리고 빠진 칸은 기본값으로. 모양이 아예 다르면 PlannerError */
export function normalizeState(raw: unknown): PlannerState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlannerError('플래너 저장 파일의 모양이 다릅니다.');
  const r = raw as Partial<PlannerState>;
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const x of Array.isArray(r.tasks) ? r.tasks : []) {
    const t = cleanTask(x);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tasks.push(t);
    }
  }
  const links: EventLink[] = [];
  for (const x of Array.isArray(r.links) ? r.links : []) {
    const ref = cleanRef(x);
    const anchor = cleanAnchor((x as { anchor?: unknown } | null)?.anchor);
    if (ref && anchor && !links.some((l) => eventKey(l) === eventKey(ref))) links.push({ ...ref, anchor });
  }
  return {
    version: 1,
    rev: Number.isInteger(r.rev) && (r.rev as number) >= 0 ? (r.rev as number) : 0,
    tasks,
    links,
    hiddenCandidates: strList(r.hiddenCandidates, MAX.list, 600),
    hiddenEvents: strList(r.hiddenEvents, MAX.list, 600),
    hiddenTitles: strList(r.hiddenTitles, MAX.list, MAX.title),
    settings: cleanSettings(r.settings),
  };
}

function toggle(list: string[], value: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== value);
  return on ? [...rest, value].slice(-MAX.list) : rest;
}

function draftToTask(draft: TaskDraft, id: string, ctx: OpContext): Task {
  const title = str(draft.title, MAX.title);
  if (!title) throw new PlannerError('할 일 제목을 입력하세요.');
  if (draft.due != null && !dateOrNull(draft.due)) throw new PlannerError('기한이 날짜(YYYY-MM-DD)가 아닙니다.');
  const state = draft.state === 'waiting' ? 'waiting' : 'todo';
  return {
    id,
    title,
    client: str(draft.client, MAX.short),
    who: str(draft.who, MAX.short),
    due: dateOrNull(draft.due),
    state,
    waitingOn: state === 'waiting' ? str(draft.waitingOn, MAX.short) : '',
    waitingSince: state === 'waiting' ? ctx.today : null,
    note: text(draft.note, MAX.note),
    origin: cleanOrigin(draft.origin),
    event: cleanRef(draft.event),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    doneAt: null,
    by: ctx.by,
  };
}

function patchTask(t: Task, patch: TaskPatch, ctx: OpContext): Task {
  const next: Task = { ...t };
  if (patch.title !== undefined) {
    const title = str(patch.title, MAX.title);
    if (!title) throw new PlannerError('할 일 제목을 입력하세요.');
    next.title = title;
  }
  if (patch.client !== undefined) next.client = str(patch.client, MAX.short);
  if (patch.who !== undefined) next.who = str(patch.who, MAX.short);
  if (patch.note !== undefined) next.note = text(patch.note, MAX.note);
  if (patch.due !== undefined) {
    if (patch.due !== null && !dateOrNull(patch.due)) throw new PlannerError('기한이 날짜(YYYY-MM-DD)가 아닙니다.');
    next.due = dateOrNull(patch.due);
  }
  if (patch.event !== undefined) next.event = cleanRef(patch.event);
  if (patch.state !== undefined) {
    if (patch.state !== 'todo' && patch.state !== 'waiting') throw new PlannerError('상태는 내 차례(todo)·기다리는 중(waiting)뿐입니다.');
    next.state = patch.state;
    if (patch.state === 'waiting' && !t.waitingSince) next.waitingSince = ctx.today;
    if (patch.state === 'todo') {
      next.waitingSince = null;
      next.waitingOn = '';
    }
  }
  if (patch.waitingOn !== undefined && next.state === 'waiting') next.waitingOn = str(patch.waitingOn, MAX.short);
  next.updatedAt = ctx.now;
  next.by = ctx.by;
  return next;
}

/** 동작 하나를 적용한다 — 새 상태와 기록 한 줄. 입력이 틀리면 PlannerError (상태는 그대로) */
export function applyOp(state: PlannerState, op: PlannerOp, ctx: OpContext): { state: PlannerState; log: PlannerLogEntry } {
  const rev = state.rev + 1;
  const log = (extra: Partial<PlannerLogEntry> = {}): PlannerLogEntry => ({ at: ctx.now, by: ctx.by, rev, op: op.type, ...extra });
  const find = (id: string): Task => {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) throw new PlannerError('그 할 일을 찾지 못했습니다 — 이미 지워졌을 수 있습니다.');
    return t;
  };
  const replace = (next: Task): Task[] => state.tasks.map((x) => (x.id === next.id ? next : x));

  switch (op.type) {
    case 'task.add': {
      const id = str(op.id, MAX.short) || ctx.newId();
      if (state.tasks.some((x) => x.id === id)) throw new PlannerError('같은 ID의 할 일이 이미 있습니다.');
      const task = draftToTask(op.draft, id, ctx);
      return { state: { ...state, rev, tasks: [...state.tasks, task] }, log: log({ id, after: task }) };
    }
    case 'task.update': {
      const before = find(op.id);
      const after = patchTask(before, op.patch ?? {}, ctx);
      return { state: { ...state, rev, tasks: replace(after) }, log: log({ id: op.id, before, after }) };
    }
    case 'task.done': {
      const before = find(op.id);
      const after: Task = { ...before, doneAt: op.done ? ctx.now : null, updatedAt: ctx.now, by: ctx.by };
      return { state: { ...state, rev, tasks: replace(after) }, log: log({ id: op.id, before, after }) };
    }
    case 'task.remove': {
      const before = find(op.id);
      return { state: { ...state, rev, tasks: state.tasks.filter((x) => x.id !== op.id) }, log: log({ id: op.id, before }) };
    }
    case 'task.restore': {
      const task = cleanTask(op.task);
      if (!task) throw new PlannerError('되살릴 할 일의 모양이 다릅니다.');
      if (state.tasks.some((x) => x.id === task.id)) throw new PlannerError('같은 ID의 할 일이 이미 있습니다.');
      return { state: { ...state, rev, tasks: [...state.tasks, task] }, log: log({ id: task.id, after: task }) };
    }
    case 'candidate.hide': {
      const key = typeof op.key === 'string' ? op.key.slice(0, 600) : '';
      if (!key) throw new PlannerError('후보 키가 없습니다.');
      return { state: { ...state, rev, hiddenCandidates: toggle(state.hiddenCandidates, key, !!op.hidden) }, log: log({ after: { key, hidden: !!op.hidden } }) };
    }
    case 'event.hide': {
      const ref = cleanRef(op.ref);
      if (!ref) throw new PlannerError('일정을 가리키는 값이 없습니다.');
      return { state: { ...state, rev, hiddenEvents: toggle(state.hiddenEvents, eventKey(ref), !!op.hidden) }, log: log({ after: { ...ref, hidden: !!op.hidden } }) };
    }
    case 'title.hide': {
      const title = str(op.title, MAX.title);
      if (!title) throw new PlannerError('숨길 제목이 없습니다.');
      return { state: { ...state, rev, hiddenTitles: toggle(state.hiddenTitles, title, !!op.hidden) }, log: log({ after: { title, hidden: !!op.hidden } }) };
    }
    case 'link.set': {
      const ref = cleanRef(op.link);
      const anchor = cleanAnchor(op.link?.anchor);
      if (!ref || !anchor) throw new PlannerError('일정과 일지 사안을 잇는 값이 모자랍니다.');
      const link: EventLink = { ...ref, anchor };
      return { state: { ...state, rev, links: [...state.links.filter((l) => eventKey(l) !== eventKey(ref)), link] }, log: log({ after: link }) };
    }
    case 'link.remove': {
      const ref = cleanRef(op.ref);
      if (!ref) throw new PlannerError('일정을 가리키는 값이 없습니다.');
      const before = state.links.find((l) => eventKey(l) === eventKey(ref));
      return { state: { ...state, rev, links: state.links.filter((l) => eventKey(l) !== eventKey(ref)) }, log: log({ before }) };
    }
    case 'settings': {
      const settings = cleanSettings({ ...state.settings, ...(op.patch ?? {}) }, state.settings);
      return { state: { ...state, rev, settings }, log: log({ before: state.settings, after: settings }) };
    }
    default:
      throw new PlannerError('모르는 동작입니다.');
  }
}

/**
 * 기록 한 줄을 되돌리는 동작들 — 앱의 [되돌리기]와 도구의 undo가 같이 쓴다. 되돌릴 수 없는 기록이면 null.
 * 고친 할 일은 "지우고 → 고치기 전 모양으로 되살리기"로 되돌린다(그 사이 다른 칸을 고쳤으면 그것도 함께 돌아간다).
 */
export function undoOps(entry: PlannerLogEntry): PlannerOp[] | null {
  const before = entry.before as Task | EventLink | PlannerSettings | undefined;
  const after = entry.after as (Partial<Task> & Partial<EventRef> & { key?: string; title?: string; hidden?: boolean }) | undefined;
  switch (entry.op) {
    case 'task.add':
    case 'task.restore':
      return entry.id ? [{ type: 'task.remove', id: entry.id }] : null;
    case 'task.update':
    case 'task.done':
      return entry.id && before ? [{ type: 'task.remove', id: entry.id }, { type: 'task.restore', task: before as Task }] : null;
    case 'task.remove':
      return before ? [{ type: 'task.restore', task: before as Task }] : null;
    case 'link.set':
      return after?.calendarId && after.eventId ? [{ type: 'link.remove', ref: { calendarId: after.calendarId, eventId: after.eventId } }] : null;
    case 'link.remove':
      return before ? [{ type: 'link.set', link: before as EventLink }] : null;
    case 'candidate.hide':
      return after?.key ? [{ type: 'candidate.hide', key: after.key, hidden: !after.hidden }] : null;
    case 'event.hide':
      return after?.calendarId && after.eventId ? [{ type: 'event.hide', ref: { calendarId: after.calendarId, eventId: after.eventId }, hidden: !after.hidden }] : null;
    case 'title.hide':
      return after?.title ? [{ type: 'title.hide', title: after.title, hidden: !after.hidden }] : null;
    case 'settings':
      return before ? [{ type: 'settings', patch: before as PlannerSettings }] : null;
    default:
      return null;
  }
}
