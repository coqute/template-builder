/**
 * 플래너 저장소 — `사용자 폴더/.template-builder/` 아래 planner.json 읽기·쓰기·잠금·백업·기록.
 * main 전용이지만 Electron에 기대지 않아 테스트(와 나중의 명령줄 도구)에서 바로 쓴다. 설계: docs/home-schedule-design.md §8
 *
 * - 고치는 길은 `applyToStore` 하나다: 잠금 → 읽기 → 동작(src/planner/ops.ts) → 이전 내용 백업 → 임시 파일에 쓰고 바꿔치기 → 기록 한 줄.
 * - 앱 데이터 폴더가 아니라 사용자 폴더에 둔다 — 앱 밖의 도구도 같은 파일을 보게 한다(설계 §1.5).
 * - 깨진 파일은 지우지 않고 옆으로 옮긴 뒤, 읽히는 가장 최근 백업으로 연다. 백업도 없으면 빈 상태로 연다.
 */
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic';
import { applyOp, emptyState, newTaskId, normalizeState, PlannerError } from '../src/planner/ops';
import type { PlannerLogEntry, PlannerOp, PlannerResult, PlannerState, PlannerStatResult } from '../src/planner/types';

export const STATE_NAME = 'planner.json';
export const LOG_NAME = 'planner-log.jsonl';
export const BACKUP_DIR_NAME = 'planner-backup';
export const LOCK_NAME = 'planner.json.lock';
export const BACKUP_KEEP = 20;
export const LOG_KEEP = 500;

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 5000;
const TMP_PREFIX = '.tb-planner-';
const BACKUP_NAME_RE = /^planner-\d{8}-\d{9}-r\d+\.json$/;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 저장 폴더 — 호출 때마다 읽는다(테스트·도구가 TB_PLANNER_DIR로 바꿀 수 있게) */
export function plannerDir(): string {
  const env = process.env.TB_PLANNER_DIR;
  return env && env.trim() ? env : path.join(os.homedir(), '.template-builder');
}

/** 이 컴퓨터의 날짜 YYYY-MM-DD — "오늘"은 사용자가 보는 달력 날짜다 */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 파일 이름에 넣는 시각 `YYYYMMDD-HHMMSSmmm` — 이름순이 곧 시간순 */
function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/** 사람이 열어 볼 수 있게 들여쓰기 1칸 */
function serialize(state: PlannerState): string {
  return JSON.stringify(state, null, 1);
}

/** 메모장으로 고쳐 BOM이 붙은 파일도 읽는다. JSON이 깨졌거나 모양이 다르면 던진다 */
function parseState(raw: string): PlannerState {
  return normalizeState(JSON.parse(raw.replace(/^﻿/, '')));
}

/** 파일 본문 — 없으면 null. 권한·잠김 같은 다른 오류는 그대로 던진다(깨진 파일로 보지 않는다) */
async function readRaw(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (code(err) === 'ENOENT') return null;
    throw err;
  }
}

const RENAME_RETRY_MS = [15, 40, 80];

/**
 * 임시 파일에 쓴 뒤 바꿔치기. Windows에서는 다른 프로세스가 대상을 읽으려고 열어 둔 동안 바꿔치기가 EPERM으로 막힌다
 * (2026-11-23 실측: 읽는 프로세스 2개를 쉬지 않고 돌리면 0.3초 동안 다시 해도 실패). 몇 번 다시 해 보고, 끝까지 막히면 바로 쓴다.
 * 바로 쓰는 동안 남이 반쪽을 읽어도 괜찮다 — 읽는 쪽은 해석에 실패하면 잠금을 쥐고 다시 읽고(readStore), 잠금은 지금 이쪽이 쥐고 있다.
 * 쓰다가 프로세스가 죽어 반쪽이 남으면 직전에 만든 백업으로 열린다.
 */
