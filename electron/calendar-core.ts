/**
 * Google 달력 호출 — 권한 범위 판정·달력 목록·일정 읽기·쓰기.
 * main 전용이지만 Electron에 기대지 않아 테스트에서 바로 쓴다. 설계: docs/home-schedule-design.md §5.4
 *
 * - 토큰을 어디서 받는지는 모른다(deps.getToken). 401이면 강제 갱신 뒤 1회 다시 부른다(gmail/upsert.ts와 같게).
 *   getToken이 던진 예외는 삼키지 않고 그대로 올린다 — 분류는 부르는 쪽(calendar.ts)이 한다.
 * - 일정의 설명(본문)은 받지 않는다 — 응답에서 필요한 칸만 달라고 한다(fields).
 * - 달력 ID는 코드에 적지 않는다. 공휴일 달력은 ID에 든 표식(#holiday)으로만 가린다.
 * - 시각은 이 컴퓨터의 시간대로 해석한다.
 */
import type {
  CalendarDeleteResult,
  CalendarErrorCode,
  CalendarEventsRequest,
  CalendarInfo,
  CalendarListResult,
  CalendarWriteResult,
  EventInput,
  EventRef,
  RawEvent,
} from '../src/planner/types';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const HOLIDAY_MARK = '#holiday';
const PAGE_SIZE = 250;
const MAX_PAGES = 4;

/**
 * 일정 하나에서 받는 칸 — 설명(description)·참석자 주소는 여기에 없으므로 응답에 오지 않는다.
 * organizer/self·guestsCanModify = 내가 만든 일정인가(남이 만든 일정은 고치지 못한다), recurringEventId = 반복 일정의 한 회차인가.
 */
const EVENT_FIELDS =
  'id,summary,location,start,end,status,eventType,htmlLink,hangoutLink,conferenceData/entryPoints/entryPointType,attendees(self,responseStatus),organizer/self,guestsCanModify,recurringEventId,updated';
const LIST_FIELDS = `nextPageToken,items(${EVENT_FIELDS})`;

export interface CalendarDeps {
  /** forceRefresh=true면 강제 갱신 (401 재시도용) */
  getToken(forceRefresh?: boolean): Promise<string>;
  fetchFn?: typeof fetch;
}

export interface CalendarScopes {
  canRead: boolean;
  canList: boolean;
  canWrite: boolean;
}

export type CalendarFailure = { ok: false; code: CalendarErrorCode; message: string };
/** skipped = 읽지 못해 건너뛴 달력 ID (404·403) */
export type CalendarReadResult = { ok: true; events: RawEvent[]; skipped: string[] } | CalendarFailure;

// ── 권한 범위 ───────────────────────────────────────────────────────────────

const READ_SCOPES = new Set([
  'calendar',
  'calendar.readonly',
  'calendar.events',
  'calendar.events.readonly',
  'calendar.events.owned',
  'calendar.events.owned.readonly',
]);
const LIST_SCOPES = new Set(['calendar', 'calendar.readonly', 'calendar.calendarlist', 'calendar.calendarlist.readonly']);
const WRITE_SCOPES = new Set(['calendar', 'calendar.events', 'calendar.events.owned']);

/**
 * 토큰의 범위 문자열(공백 구분)로 달력에서 할 수 있는 일을 가린다.
 * 범위 이름을 통째로 견준다 — 글자 포함으로 보면 `calendar.events.readonly`가 쓰기(`calendar.events`)로 읽힌다.
 * 범위 정보가 없으면 셋 다 된다고 보고 시도한다(REST가 권한 오류로 알려 준다).
 */
export function calendarScopes(scope?: string): CalendarScopes {
  if (typeof scope !== 'string' || !scope.trim()) return { canRead: true, canList: true, canWrite: true };
  const names = scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => (s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s));
  const any = (set: Set<string>) => names.some((n) => set.has(n));
  return { canRead: any(READ_SCOPES), canList: any(LIST_SCOPES), canWrite: any(WRITE_SCOPES) };
}

// ── 호출 ────────────────────────────────────────────────────────────────────

class FetchNetworkError extends Error {}

type Send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<Response>;

