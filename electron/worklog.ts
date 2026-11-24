/**
 * 작업일지 — 사용자가 고른 작업일지 폴더(기본 C:\worklog) 아래 `[YYYY-MM-DD] 제목.txt` 파일 읽기·쓰기 (main 전용).
 *
 * - 파일명 246자·경로 272자짜리 수기 파일이 실재한다. Node fs는 Windows에서 긴 경로를 스스로 처리하므로
 *   Git Bash 글롭처럼 목록에서 빠지지 않는다(2026-10-21 실측).
 * - 매일 작업일지 루틴이 파일 끝에 덧붙인다. 저장은 "마지막으로 읽은 본문(base)"이 디스크와 같을 때만 하고,
 *   다르면 디스크 본문을 돌려줘 renderer가 합치게 한다. 덮어쓰기는 백업 뒤에만 한다.
 * - 원본의 BOM·CRLF는 그대로 되살린다. 임시 파일에 쓴 뒤 바꿔치기한다(쓰다 끊겨 반쪽 파일이 남지 않게).
 */
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic';
import {
  FORBIDDEN_NAME_CHARS,
  MAX_NAME_CHARS,
  WORKLOG_NAME_RE,
  type WorklogConfig,
  type WorklogCreateRequest,
  type WorklogCreateResult,
  type WorklogEntry,
  type WorklogFileRef,
  type WorklogFileText,
  type WorklogFolder,
  type WorklogReadResult,
  type WorklogRenameResult,
  type WorklogSaveRequest,
  type WorklogSaveResult,
  type WorklogStatResult,
} from './worklog-types';
import { decodeWorklog, encodeWorklog, type DiskText } from './worklog-codec';
import { plannerDir, writeAppInfo } from './planner-store';

const DEFAULT_ROOT = 'C:\\worklog';
const BACKUP_KEEP = 30;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WEEKLY_DIR_NAME = '주간보고서';
const IO_PARALLEL = 12;

/** 한 번에 n개씩 순서를 지켜 처리 — 파일이 수천 개여도 하나씩 기다리지 않고, 한꺼번에 열지도 않는다 */
async function mapLimit<T, R>(list: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    }),
  );
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configFile(): string {
  return path.join(app.getPath('userData'), 'worklog.json');
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 저장된 작업일지 폴더 — 처음이면 기본 폴더가 있을 때 그것을 쓴다 */
async function getRoot(): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(configFile(), 'utf8')) as { root?: unknown };
    if (typeof raw.root === 'string') return raw.root;
  } catch {
    // 설정 없음 — 기본값
  }
  return (await isDir(DEFAULT_ROOT)) ? DEFAULT_ROOT : '';
}

async function setRoot(root: string): Promise<void> {
  await fs.mkdir(path.dirname(configFile()), { recursive: true });
  await writeFileAtomic(configFile(), JSON.stringify({ root }, null, 1));
}

function datedNames(names: string[]): string[] {
  return names.filter((n) => WORKLOG_NAME_RE.test(n));
}