async function write(file: string, data: string): Promise<void> {
  for (let i = 0; ; i++) {
    const last = i >= RENAME_RETRY_MS.length;
    try {
      await writeFileAtomic(file, data, { prefix: TMP_PREFIX, fallbackDirect: last });
      return;
    } catch (err) {
      if (last || !['EPERM', 'EBUSY', 'EACCES'].includes(code(err))) throw err;
      await sleep(RENAME_RETRY_MS[i]);
    }
  }
}

// ── 잠금 ────────────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/**
 * 프로세스 사이 잠금 — `planner.json.lock`을 배타 생성(wx)한다. 2초쯤 다시 시도하고,
 * 5초 넘은 잠금은 쓰다 죽은 프로세스가 남긴 것으로 보고 지운다. 돌려주는 함수로 푼다.
 */
async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const lock = path.join(dir, LOCK_NAME);
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let blocked: unknown;
    try {
      await fs.writeFile(lock, token, { flag: 'wx' });
      return async () => {
        // 내 잠금일 때만 지운다 — 5초를 넘겨 남이 오래된 잠금으로 보고 새로 잡았다면 그 잠금은 그대로 둔다
        try {
          if ((await fs.readFile(lock, 'utf8')) !== token) return;
        } catch (err) {
          if (code(err) === 'ENOENT') return;
        }
        await fs.rm(lock, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      // EEXIST = 남이 쥐고 있다. EPERM·EBUSY = Windows에서 지워지는 중인 잠금 파일에 닿았을 때
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(code(err))) throw err;
      blocked = err;
    }
    const st = await fs.stat(lock).catch(() => null); // null = 그 사이 풀렸다
    const stale = st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS;
    if (stale) await fs.rm(lock, { force: true }).catch(() => undefined);
    if (Date.now() >= deadline) {
      if (code(blocked) !== 'EEXIST') throw blocked;
      throw new PlannerError('다른 곳에서 플래너를 저장하는 중입니다 — 잠시 뒤 다시 시도하세요.');
    }
    // 풀렸거나 오래된 잠금을 치웠으면 곧바로, 남이 쥐고 있으면 조금 기다렸다가 다시 잡는다
    await sleep(st === null || stale ? 5 : 10 + Math.floor(Math.random() * 15));
  }
}

