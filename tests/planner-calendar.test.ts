// @vitest-environment node
/**
 * Google 달력 호출(electron/calendar-core.ts) — 권한 범위 판정, 요청 모양, 응답 정규화, 오류 분류.
 * 실제로 부르지 않는다(fetch 가짜). 달력·일정 ID와 이름은 모두 합성 값이다.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  calendarScopes,
  deleteEvent,
  insertEvent,
  listCalendars,
  listEvents,
  localRfc3339,
  patchEvent,
  type CalendarDeps,
} from '../electron/calendar-core';
import type { CalendarInfo, RawEvent } from '../src/planner/types';

const API = 'https://www.googleapis.com/calendar/v3';
const AUTH = 'https://www.googleapis.com/auth/';
const TEAM = 'damdang-a@example.com'; // 동료 달력(합성)
const HOLIDAY = 'xx.sample#holiday'; // 공휴일 달력 표식만 든 합성 ID

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 요청을 적어 두는 가짜 fetch — handler가 URL을 보고 응답을 정한다 */
function fake(handler: (url: URL, n: number) => Response | Promise<Response>): { deps: CalendarDeps; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return handler(url, calls.length);
  }) as typeof fetch;
  return { deps: { getToken: async () => 'tok', fetchFn }, calls };
}

/** URL 경로의 달력 ID (인코딩을 푼 값) */
const calOf = (url: URL): string => decodeURIComponent(url.pathname.split('/')[4] ?? '');
const RANGE = { from: '2026-11-16', to: '2026-12-21' };

describe('calendarScopes — 토큰의 범위로 할 수 있는 일', () => {
  const of = (...names: string[]) => calendarScopes(names.map((n) => AUTH + n).join(' '));

  it('범위마다 읽기·목록·쓰기를 가린다', () => {
    const table: Array<[string, boolean, boolean, boolean]> = [
      ['calendar', true, true, true],
      ['calendar.readonly', true, true, false],
      ['calendar.events', true, false, true],
      ['calendar.events.readonly', true, false, false],
      ['calendar.events.owned', true, false, true],
      ['calendar.events.owned.readonly', true, false, false],
      ['calendar.calendarlist', false, true, false],
      ['calendar.calendarlist.readonly', false, true, false],
    ];
    for (const [name, canRead, canList, canWrite] of table) {
      expect([name, of(name)]).toEqual([name, { canRead, canList, canWrite }]);
    }
  });

  it('부분 일치로 읽지 않는다 — 읽기 전용이 쓰기로, 다른 달력 범위가 읽기로 읽히지 않는다', () => {
    expect(of('calendar.events.readonly').canWrite).toBe(false);
    expect(of('calendar.events.owned.readonly').canWrite).toBe(false);
    expect(of('calendar.calendarlist.readonly').canRead).toBe(false);
    const none = { canRead: false, canList: false, canWrite: false };
    expect(of('calendar.settings.readonly')).toEqual(none);
    expect(of('calendar.acls')).toEqual(none);
    expect(of('calendar.freebusy')).toEqual(none);
    expect(of('calendar.calendars')).toEqual(none);
    expect(of('gmail.modify', 'drive.file', 'spreadsheets.readonly')).toEqual(none);
    expect(calendarScopes(`${AUTH}calendar.eventsX ${AUTH}xcalendar`)).toEqual(none);
  });

  it('여러 범위가 섞여 있으면 합쳐서 본다 (공백·줄바꿈 구분)', () => {
    expect(of('gmail.modify', 'calendar.events.readonly', 'calendar.calendarlist.readonly')).toEqual({ canRead: true, canList: true, canWrite: false });
    expect(calendarScopes(`${AUTH}gmail.modify\n${AUTH}calendar.events.owned\t${AUTH}calendar.events.readonly`)).toEqual({
      canRead: true,
      canList: false,
      canWrite: true,
    });
  });

  it('범위 정보가 없으면 셋 다 된다고 보고 시도한다', () => {
    const all = { canRead: true, canList: true, canWrite: true };
    expect(calendarScopes(undefined)).toEqual(all);
    expect(calendarScopes()).toEqual(all);
    expect(calendarScopes('  ')).toEqual(all);
  });
});

