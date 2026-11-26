/**
 * 플래너 도구 — 앱 밖(명령줄·MCP 서버)에서 홈의 할 일 저장소와 작업일지 사안을 다룬다. 설계: docs/home-schedule-design.md §10
 *
 * - 저장소를 고치는 길은 앱과 같다: `applyToStore`(동작 하나) — 잠금·백업·기록이 그대로 남고, 고친 쪽이 `claude`로 적힌다.
 *   앱은 3초마다 저장 파일의 시각을 보고 다시 읽어 "바뀜"으로 알린다.
 * - 작업일지는 읽기와 "오늘 일지 끝에 후속 블록 덧붙이기" 하나만 한다. 지난 일지와 기존 줄은 고치지 않는다.
 * - 달력 일정 자체는 다루지 않는다(옮기고 새로 잡는 일은 달력 쪽 도구가 한다). 일정 ID를 할 일·사안에 잇는 것만 한다.
 * - Electron에 기대지 않는다. `scripts/planner-tool.mjs`가 한 파일로 묶어 돌린다.
 */
import path from 'node:path';
import { isDir } from './util';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { version as APP_VERSION } from '../package.json';
import { writeFileAtomic } from './atomic';
import { applyToStore, plannerDir, readAppInfo, readLog, readStore } from './planner-store';
import { decodeWorklog, encodeWorklog } from './worklog-codec';
import { WORKLOG_NAME_RE, type WorklogFileText } from './worklog-types';
import { isRealIsoDate } from '../src/core/types';
import { anchorGroupKey, anchorOf, caseGroupKey, findAnchor, followupHead } from '../src/planner/anchor';
import { detectClient } from '../src/planner/classify';
import { addDays, todayIso } from '../src/planner/dates';
import { bucketOf, BUCKETS, closedInWorklog, groupTasks, visibleCandidates } from '../src/planner/model';
import { undoOps } from '../src/planner/ops';
import { blockStatus, scanWorklogs, type Candidate } from '../src/planner/sources/worklog';
import type { EventRef, PlannerLogEntry, PlannerOp, PlannerState, Task, TaskPatch, WorklogAnchor } from '../src/planner/types';
import { appendBlockText, caseKey, newWorklogText, parseWorklog, toFileTitle } from '../src/worklog/format';

export const SERVER_NAME = 'tb-planner';
/** 알고 있는 MCP 규격 날짜 — 최신 것부터. 모르는 날짜를 요청받으면 맨 앞 것으로 답한다 */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 후보·닫힘을 볼 때 읽는 일지 기간(일) — 홈 화면과 같다 */
const SCAN_DAYS = 365;
const WORKLOG_BACKUP_DIR = 'worklog-backup';
const WORKLOG_BACKUP_KEEP = 30;
const FOLLOWUP_MAX_LINES = 40;
const FOLLOWUP_MAX_CHARS = 500;

/** 입력이 틀렸거나 할 수 없는 일 — 도구 결과의 오류 문구가 된다 */
export class ToolError extends Error {}

export interface ToolEnv {
  /** 플래너 저장 폴더 */
  dir: string;
  /** 작업일지 폴더 — 주지 않으면 환경 변수 TB_WORKLOG_ROOT, 앱이 적어 둔 app.json 순으로 찾는다 */
  worklogRoot?: string;
  /** 고친 쪽 — 기록에 남는다 */
  by: 'app' | 'claude';
  now(): Date;
}

export function defaultEnv(by: 'app' | 'claude' = 'claude'): ToolEnv {
  return { dir: plannerDir(), by, now: () => new Date() };
}

type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  /** 아무것도 고치지 않는다 */
  readOnly: boolean;
  run(env: ToolEnv, args: Args): Promise<unknown>;
}

// ── 인자 ────────────────────────────────────────────────────────────────────

function only(args: Args, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolError(`모르는 인자: ${extra.join(', ')} (쓸 수 있는 인자: ${allowed.join(', ') || '없음'})`);
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`${key}는 글자여야 합니다.`);
  return v;
}

function need(args: Args, key: string): string {
  const v = str(args, key)?.trim();
  if (!v) throw new ToolError(`${key}가 필요합니다.`);
  return v;
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`${key}는 true·false여야 합니다.`);
  return v;
}

