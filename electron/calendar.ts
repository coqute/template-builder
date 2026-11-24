/**
 * Google 달력 IPC (main 전용) — 연결 상태·달력 목록·일정 읽기(5분 기억 + 마지막으로 읽은 결과 보관)·쓰기.
 * 호출과 권한 범위 판정은 calendar-core.ts. 설계: docs/home-schedule-design.md §5.4·§8
 *
 * - 토큰을 어디서 받는지는 `access()` 하나만 안다 — 지금은 Gmail 초안과 같은 자격증명이고, 그 파일은 읽기만 한다.
 *   범위 검사는 여기서 한다(gmail/credentials.ts에는 달력 함수를 더하지 않는다).
 * - 마지막으로 읽은 일정은 앱 데이터 폴더의 `calendar-cache.json`에 둔다. 일정의 설명(본문)은 받지도 저장하지도 않는다.
 * - baseline = 사용자가 마지막으로 [확인]한 때의 일정. renderer가 지금 일정과 견줘 바뀐 것을 찾는다.
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic';
import { CredError, loadGmailCreds } from './gmail/credentials';
import { getAccessToken, OAuthError } from './gmail/oauth';
import {
  calendarScopes,
  deleteEvent,
  insertEvent,
  listCalendars,
  listEvents,
  patchEvent,
  type CalendarDeps,
  type CalendarFailure,
  type CalendarScopes,
} from './calendar-core';
import type {
  CalendarDeleteResult,
  CalendarEventsRequest,
  CalendarEventsResult,
  CalendarInfo,
  CalendarListResult,
  CalendarStatus,
  CalendarWriteResult,
  EventInput,
  EventRef,
  RawEvent,
} from '../src/planner/types';

const MEMO_MS = 5 * 60 * 1000;
const MEMO_MAX = 20;
const NO_READ = '토큰에 Google 달력 일정을 읽는 권한 범위가 없습니다.';
const NO_LIST = '토큰에 Google 달력 목록을 읽는 권한 범위가 없습니다.';
const NO_WRITE = '토큰에 Google 달력 일정을 만들고 고치는 권한 범위가 없습니다.';

/** calendar-cache.json — 마지막으로 읽은 일정과, 사용자가 마지막으로 확인한 때의 일정 */
interface CacheFile {
  /** 읽은 조건 `from|to|달력 목록` */
  key: string;
  readAt: number;
  events: RawEvent[];
  baseline: RawEvent[] | null;
  baselineAt: number | null;
}

/** 5분 기억 — 탭을 오갈 때마다 다시 부르지 않게 */
const memo = new Map<string, { events: RawEvent[]; readAt: number }>();
let listMemo: { calendars: CalendarInfo[]; readAt: number } | null = null;

/** 토큰을 어디서 받는가 — 이 함수만 안다 */
async function access(): Promise<{ scopes: CalendarScopes; deps: CalendarDeps }> {
  const creds = await loadGmailCreds();
  return { scopes: calendarScopes(creds.scope), deps: { getToken: (force) => getAccessToken(creds, force) } };
}

/** 예외 분류 — gmail:create-draft 핸들러와 같게 */
function classify(err: unknown): CalendarFailure {
  if (err instanceof CredError) return { ok: false, code: 'credentials-missing', message: err.message };
  if (err instanceof OAuthError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : '알 수 없는 오류' };
}

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'calendar-cache.json');
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as Partial<CacheFile> | null;
    if (!raw || !Array.isArray(raw.events)) return null;
    return {
      key: typeof raw.key === 'string' ? raw.key : '',
      readAt: typeof raw.readAt === 'number' ? raw.readAt : 0,
      events: raw.events,
      baseline: Array.isArray(raw.baseline) ? raw.baseline : null,
      baselineAt: typeof raw.baselineAt === 'number' ? raw.baselineAt : null,
    };
  } catch {
    return null; // 없거나 깨진 캐시 — 다시 읽으면 새로 쓴다
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
  await writeFileAtomic(cacheFile(), JSON.stringify(cache, null, 1), { prefix: '.tb-calendar-' });
}

// 캐시 파일을 읽고 고쳐 쓰는 일은 줄을 세운다 — 일정 읽기와 [확인]이 겹쳐도 한쪽이 지워지지 않게
let cacheChain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = cacheChain.then(job);
  cacheChain = run.catch(() => undefined);
  return run;
}

/** 실패 결과에 마지막으로 읽은 일정을 붙인다 — 화면은 그것을 "몇 시에 읽은 내용"으로 보여 준다 */
async function withCached(fail: CalendarFailure): Promise<CalendarEventsResult> {
  const cache = await readCache();
  return cache ? { ...fail, cached: { events: cache.events, readAt: cache.readAt } } : fail;
}

/** 달력 목록(쓸 수 있는지·공휴일 달력인지 판정용) — 목록 범위가 없거나 읽지 못하면 undefined */
async function knownCalendars(scopes: CalendarScopes, deps: CalendarDeps): Promise<CalendarInfo[] | undefined> {
  if (!scopes.canList) return undefined;
  if (listMemo && Date.now() - listMemo.readAt < MEMO_MS) return listMemo.calendars;
  const got = await listCalendars(deps);
  if (!got.ok) return undefined;
  listMemo = { calendars: got.calendars, readAt: Date.now() };
  return got.calendars;
}

