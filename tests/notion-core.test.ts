/**
 * Notion 읽기 통로 — 요청 모양(주소·머리말·본문)과 응답 해석, 오류 구분. 가짜 fetch로 돈다(값은 모두 합성).
 * 요청 모양은 Notion 공개 API 문서(2025-09-03 판)를 따른다: 데이터 소스 조회·검색·DB 조회.
 */
import { describe, expect, it, vi } from 'vitest';
import { listSources, NOTION_VERSION, parseNotionId, plainText, queryRecent, readRecent, resolveSource, searchLoose, toPage } from '../electron/notion-core';

const ID_A = '11111111-2222-3333-4444-555555555555';
const HEX_A = ID_A.replace(/-/g, '');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** 순서대로 답하는 가짜 fetch — 부른 내용을 calls에 남긴다 */
function fakeFetch(answers: Array<{ status?: number; json?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: a.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const page = (id: string, title: string, edited: string, extra: Record<string, unknown> = {}) => ({
  object: 'page',
  id,
  created_time: '2026-11-20T01:05:00.000Z',
  last_edited_time: edited,
  in_trash: false,
  url: `https://www.notion.so/${id.replace(/-/g, '')}`,
  parent: { type: 'data_source_id', data_source_id: 'ds-1', database_id: 'db-1' },
  properties: { 상태: { type: 'status', status: { name: '진행' } }, 이름: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
  ...extra,
});

describe('parseNotionId', () => {
  it('주소·32자리·대시 붙은 ID에서 같은 ID를 꺼낸다', () => {
    expect(parseNotionId(`https://www.notion.so/workspace/Example-DB-${HEX_A}?v=99999999999999999999999999999999`)).toBe(ID_A);
    expect(parseNotionId(`https://app.notion.com/p/${HEX_A}`)).toBe(ID_A);
    expect(parseNotionId(HEX_A.toUpperCase())).toBe(ID_A);
    expect(parseNotionId(` ${ID_A} `)).toBe(ID_A);
  });
  it('주소의 보기 ID(?v=)만 있거나 ID가 아니면 null', () => {
    expect(parseNotionId(`https://www.notion.so/workspace/Example?v=${HEX_A}`)).toBeNull();
    expect(parseNotionId('회의록')).toBeNull();
    expect(parseNotionId(123)).toBeNull();
    expect(parseNotionId(`${HEX_A}0`)).toBeNull();
  });
});

describe('toPage', () => {
  it('제목 속성을 이름이 아니라 종류로 찾고, 만든 때·고친 때·주소를 옮긴다', () => {
    const p = toPage(page(ID_A, 'AB Z+ 정기 회의', '2026-11-21T02:00:00.000Z'));
    expect(p).toEqual({ id: ID_A, sourceId: 'ds-1', title: 'AB Z+ 정기 회의', createdAt: '2026-11-20T01:05:00.000Z', editedAt: '2026-11-21T02:00:00.000Z', url: `https://www.notion.so/${HEX_A}` });
  });
  it('휴지통의 페이지·페이지가 아닌 것은 버린다', () => {
    expect(toPage(page(ID_A, 'x', '2026-11-21T02:00:00.000Z', { in_trash: true }))).toBeNull();
    expect(toPage({ object: 'data_source', id: ID_A })).toBeNull();
    expect(toPage(null)).toBeNull();
  });
  it('Notion 호스트가 아닌 주소는 쓰지 않고 ID로 만든 주소를 쓴다', () => {
    expect(toPage(page(ID_A, 'x', '2026-11-21T02:00:00.000Z', { url: 'https://example.com/steal' }))?.url).toBe(`https://www.notion.so/${HEX_A}`);
    expect(toPage(page(ID_A, 'x', '2026-11-21T02:00:00.000Z', { url: `https://app.notion.com/p/${HEX_A}` }))?.url).toBe(`https://app.notion.com/p/${HEX_A}`);
  });
  it('DB 밖의 페이지는 sourceId가 비고, 제목이 없으면 "제목 없음"', () => {
    const p = toPage(page(ID_A, '', '2026-11-21T02:00:00.000Z', { parent: { type: 'page_id', page_id: 'x' } }));
    expect(p?.sourceId).toBe('');
    expect(p?.title).toBe('제목 없음');
  });
  it('글 조각 여러 개를 한 줄로 잇는다', () => {
    expect(plainText([{ plain_text: 'AB ' }, { plain_text: 'Z+\n회의' }])).toBe('AB Z+ 회의');
    expect(plainText(undefined)).toBe('');
  });
});

describe('queryRecent', () => {
  it('데이터 소스 조회를 고친 때 필터·최신순으로 부르고, 키와 판 번호를 머리말에 싣는다', async () => {
    const f = fakeFetch([{ json: { results: [page(ID_A, '회의', '2026-11-21T02:00:00.000Z')], has_more: false } }]);
    const got = await queryRecent({ token: 'ntn_test', fetch: f.fetch }, 'ds-1', '2026-11-10T00:00:00.000Z');
    expect(got.ok && got.pages.map((p) => p.title)).toEqual(['회의']);
    expect(f.calls[0].url).toBe('https://api.notion.com/v1/data_sources/ds-1/query');
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].headers.Authorization).toBe('Bearer ntn_test');
    expect(f.calls[0].headers['Notion-Version']).toBe(NOTION_VERSION);
    expect(f.calls[0].body).toEqual({
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: '2026-11-10T00:00:00.000Z' } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 50,
    });
  });
  it('더 있으면 한 번 더 이어 받고(두 쪽까지), 받은 쪽 표지를 그대로 보낸다', async () => {
    const f = fakeFetch([
      { json: { results: [page(ID_A, '1', '2026-11-21T02:00:00.000Z')], has_more: true, next_cursor: 'cur-1' } },
      { json: { results: [page('22222222-2222-3333-4444-555555555555', '2', '2026-11-20T02:00:00.000Z')], has_more: true, next_cursor: 'cur-2' } },
      { json: { results: [] } },
    ]);
    const got = await queryRecent({ token: 't', fetch: f.fetch }, 'ds-1', '2026-11-10T00:00:00.000Z');
    expect(got.ok && got.pages.length).toBe(2);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].body?.start_cursor).toBe('cur-1');
  });
});