function int(args: Args, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${key}는 숫자여야 합니다.`);
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 날짜 인자 — 안 줬으면 undefined, 비우기는 null */
function date(args: Args, key: string): string | null | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !isRealIsoDate(v)) throw new ToolError(`${key}는 날짜(YYYY-MM-DD)여야 합니다.`);
  return v;
}

function oneOf<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  if (!values.includes(v as T)) throw new ToolError(`${key}는 ${values.join('·')} 중 하나여야 합니다.`);
  return v as T;
}

function checkFolder(folder: unknown): string {
  const f = typeof folder === 'string' ? folder : '';
  if (f === '.' || f === '..' || /[\\/]/.test(f)) throw new ToolError('허용되지 않는 폴더입니다.');
  return f;
}

/** `planner_worklog_find_case`가 돌려준 case — 모양만 본다(실제 사안인지는 resolveCase가 파일을 읽어 확인한다) */
function caseArg(args: Args, key = 'case'): WorklogAnchor | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`${key}는 planner_worklog_find_case가 돌려준 case 그대로여야 합니다.`);
  const c = v as Record<string, unknown>;
  const name = typeof c.name === 'string' ? c.name : '';
  const m = WORKLOG_NAME_RE.exec(name);
  if (!m || /[\\/]/.test(name)) throw new ToolError(`${key}.name이 작업일지 파일명([YYYY-MM-DD] 제목.txt)이 아닙니다.`);
  const key2 = typeof c.caseKey === 'string' ? c.caseKey : '';
  if (!key2) throw new ToolError(`${key}.caseKey가 없습니다 — planner_worklog_find_case가 돌려준 case를 그대로 넘기세요.`);
  return {
    folder: checkFolder(c.folder),
    name,
    date: m[1],
    caseKey: key2,
    nth: Number.isInteger(c.nth) && (c.nth as number) >= 0 ? (c.nth as number) : 0,
    line: Number.isInteger(c.line) && (c.line as number) > 0 ? (c.line as number) : 1,
    title: typeof c.title === 'string' ? c.title : '',
    source: typeof c.source === 'string' ? c.source : '',
  };
}

// ── 저장소 ──────────────────────────────────────────────────────────────────

async function load(env: ToolEnv): Promise<{ state: PlannerState; path: string; warning?: string }> {
  const r = await readStore(env.dir);
  if (!r.ok) throw new ToolError(`플래너 저장소를 읽지 못했습니다: ${r.error}`);
  return r;
}

async function apply(env: ToolEnv, op: PlannerOp): Promise<PlannerState> {
  const r = await applyToStore(env.dir, op, env.by);
  if (!r.ok) throw new ToolError(r.error);
  return r.state;
}

function findTask(state: PlannerState, id: string): Task {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new ToolError(`그 할 일을 찾지 못했습니다(id ${id}) — planner_task_list로 id를 확인하세요.`);
  return t;
}

function taskView(t: Task, today: string) {
  return {
    id: t.id,
    title: t.title,
    state: t.doneAt ? 'done' : t.state,
    group: t.doneAt ? 'done' : t.state === 'waiting' ? 'waiting' : bucketOf(t, today),
    due: t.due,
    client: t.client || undefined,
    who: t.who || undefined,
    waiting_on: t.waitingOn || undefined,
    waiting_since: t.waitingSince ?? undefined,
    note: t.note || undefined,
    case: t.origin.kind === 'worklog' ? t.origin.anchor : undefined,
    event: t.event ?? undefined,
    done_at: t.doneAt ?? undefined,
    updated_at: t.updatedAt,
    by: t.by,
  };
}

function candidateView(c: Candidate) {
  return {
    title: c.title,
    client: c.client || undefined,
    who: c.who || undefined,
    status: c.cls,
    phrase: c.phrase,
    waiting_on: c.waitingOn || undefined,
    date: c.date,
    due: c.due ?? undefined,
    case: c.anchor,
  };
}

// ── 작업일지 읽기 ────────────────────────────────────────────────────────────

async function worklogRoot(env: ToolEnv): Promise<string> {
  const root = env.worklogRoot ?? (process.env.TB_WORKLOG_ROOT?.trim() || (await readAppInfo(env.dir)).worklogRoot || '');
  if (!root) {
    throw new ToolError('작업일지 폴더를 모릅니다 — 앱에서 작업일지 탭을 한 번 열거나, 환경 변수 TB_WORKLOG_ROOT에 폴더 경로를 넣으세요.');
  }
  if (!(await isDir(root))) throw new ToolError(`작업일지 폴더가 없습니다: ${root}`);
  return root;
}

interface Dated {
  name: string;
  date: string;
  title: string;
}

async function datedFiles(dir: string): Promise<Dated[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return []; // 읽을 수 없는 폴더는 건너뛴다
  }
  const out: Dated[] = [];
  for (const name of names) {
    const m = WORKLOG_NAME_RE.exec(name);
    if (m) out.push({ name, date: m[1], title: m[2].trim() });
  }
  return out;
}

/** 날짜 파일을 읽는다 — 작업일지 폴더 자체와 바로 아래 하위 폴더, `from` 이후 것만 */
async function readWorklogs(root: string, from: string, onlyFolder?: string): Promise<WorklogFileText[]> {
  let folders: string[];
  if (onlyFolder !== undefined) folders = [onlyFolder];
  else {
    const top = await fs.readdir(root, { withFileTypes: true });
    folders = ['', ...top.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)];
  }
  const out: WorklogFileText[] = [];
  for (const folder of folders) {
    for (const f of await datedFiles(path.join(root, folder))) {
      if (f.date < from) continue;
      const file = path.join(root, folder, f.name);
      try {
        const st = await fs.stat(file);
        if (st.size > MAX_FILE_BYTES) continue;
        const d = decodeWorklog(await fs.readFile(file));
        out.push({ folder, name: f.name, date: f.date, title: f.title, size: st.size, mtimeMs: st.mtimeMs, text: d.text });
      } catch {
        // 읽는 사이 사라졌거나 잠긴 파일
      }
    }
  }
  return out;
}

/** 작업일지 폴더 안의 실제 경로 — 밖으로 나가는 경로는 거부 */
function worklogFile(root: string, folder: string, name: string): string {
  const file = path.join(root, checkFolder(folder), name);
  const rel = path.relative(root, file);
  if (!WORKLOG_NAME_RE.test(name) || /[\\/]/.test(name) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError('작업일지 폴더 밖의 파일입니다.');
  }
  return file;
}

/** 넘겨받은 case가 지금 일지에 실제로 있는 사안인지 확인하고, 줄 번호를 지금 것으로 맞춘 닻을 돌려준다 */
async function resolveCase(env: ToolEnv, a: WorklogAnchor): Promise<WorklogAnchor> {
  const root = await worklogRoot(env);
  const file = worklogFile(root, a.folder, a.name);
  let text: string;
  try {
    text = decodeWorklog(await fs.readFile(file)).text;
  } catch {
    throw new ToolError(`그 일지 파일을 읽지 못했습니다: ${a.folder ? `${a.folder}/` : ''}${a.name} — planner_worklog_find_case로 다시 찾으세요.`);
  }
  const doc = parseWorklog(text);
  const block = findAnchor(doc, a);
  // 키가 사라져 줄 번호로 걸린 다른 사안에 잇지 않는다
  if (!block || caseKey(block) !== a.caseKey) {
    throw new ToolError('그 일지에서 사안을 찾지 못했습니다(제목이 바뀌었을 수 있습니다) — planner_worklog_find_case로 다시 찾으세요.');
  }
  return anchorOf({ folder: a.folder, name: a.name, date: a.date }, doc, block);
}

// ── 도구: 읽기 ──────────────────────────────────────────────────────────────

async function overview(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, []);
  const { state, path: store, warning } = await load(env);
  const today = todayIso(env.now());
  const groups = groupTasks(state.tasks, today);
  const open = [...BUCKETS.flatMap((b) => groups.buckets[b.id]), ...groups.waiting];
  const counts: Record<string, number> = { waiting: groups.waiting.length, done: groups.done.length };
  for (const b of BUCKETS) counts[b.id] = groups.buckets[b.id].length;

  let worklog: unknown;
  try {
    const root = await worklogRoot(env);
    const files = await readWorklogs(root, addDays(today, -SCAN_DAYS));
    const scan = scanWorklogs(files, { today, lookbackDays: state.settings.lookbackDays, clientOf: detectClient });
    const closed = closedInWorklog(state.tasks, scan);
    worklog = {
      ready: true,
      lookback_days: state.settings.lookbackDays,
      // 아직 할 일로 올리지 않은 열린 사안 — 홈의 "후보"와 같다
      candidates: visibleCandidates(scan.candidates, state).slice(0, 30).map(candidateView),
      older_open_cases: scan.older,
      // 일지에서는 닫혔는데 할 일은 열려 있는 것
      closed_in_worklog: [...closed].map(([id, on]) => ({ id, title: state.tasks.find((t) => t.id === id)?.title ?? '', closed_on: on })),
    };
  } catch (err) {
    worklog = { ready: false, error: err instanceof Error ? err.message : String(err) };
  }
  return {
    today,
    store,
    rev: state.rev,
    counts,
    open_tasks: open.slice(0, 60).map((t) => taskView(t, today)),
    ...(open.length > 60 ? { more_open_tasks: open.length - 60 } : {}),
    worklog,
    event_links: state.links.length,
    ...(warning ? { warning } : {}),
  };
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

async function taskList(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['state', 'client', 'query', 'due_to', 'limit']);
  const want = oneOf(args, 'state', ['open', 'todo', 'waiting', 'done', 'all'] as const) ?? 'open';
  const client = norm(str(args, 'client') ?? '');
  const query = norm(str(args, 'query') ?? '');
  const dueTo = date(args, 'due_to');
  const limit = int(args, 'limit', 50, 1, 200);
  const { state } = await load(env);
  const today = todayIso(env.now());
  const groups = groupTasks(state.tasks, today);
  const todo = BUCKETS.flatMap((b) => groups.buckets[b.id]);
  const pool =
    want === 'todo' ? todo : want === 'waiting' ? groups.waiting : want === 'done' ? groups.done : want === 'all' ? [...todo, ...groups.waiting, ...groups.done] : [...todo, ...groups.waiting];
  const hit = pool.filter(
    (t) => (!client || norm(t.client).includes(client)) && (!query || norm(`${t.title} ${t.note} ${t.who}`).includes(query)) && (!dueTo || (t.due !== null && t.due <= dueTo)),
  );
  return { today, total: hit.length, tasks: hit.slice(0, limit).map((t) => taskView(t, today)) };
}

async function findCase(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['query', 'days', 'folder', 'open_only', 'limit']);
  const tokens = (str(args, 'query') ?? '').split(/\s+/).map(norm).filter(Boolean);
  const { state } = await load(env);
  const days = int(args, 'days', state.settings.lookbackDays, 1, SCAN_DAYS);
  const folder = args.folder === undefined || args.folder === null ? undefined : checkFolder(args.folder);
  const openOnly = bool(args, 'open_only') ?? false;
  const limit = int(args, 'limit', 20, 1, 50);
  const today = todayIso(env.now());
  const root = await worklogRoot(env);
  const files = (await readWorklogs(root, addDays(today, -days), folder)).filter((f) => f.date <= today).sort((a, b) => a.date.localeCompare(b.date));

  interface Hit {
    case: WorklogAnchor;
    status: { cls: string; phrase: string } | null;
    first_date: string;
    occurrences: number;
    matched: boolean;
    /** 지난 회의 기록(`(캘린더 일정)` 블록)인가 — 홈의 후보에는 오르지 않지만 달력 일정을 잇는 데 쓴다 */
    meeting: boolean;
  }
  // 같은 사안(폴더 + 사안 키)은 하나로 — 가장 최근 기록을 가리킨다. 상태는 그 사안에서 마지막으로 나온 상태 줄
  const groups = new Map<string, Hit>();
  for (const f of files) {
    const doc = parseWorklog(f.text);
    for (const b of doc.blocks) {
      if (b.kind !== 'case' || !b.title.trim()) continue;
      const key = caseGroupKey(f.folder, caseKey(b));
      const st = blockStatus(b);
      const hay = norm(`${b.title} ${b.source?.raw ?? ''} ${f.folder} ${f.title}`);
      const prev = groups.get(key);
      groups.set(key, {
        case: anchorOf(f, doc, b),
        status: st ? { cls: st.status.cls, phrase: st.text.trim() } : (prev?.status ?? null),
        first_date: prev?.first_date ?? f.date,
        occurrences: (prev?.occurrences ?? 0) + 1,
        matched: (prev?.matched ?? false) || tokens.every((t) => hay.includes(t)),
        meeting: b.calendar,
      });
    }
  }
  const taken = new Map<string, string[]>();
  for (const t of state.tasks) {
    if (t.doneAt || t.origin.kind !== 'worklog') continue;
    const k = anchorGroupKey(t.origin.anchor);
    taken.set(k, [...(taken.get(k) ?? []), t.id]);
  }
  const hits = [...groups.values()]
    .filter((h) => h.matched && (!openOnly || (h.status !== null && h.status.cls !== 'done')))
    .sort((a, b) => b.case.date.localeCompare(a.case.date) || a.case.title.localeCompare(b.case.title));
  return {
    today,
    days,
    files: files.length,
    total: hits.length,
    cases: hits.slice(0, limit).map((h) => ({
      case: h.case,
      status: h.status,
      first_date: h.first_date,
      occurrences: h.occurrences,
      ...(h.meeting ? { meeting: true } : {}),
      // 이 사안에서 이미 올린 열린 할 일
      tasks: taken.get(anchorGroupKey(h.case)) ?? [],
    })),
  };
}

// ── 도구: 할 일 ─────────────────────────────────────────────────────────────

async function taskAdd(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['title', 'client', 'who', 'due', 'state', 'waiting_on', 'note', 'case', 'allow_duplicate']);
  const title = need(args, 'title');
  const due = date(args, 'due');
  const waitingOn = str(args, 'waiting_on');
  const state = oneOf(args, 'state', ['todo', 'waiting'] as const) ?? (waitingOn ? 'waiting' : 'todo');
  const picked = caseArg(args);
  const anchor = picked ? await resolveCase(env, picked) : undefined;
  const cur = (await load(env)).state;
  const open = cur.tasks.filter((t) => !t.doneAt);
  const dup = anchor
    ? open.find((t) => t.origin.kind === 'worklog' && anchorGroupKey(t.origin.anchor) === anchorGroupKey(anchor))
    : open.find((t) => norm(t.title) === norm(title));
  if (dup && !bool(args, 'allow_duplicate')) {
    throw new ToolError(
      `같은 ${anchor ? '사안에서 올린' : '제목의'} 열린 할 일이 이미 있습니다(id ${dup.id}, "${dup.title}") — 고치려면 planner_task_update, 그래도 따로 더하려면 allow_duplicate: true.`,
    );
  }
  const before = new Set(cur.tasks.map((t) => t.id));
  const next = await apply(env, {
    type: 'task.add',
    draft: {
      title,
      // 사안에서 올리면 폴더 이름의 고객사·사안의 요청자를 기본으로 채운다
      client: str(args, 'client') ?? (anchor ? detectClient(anchor.folder) : ''),
      who: str(args, 'who') ?? (anchor ? anchor.source.split('/')[0].trim() : ''),
      due: due ?? null,
      state,
      waitingOn: waitingOn ?? '',
      note: str(args, 'note') ?? '',
      origin: anchor ? { kind: 'worklog', anchor } : { kind: 'manual' },
    },
  });
  const task = next.tasks.find((t) => !before.has(t.id));
  if (!task) throw new ToolError('할 일을 더했지만 다시 읽지 못했습니다 — planner_task_list로 확인하세요.');
  return { rev: next.rev, task: taskView(task, todayIso(env.now())) };
}

async function taskUpdate(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['id', 'title', 'client', 'who', 'due', 'state', 'waiting_on', 'note', 'done']);
  const id = need(args, 'id');
  const cur = findTask((await load(env)).state, id);
  const patch: TaskPatch = {};
  const title = str(args, 'title');
  if (title !== undefined) patch.title = title;
  const client = str(args, 'client');
  if (client !== undefined) patch.client = client;
  const who = str(args, 'who');
  if (who !== undefined) patch.who = who;
  const note = str(args, 'note');
  if (note !== undefined) patch.note = note;
  const due = date(args, 'due');
  if (due !== undefined) patch.due = due;
  const waitingOn = str(args, 'waiting_on');
  // 기다리는 대상을 주면 "기다리는 중"으로 본다(state를 따로 주면 그것을 따른다)
  const state = oneOf(args, 'state', ['todo', 'waiting'] as const) ?? (waitingOn ? 'waiting' : undefined);
  if (state !== undefined) patch.state = state;
  if (waitingOn !== undefined) patch.waitingOn = waitingOn;
  const done = bool(args, 'done');
  const flip = done !== undefined && !!cur.doneAt !== done;
  if (Object.keys(patch).length === 0 && !flip) {
    throw new ToolError(done === undefined ? '바꿀 것이 없습니다 — title·client·who·due·state·waiting_on·note·done 중 하나를 주세요.' : `이미 ${done ? '끝낸' : '열린'} 할 일입니다.`);
  }
  const revs: number[] = [];
  let next: PlannerState | null = null;
  if (Object.keys(patch).length > 0) {
    next = await apply(env, { type: 'task.update', id, patch });
    revs.push(next.rev);
  }
  if (flip) {
    next = await apply(env, { type: 'task.done', id, done: !!done });
    revs.push(next.rev);
  }
  return { revs, task: taskView(findTask(next as PlannerState, id), todayIso(env.now())) };
}

async function eventLink(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['calendar_id', 'event_id', 'task_id', 'case', 'unlink']);
  const ref: EventRef = { calendarId: need(args, 'calendar_id'), eventId: need(args, 'event_id') };
  const taskId = str(args, 'task_id')?.trim();
  const picked = caseArg(args);
  const state = (await load(env)).state;
  const revs: number[] = [];
  const key = `${ref.calendarId}/${ref.eventId}`;
  if (bool(args, 'unlink')) {
    if (picked) throw new ToolError('끊을 때는 case를 주지 않습니다 — 일정에 이어진 사안은 하나뿐입니다.');
    if (taskId) {
      const t = findTask(state, taskId);
      if (!t.event || `${t.event.calendarId}/${t.event.eventId}` !== key) throw new ToolError('그 할 일은 이 일정에 이어져 있지 않습니다.');
      revs.push((await apply(env, { type: 'task.update', id: taskId, patch: { event: null } })).rev);
    } else {
      if (!state.links.some((l) => `${l.calendarId}/${l.eventId}` === key)) throw new ToolError('그 일정에 이어진 일지 사안이 없습니다.');
      revs.push((await apply(env, { type: 'link.remove', ref })).rev);
    }
    return { revs, unlinked: taskId ? { task_id: taskId } : { case: true } };
  }
  if (!taskId && !picked) throw new ToolError('task_id(할 일에 잇기)나 case(일지 사안에 잇기) 중 하나가 필요합니다.');
  const anchor = picked ? await resolveCase(env, picked) : undefined;
  if (taskId) findTask(state, taskId);
  if (anchor) revs.push((await apply(env, { type: 'link.set', link: { ...ref, anchor } })).rev);
  if (taskId) revs.push((await apply(env, { type: 'task.update', id: taskId, patch: { event: ref } })).rev);
  return { revs, linked: { ...(anchor ? { case: anchor } : {}), ...(taskId ? { task_id: taskId } : {}) } };
}

// ── 도구: 작업일지에 덧붙이기 ────────────────────────────────────────────────

const FOLLOWUP_LINE_RE = /^(?:▶ |- |※ | {0,4}> )\S/;

function followupLines(args: Args): string[] {
  const v = args.lines;
  if (!Array.isArray(v) || v.length === 0) throw new ToolError('lines가 필요합니다 — `▶ 한 일`, `- 확인한 사실`, `  > 부연`, `※ 메모` 줄의 배열.');
  if (v.length > FOLLOWUP_MAX_LINES) throw new ToolError(`lines는 ${FOLLOWUP_MAX_LINES}줄까지입니다.`);
  const out = v.map((x, i) => {
    if (typeof x !== 'string') throw new ToolError(`lines[${i}]는 글자여야 합니다.`);
    const line = x.replace(/\s+$/, '');
    // 줄바꿈·탭 같은 제어 문자가 들면 한 줄이 아니다
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new ToolError(`lines[${i}]에 줄바꿈·제어 문자가 있습니다 — 한 줄에 하나씩 나눠 주세요.`);
    if (line.length > FOLLOWUP_MAX_CHARS) throw new ToolError(`lines[${i}]가 너무 깁니다(${FOLLOWUP_MAX_CHARS}자까지).`);
    if (!FOLLOWUP_LINE_RE.test(line)) throw new ToolError(`lines[${i}]는 \`▶ \`·\`- \`·\`  > \`·\`※ \` 중 하나로 시작해야 합니다(■ 사안 머리는 도구가 붙입니다).`);
    return line;
  });
  if (!/^(?:▶|※) /.test(out[0])) throw new ToolError('첫 줄은 `▶ 한 일`이나 `※ 메모`여야 합니다.');
  return out;
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/** 덧붙이기 전 원본을 플래너 저장 폴더에 남긴다 — 파일별 최근 30개 */
async function backupWorklog(env: ToolEnv, folder: string, name: string, date: string, buf: Buffer): Promise<string> {
  const dir = path.join(env.dir, WORKLOG_BACKUP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const key = `${date}_${createHash('sha1').update(`${folder}/${name}`).digest('hex').slice(0, 8)}_`;
  const target = path.join(dir, `${key}${stamp(env.now())}.txt`);
  await fs.writeFile(target, buf);
  try {
    const mine = (await fs.readdir(dir)).filter((n) => n.startsWith(key)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - WORKLOG_BACKUP_KEEP))) await fs.rm(path.join(dir, old), { force: true });
  } catch {
    // 옛 백업 정리는 다음에 다시 한다
  }
  return target;
}