/** 한 작업 동안 토큰을 쥐고 부른다 — 401이면 강제 갱신 뒤 1회 재시도, 갱신한 토큰은 뒤 호출에도 쓴다 */
function session(deps: CalendarDeps): Send {
  const fetchFn = deps.fetchFn ?? fetch;
  let token: string | null = null;
  return async (method, url, body) => {
    // fetch 자체 실패(DNS·오프라인)는 'network'로 가른다. getToken 예외는 그대로 올린다.
    const call = async (t: string) => {
      try {
        return await fetchFn(url, {
          method,
          headers: { Authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        throw new FetchNetworkError(err instanceof Error ? err.message : String(err));
      }
    };
    token ??= await deps.getToken();
    let res = await call(token);
    if (res.status === 401) {
      token = await deps.getToken(true);
      res = await call(token);
    }
    return res;
  };
}

const SCOPE_LACK_RE = /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

/** 실패 응답 분류 — 재시도 뒤에도 401이면 refresh-failed, 403 + 범위 부족이면 scope-missing, 그 밖은 api-error */
async function failure(res: Response): Promise<CalendarFailure> {
  const detail = await res.text().catch(() => '');
  if (res.status === 401) {
    return { ok: false, code: 'refresh-failed', message: 'Google 달력 인증이 거부되었습니다(401) — 토큰을 다시 받아야 합니다.' };
  }
  if (res.status === 403 && SCOPE_LACK_RE.test(detail)) {
    return { ok: false, code: 'scope-missing', message: '토큰에 이 일에 필요한 Google 달력 권한 범위가 없습니다.' };
  }
  return { ok: false, code: 'api-error', message: `Google 달력 API ${res.status}: ${detail.slice(0, 200)}` };
}

function invalid(message: string): CalendarFailure {
  return { ok: false, code: 'unknown', message };
}

/** fetch 실패를 network 결과로 — 그 밖의 예외는 그대로 올린다 */
async function guard<T>(run: () => Promise<T | CalendarFailure>): Promise<T | CalendarFailure> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FetchNetworkError) return { ok: false, code: 'network', message: `네트워크 오류: ${err.message}` };
    throw err;
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const json = (await res.json().catch(() => null)) as unknown;
  return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
}

// ── 날짜·시각 ───────────────────────────────────────────────────────────────

const p2 = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` → 이 컴퓨터 시간대의 그날 자정(+days). 실제 날짜가 아니면 null (2026-02-30) */
function localDay(s: unknown, plusDays = 0): Date | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(y, mo - 1, d);
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null;
  return plusDays ? new Date(y, mo - 1, d + plusDays) : day;
}

/** `YYYY-MM-DDTHH:MM` → 이 컴퓨터 시간대의 그 시각 */
function localMinute(s: unknown): Date | null {
  const m = typeof s === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(s) : null;
  const day = m ? localDay(m[1]) : null;
  if (!m || !day) return null;
  const [h, mi] = [Number(m[2]), Number(m[3])];
  if (h > 23 || mi > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 시간대 오프셋이 붙은 RFC3339 — `2026-11-23T00:00:00+09:00` */
export function localRfc3339(d: Date): string {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  const zone = `${off >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
  return `${isoDate(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${zone}`;
}

// ── 달력 목록 ───────────────────────────────────────────────────────────────

interface GCalendar {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
  deleted?: boolean;
}

/** 구독 중인 달력 목록 */
export async function listCalendars(deps: CalendarDeps): Promise<CalendarListResult> {
  return guard(async (): Promise<CalendarListResult> => {
    const send = session(deps);
    const calendars: CalendarInfo[] = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await send('GET', `${API}/users/me/calendarList${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (!res.ok) return failure(res);
      const json = await readJson(res);
      for (const c of (Array.isArray(json.items) ? json.items : []) as GCalendar[]) {
        if (!c || typeof c.id !== 'string' || !c.id || c.deleted) continue;
        calendars.push({
          id: c.id,
          summary: c.summaryOverride || c.summary || '',
          primary: c.primary === true,
          canWrite: c.accessRole === 'owner' || c.accessRole === 'writer',
          mine: c.primary === true || c.accessRole === 'owner',
          holiday: c.id.includes(HOLIDAY_MARK),
        });
      }
      pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
      if (!pageToken) break;
    }
    return { ok: true, calendars };
  });
}

// ── 일정 읽기 ───────────────────────────────────────────────────────────────

interface GEventTime {
  date?: string;
  dateTime?: string;
}
interface GEvent {
  id?: string;
  summary?: string;
  location?: string;
  start?: GEventTime;
  end?: GEventTime;
  status?: string;
  eventType?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: unknown[] };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  organizer?: { self?: boolean };
  guestsCanModify?: boolean;
  recurringEventId?: string;
  updated?: string;
}

/** 응답의 일정 하나를 RawEvent로 — 취소된 일정과 시작 시각이 없는 것은 버린다(null) */
interface CalendarFlags {
  canWrite: boolean;
  holiday: boolean;
  /** 남의 달력인가 (동료 등) */
  other?: boolean;
  /** 달력 이름 — 남의 달력일 때 누구 것인지 보이는 데 쓴다 */
  name?: string;
}

function toRawEvent(calendarId: string, e: GEvent | null, cal: CalendarFlags): RawEvent | null {
  if (!e || typeof e.id !== 'string' || !e.id || e.status === 'cancelled') return null;
  const allDay = typeof e.start?.date === 'string';
  const start = allDay ? e.start?.date : e.start?.dateTime;
  if (typeof start !== 'string' || !start) return null;
  const end = allDay ? e.end?.date : e.end?.dateTime;
  // 끝이 빠진 일정 — 시각 일정은 시작과 같게, 종일 일정은 하루짜리(끝 = 다음 날)로 본다
  const nextDay = allDay ? localDay(start, 1) : null;
  const noEnd = nextDay ? isoDate(nextDay) : start;
  // 남이 만들어 나를 부른 일정은 내 달력에 있어도 시각·제목을 고칠 수 없다(손님이 고칠 수 있게 해 둔 일정만 예외).
  // 지우면 내 달력에서만 빠지고 만든 사람에게는 불참으로 보이므로, 그런 일정은 고치기·지우기를 내놓지 않는다.
  const mine = !e.organizer || e.organizer.self === true || e.guestsCanModify === true;
  return {
    calendarId,
    id: e.id,
    summary: typeof e.summary === 'string' ? e.summary : '',
    location: typeof e.location === 'string' ? e.location : '',
    allDay,
    start,
    end: typeof end === 'string' && end ? end : noEnd,
    status: typeof e.status === 'string' ? e.status : 'confirmed',
    eventType: typeof e.eventType === 'string' ? e.eventType : 'default',
    htmlLink: typeof e.htmlLink === 'string' ? e.htmlLink : '',
    meet: !!e.hangoutLink || (Array.isArray(e.conferenceData?.entryPoints) && e.conferenceData.entryPoints.length > 0),
    declined: Array.isArray(e.attendees) && e.attendees.some((a) => a?.self === true && a.responseStatus === 'declined'),
    holiday: cal.holiday,
    canWrite: cal.canWrite && mine,
    updated: typeof e.updated === 'string' ? e.updated : '',
    // 반복 일정의 한 회차 — 고치거나 지우면 그 회차만 바뀐다
    ...(typeof e.recurringEventId === 'string' && e.recurringEventId ? { recurring: true } : {}),
    // 남의 달력의 일정 — 화면은 2주 띠에만 옅게 그린다 (설계 §5.5)
    ...(cal.other ? { other: true, ...(cal.name ? { calendarName: cal.name } : {}) } : {}),
  };
}

function startMs(e: RawEvent): number {
  const ms = e.allDay ? (localDay(e.start)?.getTime() ?? NaN) : Date.parse(e.start);
  return Number.isFinite(ms) ? ms : 0;
}

/** 달력 하나의 일정 — 쪽을 넘겨 최대 4쪽(1000건). 실패하면 상태 코드와 분류를 돌려준다 */
async function readCalendar(
  send: Send,
  id: string,
  timeMin: string,
  timeMax: string,
  cal: CalendarFlags,
): Promise<RawEvent[] | { status: number; fail: CalendarFailure }> {
  const out: RawEvent[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: String(PAGE_SIZE),
      fields: LIST_FIELDS,
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await send('GET', `${API}/calendars/${encodeURIComponent(id)}/events?${q}`);
    if (!res.ok) return { status: res.status, fail: await failure(res) };
    const json = await readJson(res);
    for (const e of (Array.isArray(json.items) ? json.items : []) as GEvent[]) {
      const ev = toRawEvent(id, e, cal);
      if (ev) out.push(ev);
    }
    pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
    if (!pageToken) break;
  }
  return out;
}

/**
 * 기간(from~to, 둘 다 포함) 안의 일정을 달력마다 읽어 시작 시각순으로 돌려준다.
 * 달력 하나가 404·403이면 그 달력만 건너뛴다. 본인 달력(primary)이 실패하거나 하나도 읽지 못하면 전체 실패다.
 * `calendars`(달력 목록)가 있으면 거기서 쓸 수 있는지·공휴일 달력인지를 얻고, 없으면 본인 달력만 쓸 수 있는 것으로 본다.
 */
export async function listEvents(deps: CalendarDeps, req: CalendarEventsRequest, calendars?: CalendarInfo[]): Promise<CalendarReadResult> {
  const from = localDay(req?.from);
  const until = localDay(req?.to, 1); // to 다음 날 자정 — to 당일을 포함한다
  if (!from || !until || from.getTime() >= until.getTime()) return invalid('일정을 읽을 기간이 날짜(YYYY-MM-DD)가 아니거나 거꾸로입니다.');
  const wanted = Array.isArray(req.calendars) ? req.calendars.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  const ids = [...new Set(wanted.length ? wanted : ['primary'])];
  const timeMin = localRfc3339(from);
  const timeMax = localRfc3339(until);

  return guard(async (): Promise<CalendarReadResult> => {
    const send = session(deps);
    const events: RawEvent[] = [];
    const skipped: string[] = [];
    let firstSkip: CalendarFailure | null = null;
    let read = 0;
    for (const id of ids) {
      const info = calendars?.find((c) => c.id === id) ?? (id === 'primary' ? calendars?.find((c) => c.primary) : undefined);
      const holiday = info?.holiday ?? id.includes(HOLIDAY_MARK);
      // 내 달력(본인 달력·내가 만든 달력)도 공휴일 달력도 아니면 남의 달력이다. 달력 목록이 없으면 본인 달력만 내 것으로 본다
      const other = !holiday && !(info ? info.mine : id === 'primary');
      const cal: CalendarFlags = { canWrite: info?.canWrite ?? id === 'primary', holiday, other, name: other ? (info?.summary ?? '') : '' };
      const got = await readCalendar(send, id, timeMin, timeMax, cal);
      if (Array.isArray(got)) {
        events.push(...got);
        read++;
        continue;
      }
      const mine = id === 'primary' || info?.primary === true;
      if (mine || (got.status !== 403 && got.status !== 404)) return got.fail;
      skipped.push(id);
      firstSkip ??= got.fail;
    }
    if (read === 0 && firstSkip) return firstSkip;
    // 시작 시각순 — 같은 때면 종일 일정이 먼저, 그다음은 달력을 읽은 순서(sort는 순서를 지킨다)
    events.sort((a, b) => startMs(a) - startMs(b) || Number(b.allDay) - Number(a.allDay));
    return { ok: true, events, skipped };
  });
}

// ── 일정 쓰기 ───────────────────────────────────────────────────────────────

type When = { allDay: true; day: Date } | { allDay: false; at: Date };

function parseWhen(v: unknown): When | null {
  const day = localDay(v);
  if (day) return { allDay: true, day };
  const at = localMinute(v);
  return at ? { allDay: false, at } : null;
}

/**
 * EventInput → 요청 본문. 종일이면 `date`(끝은 포함 날짜로 받으므로 하루 더해 보낸다),
 * 시각이면 이 컴퓨터 시간대의 `dateTime` + `timeZone`.
 * 고칠 때(patch)는 준 칸만 담고, 종일↔시각이 바뀔 수 있으므로 반대쪽 칸을 null로 지운다(PATCH는 칸을 합친다).
 */
function buildBody(input: Partial<EventInput>, patch: boolean): { ok: true; body: Record<string, unknown> } | CalendarFailure {
  const body: Record<string, unknown> = {};
  if (input.summary !== undefined) {
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) return invalid('일정 제목을 입력하세요.');
    body.summary = summary;
  } else if (!patch) {
    return invalid('일정 제목을 입력하세요.');
  }
  if (typeof input.location === 'string') body.location = input.location;
  if (typeof input.description === 'string') body.description = input.description;

  const start = input.start === undefined ? undefined : parseWhen(input.start);
  const end = input.end === undefined ? undefined : parseWhen(input.end);
  if (!patch && (start === undefined || end === undefined)) return invalid('일정의 시작과 끝을 입력하세요.');
  if (start === null || end === null) return invalid('일정 시각은 종일이면 YYYY-MM-DD, 아니면 YYYY-MM-DDTHH:MM으로 적습니다.');
  const given = [start, end].filter((w): w is When => w !== undefined);
  if (given.some((w) => w.allDay !== given[0].allDay) || (typeof input.allDay === 'boolean' && given.some((w) => w.allDay !== input.allDay))) {
    return invalid('종일 일정은 시작·끝을 날짜로, 시각 일정은 시작·끝을 시각으로 적습니다.');
  }
  if (start && end) {
    const [a, b] = [start.allDay ? start.day : start.at, end.allDay ? end.day : end.at];
    if (b.getTime() < a.getTime()) return invalid('일정의 끝이 시작보다 앞섭니다.');
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const side = (w: When, isEnd: boolean): Record<string, unknown> => {
    if (w.allDay) {
      const day = isEnd ? new Date(w.day.getFullYear(), w.day.getMonth(), w.day.getDate() + 1) : w.day;
      return { date: isoDate(day), ...(patch ? { dateTime: null, timeZone: null } : {}) };
    }
    return { dateTime: localRfc3339(w.at), ...(timeZone ? { timeZone } : {}), ...(patch ? { date: null } : {}) };
  };
  if (start) body.start = side(start, false);
  if (end) body.end = side(end, true);
  return { ok: true, body };
}

/** 달력 ID — 없으면 본인 달력 */
const calendarIdOf = (calendarId: unknown): string => (typeof calendarId === 'string' && calendarId.trim() ? calendarId.trim() : 'primary');
const eventsUrl = (calendarId: unknown): string => `${API}/calendars/${encodeURIComponent(calendarIdOf(calendarId))}/events`;
const FIELDS_QUERY = `?fields=${encodeURIComponent(EVENT_FIELDS)}`;

async function writtenEvent(res: Response, calendarId: string): Promise<CalendarWriteResult> {
  if (!res.ok) return failure(res);
  // 쓰기에 성공한 달력이므로 고칠 수 있는 일정이다
  const event = toRawEvent(calendarId, (await readJson(res)) as GEvent, { canWrite: true, holiday: false });
  return event ? { ok: true, event } : { ok: false, code: 'api-error', message: 'Google 달력 응답에서 일정을 읽지 못했습니다.' };
}

/** 일정 만들기 — `calendarId`가 없으면 본인 달력 */
export async function insertEvent(deps: CalendarDeps, input: EventInput): Promise<CalendarWriteResult> {
  const built = buildBody(input ?? {}, false);
  if (!built.ok) return built;
  return guard(async (): Promise<CalendarWriteResult> => {
    const res = await session(deps)('POST', `${eventsUrl(input.calendarId)}${FIELDS_QUERY}`, built.body);
    return writtenEvent(res, calendarIdOf(input.calendarId));
  });
}

/** 일정 고치기 — 준 칸만 바꾼다. 다른 달력으로 옮기지는 않는다(patch.calendarId는 보지 않는다) */
export async function patchEvent(deps: CalendarDeps, ref: EventRef, patch: Partial<EventInput>): Promise<CalendarWriteResult> {
  if (!ref || typeof ref.eventId !== 'string' || !ref.eventId) return invalid('고칠 일정을 가리키는 값이 없습니다.');
  const built = buildBody(patch ?? {}, true);
  if (!built.ok) return built;
  if (Object.keys(built.body).length === 0) return invalid('바꿀 내용이 없습니다.');
  return guard(async (): Promise<CalendarWriteResult> => {
    const url = `${eventsUrl(ref.calendarId)}/${encodeURIComponent(ref.eventId)}${FIELDS_QUERY}`;
    const res = await session(deps)('PATCH', url, built.body);
    return writtenEvent(res, calendarIdOf(ref.calendarId));
  });
}

/** 일정 지우기 — 성공은 204. 이미 지워진 일정(410)도 지워진 것으로 본다 */
export async function deleteEvent(deps: CalendarDeps, ref: EventRef): Promise<CalendarDeleteResult> {
  if (!ref || typeof ref.eventId !== 'string' || !ref.eventId) return invalid('지울 일정을 가리키는 값이 없습니다.');
  return guard(async (): Promise<CalendarDeleteResult> => {
    const res = await session(deps)('DELETE', `${eventsUrl(ref.calendarId)}/${encodeURIComponent(ref.eventId)}`);
    if (res.status === 204 || res.ok || res.status === 410) return { ok: true };
    return failure(res);
  });
}