describe('listCalendars — 달력 목록', () => {
  it('목록을 읽어 쓸 수 있는지·공휴일 달력인지를 가린다', async () => {
    const { deps, calls } = fake(() =>
      jsonRes(200, {
        items: [
          { id: 'me@example.com', summary: '홍길동', primary: true, accessRole: 'owner' },
          { id: HOLIDAY, summary: '휴일', accessRole: 'reader' },
          { id: TEAM, summary: '담당A', summaryOverride: '담당A 일정', accessRole: 'writer' },
          { id: 'free@example.com', summary: '바쁨만 보임', accessRole: 'freeBusyReader' },
          { id: 'gone@example.com', summary: '지운 달력', accessRole: 'reader', deleted: true },
        ],
      }),
    );
    const r = await listCalendars(deps);
    expect(r).toEqual({
      ok: true,
      calendars: [
        { id: 'me@example.com', summary: '홍길동', primary: true, canWrite: true, holiday: false },
        { id: HOLIDAY, summary: '휴일', primary: false, canWrite: false, holiday: true },
        { id: TEAM, summary: '담당A 일정', primary: false, canWrite: true, holiday: false },
        { id: 'free@example.com', summary: '바쁨만 보임', primary: false, canWrite: false, holiday: false },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe(`${API}/users/me/calendarList`);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('범위가 모자라면 scope-missing', async () => {
    const { deps } = fake(() => jsonRes(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }));
    expect(await listCalendars(deps)).toMatchObject({ ok: false, code: 'scope-missing' });
  });
});

describe('listEvents — 요청', () => {
  it('기간은 이 컴퓨터의 자정 기준 — from 당일 0시부터 to 다음 날 0시 전까지, 반복 일정은 펼쳐서 시작 시각순', async () => {
    const { deps, calls } = fake(() => jsonRes(200, { items: [] }));
    const r = await listEvents(deps, { ...RANGE, calendars: ['primary'] });
    expect(r).toEqual({ ok: true, events: [], skipped: [] });
    expect(calls).toHaveLength(1);
    const { url, method, headers, body } = calls[0];
    expect(method).toBe('GET');
    expect(body).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer tok');
    expect(url.origin + url.pathname).toBe(`${API}/calendars/primary/events`);
    const q = url.searchParams;
    expect(q.get('singleEvents')).toBe('true');
    expect(q.get('orderBy')).toBe('startTime');
    expect(q.get('maxResults')).toBe('250');
    expect(q.get('pageToken')).toBeNull();
    // 시간대 오프셋이 붙은 RFC3339
    expect(q.get('timeMin')).toMatch(/^2026-11-16T00:00:00[+-]\d{2}:\d{2}$/);
    expect(q.get('timeMax')).toMatch(/^2026-12-22T00:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(q.get('timeMin') ?? '')).toBe(new Date(2026, 10, 16).getTime());
    expect(Date.parse(q.get('timeMax') ?? '')).toBe(new Date(2026, 11, 22).getTime());
    // 설명(본문)은 달라고 하지 않는다
    expect(q.get('fields')).toContain('items(');
    expect(q.get('fields')).toContain('nextPageToken');
    expect(q.get('fields')).not.toContain('description');
  });

  it('달력 ID는 경로에 인코딩해 넣고, 달력을 주지 않으면 본인 달력을 읽는다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, { items: [] }));
    await listEvents(deps, { ...RANGE, calendars: ['primary', TEAM, HOLIDAY, TEAM] });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/calendar/v3/calendars/primary/events',
      '/calendar/v3/calendars/damdang-a%40example.com/events',
      '/calendar/v3/calendars/xx.sample%23holiday/events',
    ]); // 겹친 달력은 한 번만
    calls.length = 0;
    await listEvents(deps, { ...RANGE, calendars: [] });
    expect(calls.map((c) => calOf(c.url))).toEqual(['primary']);
  });

  it('다음 쪽 표가 있으면 이어서 읽는다 — 최대 4쪽', async () => {
    const pages: Record<string, { items: unknown[]; nextPageToken?: string }> = {
      '': { items: [{ id: 'e1', start: { dateTime: '2026-11-24T14:00:00+09:00' }, end: { dateTime: '2026-11-24T15:00:00+09:00' } }], nextPageToken: 'p2' },
      p2: { items: [{ id: 'e2', start: { dateTime: '2026-11-26T10:00:00+09:00' }, end: { dateTime: '2026-11-26T12:00:00+09:00' } }] },
    };
    const { deps, calls } = fake((url) => jsonRes(200, pages[url.searchParams.get('pageToken') ?? '']));
    const r = await listEvents(deps, { ...RANGE, calendars: ['primary'] });
    expect(r.ok && r.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(calls.map((c) => c.url.searchParams.get('pageToken'))).toEqual([null, 'p2']);
    expect(calls[1].url.searchParams.get('timeMin')).toBe(calls[0].url.searchParams.get('timeMin')); // 쪽을 넘겨도 같은 조건

    const endless = fake((_url, n) => jsonRes(200, { items: [], nextPageToken: `p${n + 1}` }));
    await listEvents(endless.deps, { ...RANGE, calendars: ['primary'] });
    expect(endless.calls).toHaveLength(4);
  });

  it('기간이 날짜가 아니거나 거꾸로면 부르지 않는다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, { items: [] }));
    for (const range of [
      { from: '2026-02-30', to: '2026-03-05' },
      { from: '11/16', to: '2026-12-21' },
      { from: '2026-12-21', to: '2026-11-16' },
    ]) {
      expect(await listEvents(deps, { ...range, calendars: ['primary'] })).toMatchObject({ ok: false, code: 'unknown' });
    }
    expect(calls).toHaveLength(0);
    expect((await listEvents(deps, { from: '2026-11-23', to: '2026-11-23', calendars: ['primary'] })).ok).toBe(true); // 하루짜리 기간
  });
});

describe('listEvents — 정규화', () => {
  const items = [
    {
      id: 'e-meet',
      summary: 'MX 주간 미팅',
      location: '온라인',
      description: '받지 않는 본문',
      start: { dateTime: '2026-11-24T14:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-11-24T15:00:00+09:00', timeZone: 'Asia/Seoul' },
      status: 'confirmed',
      eventType: 'default',
      htmlLink: 'https://calendar.example.com/e-meet',
      hangoutLink: 'https://meet.example.com/abc',
      updated: '2026-11-20T01:00:00.000Z',
    },
    { id: 'e-off', summary: '휴가', start: { date: '2026-12-04' }, end: { date: '2026-12-05' }, eventType: 'outOfOffice' },
    {
      id: 'e-no',
      summary: '거절한 회의',
      start: { dateTime: '2026-11-25T09:00:00+09:00' },
      end: { dateTime: '2026-11-25T10:00:00+09:00' },
      attendees: [
        { self: false, responseStatus: 'declined' },
        { self: true, responseStatus: 'declined' },
      ],
    },
    {
      id: 'e-conf',
      summary: 'AB Z+ 수집 서버 패치',
      start: { dateTime: '2026-11-26T10:00:00+09:00' },
      end: { dateTime: '2026-11-26T12:00:00+09:00' },
      status: 'tentative',
      conferenceData: { entryPoints: [{ entryPointType: 'video' }] },
      attendees: [{ self: true, responseStatus: 'accepted' }, { responseStatus: 'declined' }],
    },
    { id: 'e-gone', summary: '취소된 일정', status: 'cancelled', start: { dateTime: '2026-11-27T10:00:00+09:00' }, end: { dateTime: '2026-11-27T11:00:00+09:00' } },
    { id: 'e-bare', start: { dateTime: '2026-11-30T10:00:00+09:00' } }, // 제목·끝이 없는 일정
    { id: 'e-day', summary: '끝이 없는 종일 일정', start: { date: '2026-12-31' } },
    { summary: 'ID가 없는 항목' },
  ];

  async function events(): Promise<RawEvent[]> {
    const { deps } = fake(() => jsonRes(200, { items }));
    const r = await listEvents(deps, { ...RANGE, calendars: ['primary'] });
    if (!r.ok) throw new Error(r.message);
    return r.events;
  }
  const byId = async (id: string) => (await events()).find((e) => e.id === id);

  it('시각 일정 — 시간대가 붙은 시각 그대로, 화상 회의 링크 표시, 설명은 담지 않는다', async () => {
    const e = await byId('e-meet');
    expect(e).toEqual<RawEvent>({
      calendarId: 'primary',
      id: 'e-meet',
      summary: 'MX 주간 미팅',
      location: '온라인',
      allDay: false,
      start: '2026-11-24T14:00:00+09:00',
      end: '2026-11-24T15:00:00+09:00',
      status: 'confirmed',
      eventType: 'default',
      htmlLink: 'https://calendar.example.com/e-meet',
      meet: true,
      declined: false,
      holiday: false,
      canWrite: true,
      updated: '2026-11-20T01:00:00.000Z',
    });
    expect(e).not.toHaveProperty('description');
  });

  it('종일 일정 — 날짜만, 끝은 포함하지 않는 다음 날 그대로', async () => {
    expect(await byId('e-off')).toMatchObject({ allDay: true, start: '2026-12-04', end: '2026-12-05', eventType: 'outOfOffice', meet: false });
  });

  it('내가 거절한 일정만 거절로 표시한다 (남의 거절은 아니다)', async () => {
    expect((await byId('e-no'))?.declined).toBe(true);
    expect((await byId('e-conf'))?.declined).toBe(false);
  });

  it('회의 입장 정보(conferenceData)가 있어도 화상 회의로 본다', async () => {
    expect(await byId('e-conf')).toMatchObject({ meet: true, status: 'tentative' });
  });

  it('취소된 일정·ID 없는 항목은 버리고, 빠진 칸은 기본값으로 채운다', async () => {
    const all = await events();
    expect(all.map((e) => e.id)).toEqual(['e-meet', 'e-no', 'e-conf', 'e-bare', 'e-off', 'e-day']); // 시작 시각순
    expect(await byId('e-bare')).toMatchObject({ summary: '', location: '', end: '2026-11-30T10:00:00+09:00', status: 'confirmed', eventType: 'default', htmlLink: '', updated: '' });
    expect(await byId('e-day')).toMatchObject({ allDay: true, start: '2026-12-31', end: '2027-01-01' }); // 끝이 없으면 하루짜리
  });

  it('여러 달력의 일정을 시작 시각순으로 섞는다 — 같은 날이면 종일 일정이 먼저', async () => {
    const day = localRfc3339(new Date(2026, 10, 26, 0, 0)); // 그날 0시에 시작하는 시각 일정
    const data: Record<string, unknown[]> = {
      primary: [
        { id: 'p-midnight', start: { dateTime: day }, end: { dateTime: day } },
        { id: 'p-late', start: { dateTime: localRfc3339(new Date(2026, 10, 27, 9, 0)) } },
      ],
      [TEAM]: [
        { id: 't-early', start: { dateTime: localRfc3339(new Date(2026, 10, 25, 9, 0)) } },
        { id: 't-allday', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } },
      ],
    };
    const { deps } = fake((url) => jsonRes(200, { items: data[calOf(url)] }));
    const r = await listEvents(deps, { ...RANGE, calendars: ['primary', TEAM] });
    expect(r.ok && r.events.map((e) => e.id)).toEqual(['t-early', 't-allday', 'p-midnight', 'p-late']);
  });

  it('쓸 수 있는지·공휴일인지는 달력 목록에서 — 목록이 없으면 본인 달력만 쓸 수 있는 것으로 본다', async () => {
    const one = (id: string) => [{ id: `e-${id.length}`, start: { date: '2026-12-25' }, end: { date: '2026-12-26' } }];
    const { deps } = fake((url) => jsonRes(200, { items: one(calOf(url)) }));
    const flags = (r: Awaited<ReturnType<typeof listEvents>>) => (r.ok ? r.events.map((e) => [e.calendarId, e.canWrite, e.holiday]) : r);

    const ids = ['primary', TEAM, HOLIDAY];
    expect(flags(await listEvents(deps, { ...RANGE, calendars: ids }))).toEqual([
      ['primary', true, false],
      [TEAM, false, false],
      [HOLIDAY, false, true],
    ]);

    const known: CalendarInfo[] = [
      { id: 'me@example.com', summary: '홍길동', primary: true, canWrite: true, holiday: false },
      { id: TEAM, summary: '담당A', primary: false, canWrite: true, holiday: false },
      { id: HOLIDAY, summary: '휴일', primary: false, canWrite: false, holiday: true },
    ];
    expect(flags(await listEvents(deps, { ...RANGE, calendars: ids }, known))).toEqual([
      ['primary', true, false], // 'primary'는 목록의 본인 달력으로 찾는다
      [TEAM, true, false],
      [HOLIDAY, false, true],
    ]);
  });
});