async function appendFollowup(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['case', 'lines', 'dry_run']);
  const picked = caseArg(args);
  if (!picked) throw new ToolError('case가 필요합니다 — planner_worklog_find_case가 돌려준 case를 그대로 넘기세요.');
  const lines = followupLines(args);
  const dry = bool(args, 'dry_run') ?? false;
  const anchor = await resolveCase(env, picked);
  const root = await worklogRoot(env);
  const today = todayIso(env.now());
  const block = [followupHead(anchor, today), ...lines].join('\n');
  const dir = path.join(root, anchor.folder);
  const todays = (await datedFiles(dir)).filter((f) => f.date === today);
  if (todays.length > 1) throw new ToolError(`오늘(${today}) 일지가 ${todays.length}개라 어디에 붙일지 고를 수 없습니다 — 하나로 합친 뒤 다시 하세요.`);

  if (todays.length === 0) {
    // 오늘 일지가 아직 없다 — 그 블록으로 새로 만든다(앱의 [오늘 일지에 기록]과 같다)
    const title = toFileTitle(anchor.title.replace(/\s*\(\d{1,2}\/\d{1,2}\s*[^)]*후속\)\s*$/, '')).slice(0, 80) || '작업';
    const name = `[${today}] ${title}.txt`;
    if (dry) return { dry_run: true, folder: anchor.folder, file: name, created: true, block };
    try {
      await fs.writeFile(worklogFile(root, anchor.folder, name), encodeWorklog(newWorklogText(today, title, block), false, false), { flag: 'wx' });
    } catch (err) {
      throw new ToolError(`오늘 일지를 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { folder: anchor.folder, file: name, created: true, block };
  }

  const name = todays[0].name;
  const file = worklogFile(root, anchor.folder, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const buf = await fs.readFile(file);
    if (buf.length > MAX_FILE_BYTES) throw new ToolError('오늘 일지가 너무 큽니다(2MB 초과).');
    const d = decodeWorklog(buf);
    if (d.legacyEncoding) throw new ToolError('오늘 일지가 UTF-8이 아닙니다 — 앱에서 열어 저장한 뒤 다시 하세요.');
    if (d.text.includes(block)) throw new ToolError('오늘 일지에 같은 블록이 이미 있습니다 — 쓰지 않았습니다.');
    const head = d.text.replace(/\s+$/, '');
    const text = appendBlockText(d.text, block);
    if (dry) return { dry_run: true, folder: anchor.folder, file: name, created: false, block };
    const backup = await backupWorklog(env, anchor.folder, name, today, buf);
    // 읽은 뒤 바뀌었으면(루틴이 덧붙였거나 앱·메모장에서 고침) 바뀐 내용 뒤에 다시 붙인다
    if (!(await fs.readFile(file)).equals(buf)) continue;
    await writeFileAtomic(file, encodeWorklog(text, d.bom, d.crlf), { prefix: '.tb-worklog-', fallbackDirect: true });
    const after = decodeWorklog(await fs.readFile(file)).text;
    if (!after.startsWith(head) || !after.endsWith(`${block}\n`)) {
      // 쓴 결과가 "원래 내용 + 블록"이 아니다 — 원본으로 되돌린다
      await fs.writeFile(file, buf);
      throw new ToolError('일지에 쓴 결과를 확인하지 못해 원래 내용으로 되돌렸습니다.');
    }
    return { folder: anchor.folder, file: name, created: false, block, backup };
  }
  throw new ToolError('일지가 계속 바뀌고 있어 쓰지 못했습니다 — 잠시 뒤 다시 하세요.');
}

// ── 도구: 바뀐 기록 · 되돌리기 ───────────────────────────────────────────────

function logView(e: PlannerLogEntry, by: ToolEnv['by']) {
  const after = (e.after ?? {}) as { title?: string };
  const before = (e.before ?? {}) as { title?: string };
  return {
    rev: e.rev,
    at: e.at,
    by: e.by,
    op: e.op,
    id: e.id,
    title: after.title ?? before.title,
    // 도구는 자기가 고친 것만 되돌린다
    undoable: e.by === by && undoOps(e) !== null,
  };
}

async function changes(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['limit', 'by']);
  const limit = int(args, 'limit', 20, 1, 100);
  const by = oneOf(args, 'by', ['app', 'claude'] as const);
  const entries = (await readLog(env.dir, 500)).filter((e) => !by || e.by === by);
  return { total: entries.length, changes: entries.slice(0, limit).map((e) => logView(e, env.by)) };
}

async function undo(env: ToolEnv, args: Args): Promise<unknown> {
  only(args, ['rev']);
  if (typeof args.rev !== 'number' || !Number.isInteger(args.rev)) throw new ToolError('rev(되돌릴 기록의 번호)가 필요합니다 — planner_changes로 확인하세요.');
  const entry = (await readLog(env.dir, 500)).find((e) => e.rev === args.rev);
  if (!entry) throw new ToolError(`기록 ${args.rev}번을 찾지 못했습니다(최근 500줄만 남습니다).`);
  if (entry.by !== env.by) throw new ToolError('앱에서 사용자가 고친 기록입니다 — 도구는 자기가 고친 것만 되돌립니다. 앱의 ⋯ → 바뀐 기록에서 되돌리세요.');
  const ops = undoOps(entry);
  if (!ops) throw new ToolError('되돌릴 수 없는 기록입니다.');
  // 그 뒤에 다시 바뀐 할 일은 되돌리지 않는다 — 나중에 고친 것까지 함께 돌아가기 때문이다
  const state = (await load(env)).state;
  if (entry.id) {
    const now = state.tasks.find((t) => t.id === entry.id);
    const after = entry.after as Task | undefined;
    if (entry.op === 'task.remove') {
      if (now) throw new ToolError('그 할 일은 이미 되살아나 있습니다.');
    } else if (!now) throw new ToolError('그 할 일은 이미 없습니다.');
    else if (after && now.updatedAt !== after.updatedAt) throw new ToolError('그 뒤에 다시 바뀐 할 일입니다 — 되돌리지 않았습니다. planner_task_update로 고치세요.');
  }
  const revs: number[] = [];
  for (const op of ops) revs.push((await apply(env, op)).rev);
  return { undone: logView(entry, env.by), revs };
}

// ── 도구 목록 ───────────────────────────────────────────────────────────────

const CASE_SCHEMA: Schema = {
  type: 'object',
  description: 'planner_worklog_find_case(또는 planner_overview의 후보·할 일)가 돌려준 case를 그대로 넘긴다.',
  properties: {
    folder: { type: 'string' },
    name: { type: 'string' },
    date: { type: 'string' },
    caseKey: { type: 'string' },
    nth: { type: 'integer' },
    line: { type: 'integer' },
    title: { type: 'string' },
    source: { type: 'string' },
  },
  required: ['folder', 'name', 'caseKey'],
};

const obj = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'planner_overview',
    description:
      '홈 화면의 지금 상태를 한 번에 본다 — 열린 할 일(기한 지남·오늘·이번 주·다음 주 이후·기한 없음·기다리는 중), 작업일지에서 아직 할 일로 올리지 않은 열린 사안(후보), 일지에서는 닫혔는데 열려 있는 할 일. 무엇을 고치기 전에 먼저 부른다.',
    inputSchema: obj({}),
    readOnly: true,
    run: overview,
  },
  {
    name: 'planner_task_list',
    description: '할 일 목록. state: open(기본 — 내 차례 + 기다리는 중)·todo·waiting·done·all. client·query(제목·메모·요청자)·due_to(그 날짜까지 기한)로 거른다.',
    inputSchema: obj({
      state: { type: 'string', enum: ['open', 'todo', 'waiting', 'done', 'all'] },
      client: { type: 'string', description: '고객사·구분에 들어 있는 글자' },
      query: { type: 'string', description: '제목·메모·요청자에 들어 있는 글자' },
      due_to: { type: 'string', description: 'YYYY-MM-DD — 기한이 이 날짜까지인 것' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    readOnly: true,
    run: taskList,
  },
  {
    name: 'planner_worklog_find_case',
    description:
      '작업일지에서 사안(■ 블록)을 찾는다. 같은 사안은 하나로 묶어 가장 최근 기록을 돌려준다. 돌려준 case는 planner_task_add·planner_event_link·planner_worklog_append_followup에 그대로 넘긴다. query는 사안 제목·요청자·폴더·파일 제목에서 찾는 낱말(띄어 쓰면 모두 들어 있어야 한다), 비우면 기간 안의 모든 사안. meeting: true는 지난 회의 기록이다.',
    inputSchema: obj({
      query: { type: 'string' },
      days: { type: 'integer', minimum: 1, maximum: SCAN_DAYS, description: '며칠 전 일지까지 볼지 (기본: 홈 설정의 후보 기간)' },
      folder: { type: 'string', description: '작업일지 폴더 아래 하위 폴더 이름 하나로 좁힌다' },
      open_only: { type: 'boolean', description: '마지막 상태가 열려 있는(회신 대기·확인 필요·예정 등) 사안만' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    readOnly: true,
    run: findCase,
  },
  {
    name: 'planner_task_add',
    description:
      '할 일을 더한다. case를 주면 그 일지 사안에서 올린 할 일이 되어 홈에서 출처를 누르면 그 사안이 열린다(고객사·요청자는 사안에서 채운다). 같은 사안·같은 제목의 열린 할 일이 있으면 더하지 않고 알려 준다.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        client: { type: 'string', description: '고객사·구분' },
        who: { type: 'string', description: '요청자' },
        due: { type: 'string', description: '기한 YYYY-MM-DD' },
        state: { type: 'string', enum: ['todo', 'waiting'], description: 'todo = 내 차례(기본), waiting = 기다리는 중' },
        waiting_on: { type: 'string', description: '기다리는 대상 — 주면 기다리는 중으로 더한다' },
        note: { type: 'string' },
        case: CASE_SCHEMA,
        allow_duplicate: { type: 'boolean' },
      },
      ['title'],
    ),
    readOnly: false,
    run: taskAdd,
  },
  {
    name: 'planner_task_update',
    description:
      '할 일을 고친다 — 제목·고객사·요청자·기한(due: null이면 기한 없음)·상태·기다리는 대상·메모, 끝냄(done: true)·끝냄 취소(done: false). 지우지는 않는다(지우기는 앱에서). 고친 것은 planner_undo로 되돌릴 수 있다.',
    inputSchema: obj(
      {
        id: { type: 'string' },
        title: { type: 'string' },
        client: { type: 'string' },
        who: { type: 'string' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD, null = 기한 없음' },
        state: { type: 'string', enum: ['todo', 'waiting'] },
        waiting_on: { type: 'string' },
        note: { type: 'string' },
        done: { type: 'boolean' },
      },
      ['id'],
    ),
    readOnly: false,
    run: taskUpdate,
  },
  {
    name: 'planner_event_link',
    description:
      '달력 일정을 할 일(task_id)이나 일지 사안(case)에 잇는다 — 홈의 일정에서 그 사안·할 일로 넘어갈 수 있다. 일정 자체(시각·제목)는 바꾸지 않는다. calendar_id·event_id는 달력 도구가 돌려준 값(본인 달력은 primary). unlink: true면 끊는다.',
    inputSchema: obj(
      {
        calendar_id: { type: 'string' },
        event_id: { type: 'string' },
        task_id: { type: 'string' },
        case: CASE_SCHEMA,
        unlink: { type: 'boolean' },
      },
      ['calendar_id', 'event_id'],
    ),
    readOnly: false,
    run: eventLink,
  },
  {
    name: 'planner_worklog_append_followup',
    description:
      '그 사안의 후속 블록을 오늘 일지 끝에 덧붙인다(같은 폴더). 머리 줄 `■ (요청자/채널) 사안 (M/D 문의 후속)`은 도구가 붙이고, lines에는 그 아래 줄만 준다: `▶ 한 일`, `- 확인한 사실`, `  > 부연`, `※ 메모`. 지난 일지와 기존 줄은 건드리지 않는다. 오늘 일지가 없으면 새로 만든다. dry_run: true면 쓰지 않고 붙일 블록만 보여 준다.',
    inputSchema: obj(
      {
        case: CASE_SCHEMA,
        lines: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: FOLLOWUP_MAX_LINES },
        dry_run: { type: 'boolean' },
      },
      ['case', 'lines'],
    ),
    readOnly: false,
    run: appendFollowup,
  },
  {
    name: 'planner_changes',
    description: '할 일 저장소가 바뀐 기록 — 최근 것부터. 앱에서 사용자가 고친 것(by: app)과 도구가 고친 것(by: claude)이 함께 나온다. undoable이 true인 기록은 planner_undo로 되돌릴 수 있다.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 }, by: { type: 'string', enum: ['app', 'claude'] } }),
    readOnly: true,
    run: changes,
  },
  {
    name: 'planner_undo',
    description: '기록 하나를 되돌린다(rev = planner_changes의 번호). 도구가 고친 기록만, 그 뒤에 다시 바뀌지 않았을 때만 되돌린다.',
    inputSchema: obj({ rev: { type: 'integer' } }, ['rev']),
    readOnly: false,
    run: undo,
  },
];

export type ToolResult = { ok: true; result: unknown } | { ok: false; result: { error: string } };

export async function callTool(env: ToolEnv, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: { error: `모르는 도구입니다: ${name}` } };
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, result: { error: '인자는 JSON 객체여야 합니다.' } };
  try {
    return { ok: true, result: await tool.run(env, input as Args) };
  } catch (err) {
    return { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
  }
}

// ── MCP 서버 (stdio · 한 줄에 JSON-RPC 메시지 하나) ──────────────────────────

const INSTRUCTIONS = [
  'TemplateBuilder 홈 화면의 할 일과 작업일지 사안을 다룬다.',
  '- 먼저 planner_overview로 지금 상태를 본다.',
  '- 일지 사안은 planner_worklog_find_case로 찾고, 돌려받은 case를 다른 도구에 그대로 넘긴다.',
  '- 달력 일정의 시각·제목을 바꾸거나 새로 잡는 일은 달력 도구로 한다. 여기서는 일정 ID를 할 일·사안에 잇기만 한다(planner_event_link).',
  '- 일지에는 오늘 일지 끝에 후속 블록을 덧붙이는 것만 한다(planner_worklog_append_followup). 지난 일지는 고치지 않는다.',
  '- 고친 것은 앱에 "바뀜"으로 표시되고, planner_undo나 앱의 바뀐 기록에서 되돌릴 수 있다.',
].join('\n');

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } };
}

/** 메시지 하나를 처리한다 — 답할 것이 없으면(알림) null */
export async function handleRpc(env: ToolEnv, msg: unknown): Promise<unknown> {
  if (Array.isArray(msg)) {
    const out: unknown[] = [];
    for (const one of msg) {
      const res = await handleRpc(env, one);
      if (res !== null) out.push(res);
    }
    return out.length ? out : null;
  }
  const m = msg as RpcRequest | null;
  if (!m || typeof m !== 'object') return rpcError(null, -32600, 'Invalid Request');
  // 이쪽에서 보낸 요청이 없으므로 응답 모양의 메시지는 흘려보낸다
  if (m.method === undefined && ('result' in m || 'error' in m)) return null;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m.id, -32600, 'Invalid Request');
  const isRequest = typeof m.id === 'string' || typeof m.id === 'number';
  if (!isRequest) return null; // 알림 — notifications/initialized 등
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: APP_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((t) => t.name === name)) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
      const r = await callTool(env, name, params.arguments);
      return ok({ content: [{ type: 'text', text: JSON.stringify(r.result, null, 1) }], isError: !r.ok });
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

/** 표준 입력으로 받은 메시지를 차례로 처리해 표준 출력에 답한다 — 입력이 닫히면 끝난다 */
export async function serveStdio(env: ToolEnv, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  const send = (msg: unknown) => {
    output.write(`${JSON.stringify(msg)}\n`);
  };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        send(rpcError(null, -32700, 'Parse error'));
        return;
      }
      try {
        const res = await handleRpc(env, msg);
        if (res !== null) send(res);
      } catch (err) {
        send(rpcError((msg as RpcRequest | null)?.id, -32603, err instanceof Error ? err.message : String(err)));
      }
    });
  });
  await new Promise<void>((resolve) => rl.once('close', resolve));
  await chain;
}

// ── 명령줄 ──────────────────────────────────────────────────────────────────

const USAGE = [
  '플래너 도구 — TemplateBuilder 홈의 할 일·작업일지 사안',
  '',
  '  planner-tool mcp                      MCP 서버(stdio)',
  '  planner-tool tools                    도구 목록',
  '  planner-tool call <도구> [인자]       도구 하나 실행 — 인자는 JSON 글자, @파일.json, 또는 - (표준 입력)',
  '',
  '  --by=app    기록에 사용자가 고친 것으로 남긴다(기본은 claude)',
  '',
  '환경 변수: TB_PLANNER_DIR(저장 폴더, 기본 사용자 폴더의 .template-builder) · TB_WORKLOG_ROOT(작업일지 폴더)',
].join('\n');

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** 명령줄 진입점 — 종료 코드를 돌려준다 */
export async function main(argv: readonly string[]): Promise<number> {
  const rest = argv.filter((a) => !a.startsWith('--'));
  const env = defaultEnv(argv.includes('--by=app') ? 'app' : 'claude');
  const [cmd, name, raw] = rest;
  if (cmd === 'mcp') {
    await serveStdio(env);
    return 0;
  }
  if (cmd === 'tools') {
    for (const t of TOOLS) process.stdout.write(`${t.name}${t.readOnly ? '' : ' (쓰기)'}\n  ${t.description}\n`);
    return 0;
  }
  if (cmd === 'call' && name) {
    let args: unknown = {};
    try {
      const text = raw === '-' ? await readAll(process.stdin) : raw?.startsWith('@') ? await fs.readFile(raw.slice(1), 'utf8') : raw;
      if (text && text.trim()) args = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (err) {
      process.stderr.write(`인자를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const r = await callTool(env, name, args);
    process.stdout.write(`${JSON.stringify(r.result, null, 1)}\n`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return cmd && cmd !== 'help' ? 2 : 0;
}
