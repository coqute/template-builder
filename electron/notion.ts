/**
 * Notion IPC (main 전용) — 키 보관, DB 찾기, 최근에 바뀐 페이지 읽기(5분 기억). 호출과 응답 해석은 notion-core.ts.
 * 설계: docs/home-schedule-design.md §19.10
 *
 * - 읽기만 한다. Notion에 쓰는 통로는 없다.
 * - 키는 OS 암호화(safeStorage)로 앱 데이터 폴더의 `notion-key.bin`에 두고 renderer로 돌려주지 않는다(상태만).
 *   어떤 DB를 볼지는 플래너 설정(planner.json)에 있다 — 코드에는 DB 주소·ID를 적지 않는다.
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { decryptText, encryptText, encryptionAvailable } from './secure-store';
import { listSources, readRecent, resolveSource } from './notion-core';
import type { NotionFailure, NotionPage, NotionRecentRequest, NotionRecentResult, NotionSourcesResult, NotionStatus } from '../src/planner/types';

/** Notion 연결(통합)의 키 — 새 키는 `ntn_`, 예전 키는 `secret_`로 시작한다 */
const KEY_RE = /^(?:ntn_|secret_)[A-Za-z0-9_-]{20,}$/;
const MEMO_MS = 5 * 60 * 1000;
const MEMO_MAX = 10;
const NO_KEY: NotionFailure = { ok: false, code: 'no-key', message: 'Notion 키가 없습니다 — 도움말·설정(F1)의 Notion 칸에서 저장하세요.' };

const memo = new Map<string, { pages: NotionPage[]; failed: string[]; readAt: number }>();

function keyFile(): string {
  return path.join(app.getPath('userData'), 'notion-key.bin');
}

async function readStoredKey(): Promise<string | null> {
  if (!(await encryptionAvailable())) return null;
  try {
    const { text, stale } = await decryptText(await fs.readFile(keyFile()));
    const key = text.trim();
    // OS 키가 바뀌었으면 새 키로 다시 써 둔다 (못 써도 이번 호출에는 지장 없음)
    if (key && stale) void encryptText(key).then((b) => fs.writeFile(keyFile(), b, { mode: 0o600 })).catch(() => undefined);
    return key || null;
  } catch {
    return null;
  }
}

async function resolveKey(): Promise<string | null> {
  return (await readStoredKey()) ?? (process.env.NOTION_TOKEN?.trim() || null);
}

const unknown = (err: unknown): NotionFailure => ({ ok: false, code: 'unknown', message: err instanceof Error ? err.message : '알 수 없는 오류' });

export function registerNotionIpc(): void {
  ipcMain.handle('notion:status', async (): Promise<NotionStatus> => {
    const stored = (await readStoredKey()) !== null;
    return { connected: stored || !!process.env.NOTION_TOKEN?.trim(), stored, encryption: await encryptionAvailable() };
  });

  ipcMain.handle('notion:key-set', async (_evt, raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY_RE.test(key)) return { ok: false, error: 'ntn_ 또는 secret_ 으로 시작하는 Notion 연결 키가 아닙니다.' };
    if (!(await encryptionAvailable())) return { ok: false, error: '이 PC에서는 키를 암호화해 저장할 수 없습니다.' };
    try {
      await fs.mkdir(path.dirname(keyFile()), { recursive: true });
      await fs.writeFile(keyFile(), await encryptText(key), { mode: 0o600 });
      memo.clear();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('notion:key-clear', async (): Promise<{ ok: boolean }> => {
    await fs.rm(keyFile(), { force: true });
    memo.clear();
    return { ok: true };
  });

  /** 이 연결이 볼 수 있는 DB — 연결 확인을 겸한다 */
  ipcMain.handle('notion:sources', async (): Promise<NotionSourcesResult> => {
    try {
      const token = await resolveKey();
      return token ? await listSources({ token }) : NO_KEY;
    } catch (err) {
      return unknown(err);
    }
  });

  /** 주소로 DB 하나 찾기 — 검색에 나오지 않은 DB를 더할 때 */
  ipcMain.handle('notion:resolve', async (_evt, input: unknown): Promise<NotionSourcesResult> => {
    try {
      const token = await resolveKey();
      return token ? await resolveSource({ token }, input) : NO_KEY;
    } catch (err) {
      return unknown(err);
    }
  });

  ipcMain.handle('notion:recent', async (_evt, req: NotionRecentRequest): Promise<NotionRecentResult> => {
    try {
      const sources = Array.isArray(req?.sources) ? [...new Set(req.sources.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))].sort() : [];
      const since = String(req?.since ?? '');
      const want: NotionRecentRequest = { sources, since, loose: req?.loose === true };
      const key = `${since}|${want.loose ? 1 : 0}|${sources.join(',')}`;
      const hit = memo.get(key);
      if (!req?.force && hit && Date.now() - hit.readAt < MEMO_MS) return { ok: true, pages: hit.pages, failed: hit.failed, readAt: hit.readAt, fromCache: true };
      const token = await resolveKey();
      if (!token) return NO_KEY;
      const got = await readRecent({ token }, want);
      if (!got.ok) return got;
      const readAt = Date.now();
      if (memo.size >= MEMO_MAX) memo.clear();
      memo.set(key, { pages: got.pages, failed: got.failed, readAt });
      return { ok: true, pages: got.pages, failed: got.failed, readAt, fromCache: false };
    } catch (err) {
      return unknown(err);
    }
  });
}