describe('listEvents — 달력 하나가 실패할 때', () => {
  const ok = { items: [{ id: 'e1', start: { date: '2026-11-24' }, end: { date: '2026-11-25' } }] };

  it('다른 달력이 404·403이면 그 달력만 건너뛰고 나머지를 돌려준다', async () => {
    for (const status of [404, 403]) {
      const { deps, calls } = fake((url) => (calOf(url) === TEAM ? jsonRes(status, { error: { message: 'no' } }) : jsonRes(200, ok)));
      const r = await listEvents(deps, { ...RANGE, calendars: ['primary', TEAM, HOLIDAY] });
      expect(r).toMatchObject({ ok: true, skipped: [TEAM] });
      expect(r.ok && r.events.map((e) => e.calendarId)).toEqual(['primary', HOLIDAY]);
      expect(calls).toHaveLength(3);
    }
  });

  it('본인 달력이 실패하면 전체 실패다', async () => {
    const { deps } = fake((url) => (calOf(url) === 'primary' ? jsonRes(404, { error: { message: 'Not Found' } }) : jsonRes(200, ok)));
    expect(await listEvents(deps, { ...RANGE, calendars: [TEAM, 'primary'] })).toMatchObject({ ok: false, code: 'api-error' });
  });

  it('다른 달력이라도 404·403이 아닌 오류면 전체 실패다', async () => {
    const { deps } = fake((url) => (calOf(url) === TEAM ? new Response('backend error', { status: 500 }) : jsonRes(200, ok)));
    expect(await listEvents(deps, { ...RANGE, calendars: ['primary', TEAM] })).toMatchObject({ ok: false, code: 'api-error' });
  });

  it('하나도 읽지 못했으면 빈 목록이 아니라 그 실패를 돌려준다', async () => {
    const { deps } = fake(() => jsonRes(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }));
    expect(await listEvents(deps, { ...RANGE, calendars: [TEAM, HOLIDAY] })).toMatchObject({ ok: false, code: 'scope-missing' });
  });
});