describe('오류 구분', () => {
  const run = (status: number, json: unknown = { object: 'error', status, code: 'x', message: 'm' }) => queryRecent({ token: 't', fetch: fakeFetch([{ status, json }]).fetch, sleep: async () => undefined }, 'ds-1', '2026-11-10T00:00:00.000Z');
  it('401 → 키가 맞지 않음, 403 → 읽기 권한 없음, 404 → 연결을 붙이지 않음', async () => {
    expect(await run(401)).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await run(403)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await run(404)).toMatchObject({ ok: false, code: 'not-found' });
    expect(await run(400)).toMatchObject({ ok: false, code: 'api-error' });
  });
  it('429면 알려 준 시간만큼 기다렸다가 한 번만 다시 부른다', async () => {
    const sleep = vi.fn(async () => undefined);
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '2' }, json: {} }, { json: { results: [] } }]);
    const got = await queryRecent({ token: 't', fetch: f.fetch, sleep }, 'ds-1', '2026-11-10T00:00:00.000Z');
    expect(got.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
    const again = fakeFetch([{ status: 429, json: {} }]);
    expect(await queryRecent({ token: 't', fetch: again.fetch, sleep }, 'ds-1', '2026-11-10T00:00:00.000Z')).toMatchObject({ ok: false, code: 'rate-limited' });
    expect(again.calls).toHaveLength(2);
  });
  it('닿지 못하면 network — 오류 글에 키가 들어가지 않는다', async () => {
    const got = await queryRecent({ token: 'ntn_secret_value', fetch: fakeFetch([new Error('getaddrinfo ENOTFOUND')]).fetch }, 'ds-1', '2026-11-10T00:00:00.000Z');
    expect(got).toMatchObject({ ok: false, code: 'network' });
    expect(JSON.stringify(got)).not.toContain('ntn_secret_value');
  });
});

describe('listSources · resolveSource · searchLoose', () => {
  it('검색을 데이터 소스로 걸러 부르고 이름순으로 돌려준다', async () => {
    const f = fakeFetch([
      {
        json: {
          results: [
            { object: 'data_source', id: 'ds-2', title: [{ plain_text: '지원 기록' }], parent: { type: 'database_id', database_id: ID_A }, url: `https://www.notion.so/${HEX_A}` },
            { object: 'data_source', id: 'ds-1', title: [{ plain_text: '결정 기록' }], parent: { type: 'database_id', database_id: ID_A } },
            { object: 'data_source', id: 'ds-3', title: [], in_trash: true },
            { object: 'page', id: 'p' },
          ],
          has_more: false,
        },
      },
    ]);
    const got = await listSources({ token: 't', fetch: f.fetch });
    expect(got.ok && got.sources).toEqual([
      { id: 'ds-1', name: '결정 기록', url: `https://www.notion.so/${HEX_A}` },
      { id: 'ds-2', name: '지원 기록', url: `https://www.notion.so/${HEX_A}` },
    ]);
    expect(f.calls[0].url).toBe('https://api.notion.com/v1/search');
    expect(f.calls[0].body).toEqual({ filter: { property: 'object', value: 'data_source' }, page_size: 100 });
  });
  it('DB 주소로 그 안의 데이터 소스를 찾는다', async () => {
    const f = fakeFetch([{ json: { object: 'database', id: ID_A, title: [{ plain_text: '예시 회의' }], url: `https://www.notion.so/${HEX_A}`, data_sources: [{ id: 'ds-9', name: '예시 회의' }] } }]);
    const got = await resolveSource({ token: 't', fetch: f.fetch }, `https://www.notion.so/team/Meetings-${HEX_A}?v=abc`);
    expect(got.ok && got.sources).toEqual([{ id: 'ds-9', name: '예시 회의', url: `https://www.notion.so/${HEX_A}` }]);
    expect(f.calls[0]).toMatchObject({ url: `https://api.notion.com/v1/databases/${ID_A}`, method: 'GET', body: null });
  });
  it('DB로 못 찾으면 데이터 소스 ID로 한 번 더 찾고, 주소가 아니면 부르지 않는다', async () => {
    const f = fakeFetch([{ status: 404, json: {} }, { json: { object: 'data_source', id: ID_A, title: [{ plain_text: '예시 DB' }], parent: { type: 'database_id', database_id: 'db-x' } } }]);
    const got = await resolveSource({ token: 't', fetch: f.fetch }, ID_A);
    expect(got.ok && got.sources[0]).toMatchObject({ id: ID_A, name: '예시 DB' });
    expect(f.calls[1].url).toBe(`https://api.notion.com/v1/data_sources/${ID_A}`);
    const none = fakeFetch([{ json: {} }]);
    expect(await resolveSource({ token: 't', fetch: none.fetch }, '회의록 DB')).toMatchObject({ ok: false, code: 'not-found' });
    expect(none.calls).toHaveLength(0);
  });
  it('DB 밖의 페이지 — 검색 결과에서 DB의 행과 기간 밖의 것을 뺀다', async () => {
    const f = fakeFetch([
      {
        json: {
          results: [
            page(ID_A, '온보딩 안내', '2026-11-21T02:00:00.000Z', { parent: { type: 'page_id', page_id: 'x' } }),
            page('22222222-2222-3333-4444-555555555555', 'DB의 행', '2026-11-21T02:00:00.000Z'),
            page('33333333-2222-3333-4444-555555555555', '오래된 페이지', '2026-10-01T02:00:00.000Z', { parent: { type: 'workspace', workspace: true } }),
          ],
        },
      },
    ]);
    const got = await searchLoose({ token: 't', fetch: f.fetch }, '2026-11-10T00:00:00.000Z');
    expect(got.ok && got.pages.map((p) => p.title)).toEqual(['온보딩 안내']);
    expect(f.calls[0].body).toEqual({ filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 50 });
  });
});