/** 쓰기 공통 — 쓰기 범위 확인, 성공하면 5분 기억을 비운다(다음 읽기가 바뀐 일정을 받게) */
async function writing<T extends { ok: boolean }>(run: (deps: CalendarDeps) => Promise<T | CalendarFailure>): Promise<T | CalendarFailure> {
  try {
    const { scopes, deps } = await access();
    if (!scopes.canWrite) return { ok: false, code: 'scope-missing', message: NO_WRITE };
    const result = await run(deps);
    if (result.ok) memo.clear();
    return result;
  } catch (err) {
    return classify(err);
  }
}

export function registerCalendarIpc(): void {
  ipcMain.handle('calendar:status', async (): Promise<CalendarStatus> => {
    try {
      const { scopes } = await access();
      if (scopes.canRead) return { connected: true, ...scopes };
      return { connected: false, ...scopes, reason: 'scope-missing', message: NO_READ };
    } catch (err) {
      const message = err instanceof Error ? err.message : '알 수 없는 오류';
      return { connected: false, canRead: false, canList: false, canWrite: false, reason: 'credentials-missing', message };
    }
  });

  ipcMain.handle('calendar:list', async (): Promise<CalendarListResult> => {
    try {
      const { scopes, deps } = await access();
      if (!scopes.canList) return { ok: false, code: 'scope-missing', message: NO_LIST };
      const got = await listCalendars(deps);
      if (got.ok) listMemo = { calendars: got.calendars, readAt: Date.now() };
      return got;
    } catch (err) {
      return classify(err);
    }
  });

  ipcMain.handle('calendar:events', async (_evt, req: CalendarEventsRequest): Promise<CalendarEventsResult> => {
    try {
      const calendars = Array.isArray(req?.calendars) ? req.calendars.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
      const want: CalendarEventsRequest = { from: String(req?.from ?? ''), to: String(req?.to ?? ''), calendars: calendars.length ? calendars : ['primary'] };
      const key = `${want.from}|${want.to}|${[...new Set(want.calendars)].sort().join(',')}`;

      const transient = req?.transient === true;
      const hit = memo.get(key);
      if (!req?.force && hit && Date.now() - hit.readAt < MEMO_MS) {
        return { ok: true, events: hit.events, readAt: hit.readAt, fromCache: true, baseline: transient ? null : ((await readCache())?.baseline ?? null) };
      }

      const { scopes, deps } = await access();
      if (!scopes.canRead) return await withCached({ ok: false, code: 'scope-missing', message: NO_READ });
      const got = await listEvents(deps, want, await knownCalendars(scopes, deps));
      if (!got.ok) return await withCached(got);

      const readAt = Date.now();
      if (memo.size >= MEMO_MAX) memo.clear();
      memo.set(key, { events: got.events, readAt });
      // 한 번 쓰고 버릴 읽기(다른 화면이 다른 기간을 읽음)는 홈의 "마지막으로 읽은 일정"과 견줄 기준을 덮지 않는다
      if (transient) return { ok: true, events: got.events, readAt, fromCache: false, baseline: null };
      // 처음 읽었으면 지금 일정이 견줄 기준이 된다(응답의 baseline은 null) — 그 뒤로는 [확인]할 때만 기준이 바뀐다
      const baseline = await serial(async () => {
        const prev = await readCache();
        const kept = prev?.baseline ?? null;
        await writeCache({ key, readAt, events: got.events, baseline: kept ?? got.events, baselineAt: kept ? (prev?.baselineAt ?? readAt) : readAt }).catch(
          () => undefined, // 캐시를 못 써도 읽은 일정은 돌려준다
        );
        return kept;
      });
      return { ok: true, events: got.events, readAt, fromCache: false, baseline };
    } catch (err) {
      return withCached(classify(err));
    }
  });

  /** [확인] — 견줄 기준을 마지막으로 읽은 일정으로 바꾼다 */
  ipcMain.handle('calendar:ack', async (): Promise<{ ok: boolean }> => {
    try {
      return await serial(async () => {
        const cache = await readCache();
        if (!cache) return { ok: false };
        await writeCache({ ...cache, baseline: cache.events, baselineAt: Date.now() });
        return { ok: true };
      });
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('calendar:insert', (_evt, input: EventInput): Promise<CalendarWriteResult> => writing((deps) => insertEvent(deps, input)));

  ipcMain.handle(
    'calendar:patch',
    (_evt, req: { ref: EventRef; patch: Partial<EventInput> }): Promise<CalendarWriteResult> => writing((deps) => patchEvent(deps, req?.ref, req?.patch)),
  );

  ipcMain.handle('calendar:delete', (_evt, ref: EventRef): Promise<CalendarDeleteResult> => writing((deps) => deleteEvent(deps, ref)));
}