describe('401 재시도 · 오류 분류', () => {
  const req = { ...RANGE, calendars: ['primary'] };

  it('401이면 토큰을 강제 갱신해 1회 다시 부른다', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const { deps, calls } = fake((_url, n) => (n === 1 ? jsonRes(401, {}) : jsonRes(200, { items: [] })));
    const r = await listEvents({ ...deps, getToken }, req);
    expect(r.ok).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('갱신한 토큰은 같은 작업의 뒤 호출에도 쓴다', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const { deps, calls } = fake((_url, n) => (n === 1 ? jsonRes(401, {}) : jsonRes(200, { items: [] })));
    await listEvents({ ...deps, getToken }, { ...RANGE, calendars: ['primary', TEAM] });
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh', 'Bearer fresh']);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('다시 불러도 401이면 refresh-failed', async () => {
    const { deps, calls } = fake(() => jsonRes(401, { error: { message: 'Invalid Credentials' } }));
    expect(await listEvents(deps, req)).toMatchObject({ ok: false, code: 'refresh-failed' });
    expect(calls).toHaveLength(2);
  });

  it('fetch가 던지면(오프라인) network', async () => {
    const deps: CalendarDeps = { getToken: async () => 'tok', fetchFn: vi.fn().mockRejectedValue(new TypeError('fetch failed')) };
    const r = await listEvents(deps, req);
    expect(r).toMatchObject({ ok: false, code: 'network' });
    if (!r.ok) expect(r.message).toContain('fetch failed');
    expect(await deleteEvent(deps, { calendarId: 'primary', eventId: 'e1' })).toMatchObject({ ok: false, code: 'network' });
  });

  it('403에 범위 부족 표시가 있으면 scope-missing — 세 가지 문구 모두', async () => {
    const bodies = [
      { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } },
      { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
      { error: { code: 403, message: 'Request had insufficient authentication scopes.' } },
    ];
    for (const body of bodies) {
      const { deps } = fake(() => jsonRes(403, body));
      expect(await listEvents(deps, req)).toMatchObject({ ok: false, code: 'scope-missing' });
    }
  });

  it('그 밖의 실패는 api-error — 상태 코드와 본문 앞 200자', async () => {
    const forbidden = fake(() => jsonRes(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }));
    expect(await listEvents(forbidden.deps, req)).toMatchObject({ ok: false, code: 'api-error' });

    const long = fake(() => new Response(`backend ${'x'.repeat(500)}`, { status: 500 }));
    const r = await listEvents(long.deps, req);
    expect(r).toMatchObject({ ok: false, code: 'api-error' });
    if (!r.ok) {
      expect(r.message).toContain('500');
      expect(r.message).toContain('backend');
      expect(r.message.length).toBeLessThan(260);
    }
  });

  it('getToken이 던진 예외는 삼키지 않고 그대로 올린다 (분류는 부르는 쪽이 한다)', async () => {
    const boom = new Error('refresh dead');
    const fetchFn = vi.fn();
    await expect(listEvents({ getToken: vi.fn().mockRejectedValue(boom), fetchFn }, req)).rejects.toBe(boom);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('insertEvent — 일정 만들기', () => {
  const created = { id: 'new1', summary: '만든 일정', start: { date: '2026-12-04' }, end: { date: '2026-12-05' }, status: 'confirmed', htmlLink: 'https://calendar.example.com/new1' };

  it('종일 일정 — 끝 날짜(포함)를 하루 더해 보낸다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, created));
    const r = await insertEvent(deps, { summary: ' 휴가 ', allDay: true, start: '2026-12-04', end: '2026-12-04' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${API}/calendars/primary/events`);
    expect(calls[0].url.searchParams.get('fields')).not.toContain('description');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({ summary: '휴가', start: { date: '2026-12-04' }, end: { date: '2026-12-05' } });
    expect(r).toMatchObject({ ok: true, event: { calendarId: 'primary', id: 'new1', allDay: true, start: '2026-12-04', end: '2026-12-05', canWrite: true, holiday: false } });
  });

  it('여러 날 종일 일정 — 달·해를 넘겨도 하루 더한다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, created));
    await insertEvent(deps, { summary: '연말 휴가', allDay: true, start: '2026-12-29', end: '2026-12-31' });
    expect(calls[0].body).toMatchObject({ start: { date: '2026-12-29' }, end: { date: '2027-01-01' } });
  });

  it('시각 일정 — 이 컴퓨터 시간대의 RFC3339와 시간대 이름으로 보낸다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, { ...created, start: { dateTime: '2026-11-26T10:00:00+09:00' }, end: { dateTime: '2026-11-26T12:00:00+09:00' } }));
    const r = await insertEvent(deps, {
      calendarId: TEAM,
      summary: 'AB Z+ 수집 서버 패치',
      allDay: false,
      start: '2026-11-26T10:00',
      end: '2026-11-26T12:00',
      location: '현장',
      description: '준비물 확인',
    });
    expect(calls[0].url.pathname).toBe('/calendar/v3/calendars/damdang-a%40example.com/events');
    const body = calls[0].body as { start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } };
    expect(body).toMatchObject({ summary: 'AB Z+ 수집 서버 패치', location: '현장', description: '준비물 확인' });
    expect(body.start.dateTime).toMatch(/^2026-11-26T10:00:00[+-]\d{2}:\d{2}$/);
    expect(body.end.dateTime).toMatch(/^2026-11-26T12:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(body.start.dateTime)).toBe(new Date(2026, 10, 26, 10, 0).getTime());
    expect(Date.parse(body.end.dateTime)).toBe(new Date(2026, 10, 26, 12, 0).getTime());
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect([body.start.timeZone, body.end.timeZone]).toEqual([zone, zone]);
    expect(body.start).not.toHaveProperty('date');
    expect(r).toMatchObject({ ok: true, event: { calendarId: TEAM, allDay: false } });
    if (r.ok) expect(r.event).not.toHaveProperty('description'); // 응답에서도 설명은 담지 않는다
  });

  it('입력이 틀리면 부르지 않는다 — 빈 제목, 가짜 날짜, 종일·시각 섞임, 끝이 시작보다 앞', async () => {
    const { deps, calls } = fake(() => jsonRes(200, created));
    const bad = [
      { summary: '  ', allDay: true, start: '2026-12-04', end: '2026-12-04' },
      { summary: '가짜 날짜', allDay: true, start: '2026-02-30', end: '2026-03-01' },
      { summary: '가짜 시각', allDay: false, start: '2026-11-26T25:00', end: '2026-11-26T26:00' },
      { summary: '섞임', allDay: true, start: '2026-12-04', end: '2026-12-04T10:00' },
      { summary: '종일인데 시각', allDay: true, start: '2026-12-04T09:00', end: '2026-12-04T10:00' },
      { summary: '거꾸로', allDay: false, start: '2026-11-26T12:00', end: '2026-11-26T10:00' },
    ];
    for (const input of bad) expect(await insertEvent(deps, input)).toMatchObject({ ok: false, code: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  it('쓰기 범위가 없으면 scope-missing', async () => {
    const { deps } = fake(() => jsonRes(403, { error: { message: 'Request had insufficient authentication scopes.' } }));
    expect(await insertEvent(deps, { summary: '휴가', allDay: true, start: '2026-12-04', end: '2026-12-04' })).toMatchObject({ ok: false, code: 'scope-missing' });
  });
});

describe('patchEvent — 일정 고치기', () => {
  const ref = { calendarId: 'primary', eventId: 'evt 1' };
  const patched = { id: 'evt 1', summary: '정기점검', start: { dateTime: '2026-12-01T14:00:00+09:00' }, end: { dateTime: '2026-12-01T16:00:00+09:00' } };

  it('준 칸만 보낸다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, patched));
    const r = await patchEvent(deps, ref, { summary: '정기점검', location: '' });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url.pathname).toBe('/calendar/v3/calendars/primary/events/evt%201');
    expect(calls[0].body).toEqual({ summary: '정기점검', location: '' });
    expect(r).toMatchObject({ ok: true, event: { id: 'evt 1', calendarId: 'primary' } });
  });

  it('시각으로 옮기면 종일 칸을 지우고, 종일로 옮기면 시각 칸을 지운다 (끝 날짜는 하루 더해)', async () => {
    const { deps, calls } = fake(() => jsonRes(200, patched));
    await patchEvent(deps, ref, { start: '2026-12-01T14:00', end: '2026-12-01T16:00' });
    const timed = calls[0].body as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(timed.start.date).toBeNull();
    expect(timed.end.date).toBeNull();
    expect(Date.parse(String(timed.start.dateTime))).toBe(new Date(2026, 11, 1, 14, 0).getTime());
    expect(Date.parse(String(timed.end.dateTime))).toBe(new Date(2026, 11, 1, 16, 0).getTime());

    await patchEvent(deps, ref, { allDay: true, start: '2026-12-01', end: '2026-12-02' });
    expect(calls[1].body).toEqual({
      start: { date: '2026-12-01', dateTime: null, timeZone: null },
      end: { date: '2026-12-03', dateTime: null, timeZone: null },
    });
  });

  it('바꿀 내용이 없거나 가리키는 일정이 없으면 부르지 않는다', async () => {
    const { deps, calls } = fake(() => jsonRes(200, patched));
    expect(await patchEvent(deps, ref, {})).toMatchObject({ ok: false, code: 'unknown' });
    expect(await patchEvent(deps, { calendarId: 'primary', eventId: '' }, { summary: '제목' })).toMatchObject({ ok: false, code: 'unknown' });
    expect(await patchEvent(deps, ref, { allDay: false, start: '2026-12-01' })).toMatchObject({ ok: false, code: 'unknown' });
    expect(calls).toHaveLength(0);
  });
});

describe('deleteEvent — 일정 지우기', () => {
  it('204면 성공이다. 달력 ID가 없으면 본인 달력', async () => {
    const { deps, calls } = fake(() => new Response(null, { status: 204 }));
    expect(await deleteEvent(deps, { calendarId: '', eventId: 'evt1' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url.href).toBe(`${API}/calendars/primary/events/evt1`);
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers).not.toHaveProperty('Content-Type');
  });

  it('이미 지워진 일정(410)은 지워진 것으로 보고, 없는 일정(404)은 오류다', async () => {
    const gone = fake(() => jsonRes(410, { error: { message: 'Resource has been deleted' } }));
    expect(await deleteEvent(gone.deps, { calendarId: TEAM, eventId: 'evt1' })).toEqual({ ok: true });
    expect(gone.calls[0].url.pathname).toBe('/calendar/v3/calendars/damdang-a%40example.com/events/evt1');

    const missing = fake(() => jsonRes(404, { error: { message: 'Not Found' } }));
    expect(await deleteEvent(missing.deps, { calendarId: 'primary', eventId: 'evt-none' })).toMatchObject({ ok: false, code: 'api-error' });
  });

  it('지우기도 401이면 토큰을 갱신해 다시 부른다', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const { deps, calls } = fake((_url, n) => (n === 1 ? jsonRes(401, {}) : new Response(null, { status: 204 })));
    expect(await deleteEvent({ ...deps, getToken }, { calendarId: 'primary', eventId: 'evt1' })).toEqual({ ok: true });
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
  });
});