describe('readRecent', () => {
  const since = '2026-11-10T00:00:00.000Z';
  /** 주소로 답을 고르는 가짜 fetch */
  const byUrl = (map: Record<string, { status?: number; json?: unknown }>) => {
    const calls: string[] = [];
    const fn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const a = Object.entries(map).find(([k]) => u.endsWith(k))?.[1] ?? { status: 404, json: {} };
      return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  };
  it('여러 DB의 행을 모아 최신순으로 — 한 DB만 못 읽으면 그 ID를 failed에 적고 나머지는 돌려준다', async () => {
    const f = byUrl({
      '/data_sources/ds-1/query': { json: { results: [page(ID_A, '오래된 것', '2026-11-12T02:00:00.000Z')] } },
      '/data_sources/ds-2/query': { json: { results: [page('22222222-2222-3333-4444-555555555555', '최근 것', '2026-11-21T02:00:00.000Z')] } },
      '/data_sources/ds-3/query': { status: 404, json: {} },
    });
    const got = await readRecent({ token: 't', fetch: f.fetch }, { sources: ['ds-1', 'ds-2', 'ds-3', 'ds-1'], since });
    expect(got.ok && got.pages.map((p) => p.title)).toEqual(['최근 것', '오래된 것']);
    expect(got.ok && got.pages.map((p) => p.sourceId)).toEqual(['ds-2', 'ds-1']);
    expect(got.ok && got.failed).toEqual(['ds-3']);
    expect(f.calls).toHaveLength(3); // 같은 DB를 두 번 부르지 않는다, 검색(DB 밖의 페이지)은 켰을 때만
  });
  it('키가 틀리면 전체 실패, 고른 DB를 하나도 못 읽어도 실패로 알린다', async () => {
    const bad = byUrl({ '/data_sources/ds-1/query': { status: 401, json: {} } });
    expect(await readRecent({ token: 't', fetch: bad.fetch }, { sources: ['ds-1'], since })).toMatchObject({ ok: false, code: 'unauthorized' });
    const none = byUrl({});
    expect(await readRecent({ token: 't', fetch: none.fetch }, { sources: ['ds-1', 'ds-2'], since })).toMatchObject({ ok: false, code: 'not-found' });
  });
  it('loose를 켜면 검색도 한 번 부르고, 기간이 올바르지 않으면 부르지 않는다', async () => {
    const f = byUrl({ '/data_sources/ds-1/query': { json: { results: [] } }, '/search': { json: { results: [page(ID_A, '안내', '2026-11-21T02:00:00.000Z', { parent: { type: 'page_id', page_id: 'x' } })] } } });
    const got = await readRecent({ token: 't', fetch: f.fetch }, { sources: ['ds-1'], since, loose: true });
    expect(got.ok && got.pages.map((p) => p.title)).toEqual(['안내']);
    expect(f.calls.some((u) => u.endsWith('/search'))).toBe(true);
    const no = byUrl({});
    expect(await readRecent({ token: 't', fetch: no.fetch }, { sources: ['ds-1'], since: '어제' })).toMatchObject({ ok: false });
    expect(no.calls).toHaveLength(0);
  });
});