/** 날짜 파일이 있는 폴더 — 작업일지 폴더 자체와 바로 아래 하위 폴더, 파일이 많은 순 */
async function discoverFolders(root: string): Promise<WorklogFolder[]> {
  const out: WorklogFolder[] = [];
  const top = await fs.readdir(root, { withFileTypes: true });
  const own = datedNames(top.filter((e) => e.isFile()).map((e) => e.name)).length;
  if (own > 0) out.push({ name: '', count: own });
  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const names = (await fs.readdir(path.join(root, e.name), { withFileTypes: true }))
        .filter((x) => x.isFile())
        .map((x) => x.name);
      const n = datedNames(names).length;
      if (n > 0) out.push({ name: e.name, count: n });
    } catch {
      // 읽을 수 없는 하위 폴더는 건너뛴다
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

async function readConfig(): Promise<WorklogConfig> {
  const root = await getRoot();
  if (!root) return { root: '', folders: [] };
  if (!(await isDir(root))) return { root, folders: [], error: `작업일지 폴더가 없습니다: ${root}` };
  // 명령줄·MCP 도구는 앱 데이터 폴더의 설정을 볼 수 없다 — 작업일지 폴더를 플래너 저장 폴더에 적어 둔다
  void writeAppInfo(plannerDir(), { worklogRoot: root });
  try {
    return { root, folders: await discoverFolders(root) };
  } catch (err) {
    return { root, folders: [], error: errMsg(err) };
  }
}

function checkFolderName(folder: unknown): string {
  const f = typeof folder === 'string' ? folder : '';
  if (f === '.' || f === '..' || /[\\/]/.test(f)) throw new Error('허용되지 않는 폴더입니다.');
  return f;
}

/** renderer가 보낸 폴더·파일명을 작업일지 폴더 안의 실제 경로로 — 밖으로 나가는 경로는 거부 */
async function resolveFile(ref: WorklogFileRef): Promise<{ root: string; dir: string; file: string; date: string }> {
  const root = await getRoot();
  if (!root) throw new Error('작업일지 폴더를 먼저 고르세요.');
  const folder = checkFolderName(ref?.folder);
  const name = typeof ref?.name === 'string' ? ref.name : '';
  const m = WORKLOG_NAME_RE.exec(name);
  if (!m || /[\\/]/.test(name)) throw new Error('작업일지 파일명([YYYY-MM-DD] 제목.txt)이 아닙니다.');
  const dir = path.join(root, folder);
  const file = path.join(dir, name);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('작업일지 폴더 밖의 파일입니다.');
  return { root, dir, file, date: m[1] };
}

async function readDisk(file: string): Promise<DiskText> {
  const st = await fs.stat(file);
  if (st.size > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다(2MB 초과).');
  return decodeWorklog(await fs.readFile(file));
}

/** 임시 파일에 쓴 뒤 바꿔치기 — 바꿔치기가 막히면(다른 프로그램이 잡고 있음) 바로 쓴다 */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
  // 임시 파일은 어느 경로로 끝나든 지운다 — 전에는 바로 쓰기까지 실패하면 작업일지 폴더에 .tmp가 남았다
  await writeFileAtomic(file, data, { prefix: '.tb-worklog-', fallbackDirect: true });
}

function backupDir(): string {
  return path.join(app.getPath('userData'), 'worklog-backup');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 덮어쓰기 전 백업 — 같은 파일은 10분에 한 번(강제 덮어쓰기는 항상). 파일별 최근 30개만 남긴다.
 * 백업 이름에는 원본 파일명을 넣지 않는다(긴 이름이 경로 길이를 넘긴다). 대신 폴더·파일명의 해시 8자를 넣어
 * 파일마다 따로 센다 — 전에는 날짜+폴더만 봐서 같은 날 파일이 둘이면(또는 폴더 `A`와 `A_B`) 한쪽을 백업한 뒤
 * 10분 안에 저장한 다른 파일은 백업 없이 덮였고, 30개 정리도 남의 백업을 지웠다.
 */
async function backup(date: string, folder: string, name: string, buf: Buffer, always: boolean): Promise<string | undefined> {
  const dir = backupDir();
  await fs.mkdir(dir, { recursive: true });
  const id = createHash('sha1').update(`${folder}/${name}`).digest('hex').slice(0, 8);
  const key = `${date}_${folder.replace(/[^\p{L}\p{N}+ _-]/gu, '').trim() || 'root'}_${id}_`;
  const mine = (await fs.readdir(dir)).filter((n) => n.startsWith(key)).sort();
  const last = mine[mine.length - 1];
  if (!always && last) {
    const st = await fs.stat(path.join(dir, last));
    if (Date.now() - st.mtimeMs < BACKUP_INTERVAL_MS) return undefined;
  }
  const target = path.join(dir, `${key}${stamp()}.txt`);
  await fs.writeFile(target, buf);
  const all = [...mine, path.basename(target)].sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    await fs.rm(path.join(dir, old), { force: true });
  }
  return target;
}

async function listEntries(): Promise<WorklogEntry[]> {
  const cfg = await readConfig();
  if (!cfg.root) return [];
  const found: Array<{ folder: string; name: string; date: string; title: string; file: string }> = [];
  for (const f of cfg.folders) {
    const dir = path.join(cfg.root, f.name);
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const m = WORKLOG_NAME_RE.exec(e.name);
      if (m) found.push({ folder: f.name, name: e.name, date: m[1], title: m[2].trim(), file: path.join(dir, e.name) });
    }
  }
  const stats = await mapLimit(found, IO_PARALLEL, async (x): Promise<WorklogEntry | null> => {
    try {
      const st = await fs.stat(x.file);
      return { folder: x.folder, name: x.name, date: x.date, title: x.title, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null; // 목록을 읽는 사이 사라진 파일
    }
  });
  const out = stats.filter((e): e is WorklogEntry => e !== null);
  const order = new Map(cfg.folders.map((f, i) => [f.name, i]));
  return out.sort((a, b) => b.date.localeCompare(a.date) || (order.get(a.folder) ?? 0) - (order.get(b.folder) ?? 0));
}

function cleanTitle(title: unknown): string {
  const t = (typeof title === 'string' ? title : '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('제목을 입력하세요.');
  if (new RegExp(FORBIDDEN_NAME_CHARS.source).test(t)) throw new Error('제목에 \\ / : * ? " < > | 는 쓸 수 없습니다.');
  return t;
}

export function registerWorklogIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('worklog:config', () => readConfig());

  ipcMain.handle('worklog:pick-root', async (): Promise<WorklogConfig> => {
    const win = getWindow();
    const current = await getRoot();
    const opts: Electron.OpenDialogOptions = {
      title: '작업일지 폴더 고르기 — [YYYY-MM-DD] 제목.txt 파일이 든 폴더(또는 그 위 폴더)',
      properties: ['openDirectory'],
      defaultPath: current || undefined,
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return readConfig();
    await setRoot(r.filePaths[0]);
    return readConfig();
  });

  ipcMain.handle('worklog:list', async () => {
    try {
      return { ok: true as const, files: await listEntries() };
    } catch (err) {
      return { ok: false as const, error: errMsg(err) };
    }
  });

  ipcMain.handle('worklog:read', async (_evt, ref: WorklogFileRef): Promise<WorklogReadResult> => {
    try {
      const { file } = await resolveFile(ref);
      const d = await readDisk(file);
      const st = await fs.stat(file);
      return { ok: true, text: d.text, mtimeMs: st.mtimeMs, size: st.size, bom: d.bom, crlf: d.crlf, legacyEncoding: d.legacyEncoding };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('worklog:stat', async (_evt, ref: WorklogFileRef): Promise<WorklogStatResult> => {
    try {
      const { file } = await resolveFile(ref);
      const st = await fs.stat(file);
      return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('worklog:save', async (_evt, req: WorklogSaveRequest): Promise<WorklogSaveResult> => {
    try {
      if (typeof req?.text !== 'string' || typeof req.base !== 'string') {
        return { ok: false, code: 'error', error: '저장할 본문이 없습니다.' };
      }
      const { file, date } = await resolveFile(req);
      let cur: DiskText;
      try {
        cur = await readDisk(file);
      } catch {
        return { ok: false, code: 'error', error: '파일이 없습니다 — 이름이 바뀌었거나 지워졌습니다. 목록을 새로 고치세요.' };
      }
      if (!req.force && cur.text !== req.base) {
        const st = await fs.stat(file);
        return { ok: false, code: 'changed', disk: cur.text, mtimeMs: st.mtimeMs, size: st.size };
      }
      if (cur.text === req.text && cur.bom === !!req.bom && cur.crlf === !!req.crlf) {
        const st = await fs.stat(file);
        return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
      }
      const bak = await backup(date, checkFolderName(req.folder), req.name, cur.buf, !!req.force);
      await writeAtomic(file, encodeWorklog(req.text, !!req.bom, !!req.crlf));
      const st = await fs.stat(file);
      return { ok: true, mtimeMs: st.mtimeMs, size: st.size, backup: bak };
    } catch (err) {
      return { ok: false, code: 'error', error: errMsg(err) };
    }
  });

  ipcMain.handle('worklog:create', async (_evt, req: WorklogCreateRequest): Promise<WorklogCreateResult> => {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req?.date))) return { ok: false, code: 'error', error: '날짜 형식이 아닙니다.' };
      const title = cleanTitle(req.title);
      const name = `[${req.date}] ${title}.txt`;
      if (name.length > MAX_NAME_CHARS) return { ok: false, code: 'error', error: `파일명이 너무 깁니다(${MAX_NAME_CHARS}자 이내).` };
      const { dir, file } = await resolveFile({ folder: req.folder, name });
      if (!(await isDir(dir))) return { ok: false, code: 'error', error: `폴더가 없습니다: ${req.folder}` };
      // 같은 날짜 파일이 이미 있으면 새로 만들지 않는다 — 같은 날 파일이 둘이 되면 루틴이 그날을 건너뛴다
      const same = (await fs.readdir(dir)).find((n) => n.startsWith(`[${req.date}]`) && WORKLOG_NAME_RE.test(n));
      if (same) return { ok: false, code: 'exists', name: same };
      await fs.writeFile(file, encodeWorklog(String(req.text ?? ''), false, false), { flag: 'wx' });
      const st = await fs.stat(file);
      return { ok: true, name, mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      return { ok: false, code: 'error', error: errMsg(err) };
    }
  });

  ipcMain.handle('worklog:rename', async (_evt, req: WorklogFileRef & { title: string }): Promise<WorklogRenameResult> => {
    try {
      const { dir, file, date } = await resolveFile(req);
      const title = cleanTitle(req.title);
      const name = `[${date}] ${title}.txt`;
      if (name === req.name) return { ok: true, name };
      if (name.length > MAX_NAME_CHARS) return { ok: false, error: `파일명이 너무 깁니다(${MAX_NAME_CHARS}자 이내).` };
      const clash = (await fs.readdir(dir)).find((n) => n.toLowerCase() === name.toLowerCase() && n !== req.name);
      if (clash) return { ok: false, error: '같은 이름의 파일이 이미 있습니다.' };
      await fs.rename(file, path.join(dir, name));
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  /** 검색·자동완성·주간보고 가져오기용 — 범위(포함) 안의 파일 본문 전부 */
  ipcMain.handle('worklog:read-all', async (_evt, range?: { from?: string; to?: string }) => {
    try {
      const cfg = await readConfig();
      const wanted = (await listEntries()).filter((e) => !(range?.from && e.date < range.from) && !(range?.to && e.date > range.to));
      const read = await mapLimit(wanted, IO_PARALLEL, async (e): Promise<WorklogFileText | null> => {
        try {
          const d = await readDisk(path.join(cfg.root, e.folder, e.name));
          return { ...e, text: d.text };
        } catch {
          return null; // 읽지 못한 파일은 건너뛴다
        }
      });
      return { ok: true as const, files: read.filter((f): f is WorklogFileText => f !== null) };
    } catch (err) {
      return { ok: false as const, error: errMsg(err) };
    }
  });

  /** 지난 주간보고 .md (최근 20개) — 담당자별 고객사|작업구분·지원장소를 배우는 데 쓴다 */
  ipcMain.handle('worklog:weekly-history', async (_evt, dirs?: unknown) => {
    const root = await getRoot();
    const candidates = new Set<string>();
    if (root) candidates.add(path.join(root, WEEKLY_DIR_NAME));
    if (Array.isArray(dirs)) for (const d of dirs) if (typeof d === 'string' && path.isAbsolute(d)) candidates.add(path.normalize(d));
    const found: Array<{ file: string; mtimeMs: number }> = [];
    for (const dir of candidates) {
      try {
        for (const n of await fs.readdir(dir)) {
          if (!n.toLowerCase().endsWith('.md')) continue;
          const file = path.join(dir, n);
          const st = await fs.stat(file);
          if (st.isFile() && st.size < 512 * 1024) found.push({ file, mtimeMs: st.mtimeMs });
        }
      } catch {
        // 없는 폴더
      }
    }
    const uniq = [...new Map(found.map((f) => [f.file.toLowerCase(), f])).values()];
    const latest = uniq.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20);
    const out: Array<{ name: string; text: string }> = [];
    for (const f of latest) {
      try {
        out.push({ name: path.basename(f.file), text: await fs.readFile(f.file, 'utf8') });
      } catch {
        // 읽지 못한 파일
      }
    }
    return out;
  });

  ipcMain.handle('worklog:reveal', async (_evt, ref?: WorklogFileRef) => {
    try {
      if (ref?.name) {
        shell.showItemInFolder((await resolveFile(ref)).file);
        return { ok: true };
      }
      const root = await getRoot();
      if (!root) return { ok: false, error: '작업일지 폴더를 먼저 고르세요.' };
      const e = await shell.openPath(root);
      return e ? { ok: false, error: e } : { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