/** 같은 프로세스 안은 프라미스로 줄을 세우고, 프로세스 사이는 잠금 파일로 막는다. 어느 경로로 끝나든 잠금을 남기지 않는다 */
function withLock<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const release = await acquireLock(dir);
    try {
      return await job();
    } finally {
      await release();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

// ── 읽기 ────────────────────────────────────────────────────────────────────

interface Loaded {
  state: PlannerState;
  /** 덮어쓰기 전에 백업할 이전 본문 — 파일이 없었거나 방금 백업에서 되살렸으면 null */
  prev: string | null;
  warning?: string;
}

/** 읽히는 가장 최근 백업 — 맨 뒤 것이 깨졌으면 그 앞 것으로 */
async function latestBackup(dir: string): Promise<{ name: string; state: PlannerState } | null> {
  const bdir = path.join(dir, BACKUP_DIR_NAME);
  let names: string[];
  try {
    names = (await fs.readdir(bdir)).filter((n) => BACKUP_NAME_RE.test(n)).sort().reverse();
  } catch {
    return null; // 백업 폴더 없음
  }
  for (const name of names) {
    try {
      return { name, state: parseState(await fs.readFile(path.join(bdir, name), 'utf8')) };
    } catch {
      // 이 백업도 읽지 못한다 — 더 옛것을 본다
    }
  }
  return null;
}

/**
 * 깨진 planner.json을 `planner.json.bad-<시각>`으로 옮기고 백업·빈 상태로 연다 (잠금을 쥔 채 부른다).
 * 백업에서 열었으면 그 내용을 planner.json으로 다시 써 둔다 — 안 그러면 다음에 읽을 때 "파일 없음 = 빈 상태"가 된다.
 */
async function recover(dir: string): Promise<Loaded> {
  const file = path.join(dir, STATE_NAME);
  const bad = `${STATE_NAME}.bad-${stamp()}`;
  await fs.rename(file, path.join(dir, bad));
  const moved = `읽지 못한 파일은 ${bad}(으)로 옮겨 두었습니다.`;
  const bak = await latestBackup(dir);
  if (!bak) {
    return { state: emptyState(), prev: null, warning: `플래너 저장 파일(${STATE_NAME})을 읽지 못해 빈 상태로 열었습니다 — 쓸 수 있는 백업이 없습니다. ${moved}` };
  }
  await write(file, serialize(bak.state));
  return { state: bak.state, prev: null, warning: `플래너 저장 파일(${STATE_NAME})을 읽지 못해 가장 최근 백업(${bak.name})으로 열었습니다. ${moved}` };
}

/** 잠금을 쥔 채 읽는다 — 깨졌으면 옆으로 옮기고 백업·빈 상태로 */
async function loadLocked(dir: string): Promise<Loaded> {
  const raw = await readRaw(path.join(dir, STATE_NAME));
  if (raw === null) return { state: emptyState(), prev: null };
  try {
    return { state: parseState(raw), prev: raw };
  } catch {
    return recover(dir);
  }
}

/** 저장소 읽기 — 파일이 없으면 빈 상태(파일·폴더를 만들지 않는다) */
export async function readStore(dir: string): Promise<PlannerResult> {
  const file = path.join(dir, STATE_NAME);
  try {
    const raw = await readRaw(file);
    if (raw === null) return { ok: true, state: emptyState(), path: file };
    try {
      return { ok: true, state: parseState(raw), path: file };
    } catch {
      // 해석 실패 — 남이 쓰는 중인 반쪽을 봤을 수도, 다른 쪽이 이미 되살렸을 수도 있다.
      // 옮기는 일은 잠금을 쥐고 다시 읽어 보고 그래도 깨져 있을 때만 한다
    }
    const loaded = await withLock(dir, () => loadLocked(dir));
    return { ok: true, state: loaded.state, path: file, ...(loaded.warning ? { warning: loaded.warning } : {}) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** 파일 시각·크기 — 바깥 변경을 알아채는 데 쓴다. 파일이 없으면 0 */
export async function statStore(dir: string): Promise<PlannerStatResult> {
  try {
    const st = await fs.stat(path.join(dir, STATE_NAME));
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (code(err) === 'ENOENT') return { ok: true, mtimeMs: 0, size: 0 };
    return { ok: false, error: errMsg(err) };
  }
}

// ── 쓰기 ────────────────────────────────────────────────────────────────────

/** 바꾸기 전 planner.json을 `planner-backup/planner-<시각>-r<rev>.json`으로 — 최근 20개만 남긴다 */
async function backup(dir: string, prev: string, rev: number): Promise<void> {
  const bdir = path.join(dir, BACKUP_DIR_NAME);
  await fs.mkdir(bdir, { recursive: true });
  await fs.writeFile(path.join(bdir, `planner-${stamp()}-r${String(rev).padStart(6, '0')}.json`), prev, 'utf8');
  try {
    const all = (await fs.readdir(bdir)).filter((n) => BACKUP_NAME_RE.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
      await fs.rm(path.join(bdir, old), { force: true });
    }
  } catch {
    // 옛 백업 정리는 다음 저장 때 다시 한다
  }
}

/**
 * 기록 한 줄 덧붙이기 — 500줄을 넘으면 최근 500줄만 남긴다.
 * 기록을 못 남겨도 저장은 이미 끝났으므로 실패로 돌리지 않고 안내 문구만 돌려준다.
 */
async function appendLog(dir: string, entry: PlannerLogEntry): Promise<string | undefined> {
  const file = path.join(dir, LOG_NAME);
  const line = JSON.stringify(entry);
  try {
    const old = (await readRaw(file)) ?? '';
    const lines = old.split('\n').filter((l) => l.trim());
    if (lines.length < LOG_KEEP && (old === '' || old.endsWith('\n'))) {
      await fs.appendFile(file, `${line}\n`, 'utf8');
    } else {
      await write(file, `${[...lines, line].slice(-LOG_KEEP).join('\n')}\n`);
    }
    return undefined;
  } catch (err) {
    return `바뀐 기록(${LOG_NAME})을 남기지 못했습니다: ${errMsg(err)}`;
  }
}

/**
 * 동작 하나를 저장소에 적용한다. 입력이 틀리면(PlannerError) 파일을 바꾸지 않고 `{ ok:false, error }`.
 * `by`는 고친 쪽 — 앱 화면은 'app'.
 */
export async function applyToStore(dir: string, op: PlannerOp, by: 'app' | 'claude'): Promise<PlannerResult> {
  const file = path.join(dir, STATE_NAME);
  try {
    if (!op || typeof op !== 'object') throw new PlannerError('모르는 동작입니다.');
    await fs.mkdir(dir, { recursive: true });
    return await withLock(dir, async (): Promise<PlannerResult> => {
      const loaded = await loadLocked(dir);
      const now = new Date();
      const { state, log } = applyOp(loaded.state, op, {
        now: now.toISOString(),
        today: localDate(now),
        by: by === 'claude' ? 'claude' : 'app',
        newId: newTaskId,
      });
      if (loaded.prev !== null) await backup(dir, loaded.prev, loaded.state.rev);
      await write(file, serialize(state));
      const warning = [loaded.warning, await appendLog(dir, log)].filter(Boolean).join(' ');
      return { ok: true, state, path: file, ...(warning ? { warning } : {}) };
    });
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ── 기록 읽기 · 앱 정보 ───────────────────────────────────────────────────────

/** 바뀐 기록 — 최근 것부터 `limit`줄. 해석되지 않는 줄은 건너뛴다 */
export async function readLog(dir: string, limit = 50): Promise<PlannerLogEntry[]> {
  const raw = (await readRaw(path.join(dir, LOG_NAME)).catch(() => null)) ?? '';
  const out: PlannerLogEntry[] = [];
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, limit); i--) {
    try {
      const e = JSON.parse(lines[i]) as PlannerLogEntry;
      if (e && typeof e === 'object' && typeof e.op === 'string' && typeof e.rev === 'number') out.push(e);
    } catch {
      // 반쯤 쓰인 줄 — 건너뛴다
    }
  }
  return out;
}

export const APP_INFO_NAME = 'app.json';

/**
 * 앱이 알려 주는 정보 — 지금은 작업일지 폴더 하나.
 * 명령줄·MCP 도구는 앱 데이터 폴더의 설정을 볼 수 없어(다른 프로그램이 띄운 프로세스는 그 폴더의 사본을 본다)
 * 작업일지가 어디 있는지 모른다. 앱이 작업일지 폴더를 읽을 때마다 여기에 적어 둔다.
 */
export interface PlannerAppInfo {
  worklogRoot?: string;
}

export async function readAppInfo(dir: string): Promise<PlannerAppInfo> {
  try {
    const raw = JSON.parse(((await readRaw(path.join(dir, APP_INFO_NAME))) ?? '{}').replace(/^﻿/, '')) as PlannerAppInfo | null;
    return raw && typeof raw === 'object' ? { ...(typeof raw.worklogRoot === 'string' && raw.worklogRoot ? { worklogRoot: raw.worklogRoot } : {}) } : {};
  } catch {
    return {};
  }
}

/** 바뀌었을 때만 쓴다 — 실패해도 앱 동작에는 영향이 없다 */
export async function writeAppInfo(dir: string, info: PlannerAppInfo): Promise<void> {
  try {
    const cur = await readAppInfo(dir);
    if (cur.worklogRoot === info.worklogRoot) return;
    await fs.mkdir(dir, { recursive: true });
    await write(path.join(dir, APP_INFO_NAME), JSON.stringify({ ...cur, ...info }, null, 1));
  } catch {
    // 도구가 작업일지 폴더를 못 찾을 뿐이다 — 그때는 환경 변수로 알려 준다
  }
}
