/**
 * Notion 읽기 — 호출과 응답 해석 (Electron 없이 돈다. 통로는 notion.ts). 설계: docs/home-schedule-design.md §19.10
 *
 * - 읽기만 한다. 받는 것은 페이지의 제목·만든 때·고친 때·주소뿐이고 본문(블록)은 부르지 않는다.
 * - 2025-09-03 판의 모양을 쓴다: DB 안의 표는 "데이터 소스"이고, 행은 `POST /v1/data_sources/{id}/query`로 읽는다.
 * - 검색(`/v1/search`)은 색인이 늦고 빠질 수 있다(Notion 문서) — DB 찾기와 DB 밖의 페이지에만 쓰고,
 *   DB의 행은 데이터 소스 조회로 읽는다.
 */
import type { NotionErrorCode, NotionFailure, NotionPage, NotionRecentRequest, NotionSource, NotionSourcesResult } from '../src/planner/types';

const API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2025-09-03';
const TIMEOUT_MS = 15_000;
/** DB 하나에서 한 번에 받는 행 수 · 이어 받는 횟수 — 최근 2주에 한 DB가 100행을 넘게 바뀌면 최신 100행만 본다 */
const PAGE_SIZE = 50;
const MAX_PAGES = 2;
/** 한꺼번에 부르는 수 — Notion의 한도는 연결마다 초당 3건쯤이다 */
const PARALLEL = 3;
const MAX_SOURCES = 40;

export interface NotionDeps {
  token: string;
  fetch?: typeof fetch;
  /** 한도에 걸렸을 때 기다리는 함수 (테스트에서 바꾼다) */
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;
type Got = { ok: true; data: Json } | NotionFailure;

const fail = (code: NotionErrorCode, message: string): NotionFailure => ({ ok: false, code, message });
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 주소나 ID에서 Notion ID를 꺼내 8-4-4-4-12 모양으로 — 주소의 `?v=`(보기 ID)는 보지 않는다 */
export function parseNotionId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 600) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  const dashed = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s);
  const hex = dashed ? dashed[0].replace(/-/g, '') : (/(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i.exec(s)?.[1] ?? '');
  if (hex.length !== 32) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Notion의 글 조각 배열 → 한 줄 */
export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return '';
  return rich
    .map((r) => text(obj(r)?.plain_text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Notion이 준 주소 가운데 Notion 호스트의 https 주소만 쓴다 */
function notionUrl(v: unknown): string {
  const s = text(v);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && ['www.notion.so', 'notion.so', 'app.notion.com'].includes(u.hostname) ? s : '';
  } catch {
    return '';
  }
}

const fallbackUrl = (id: string): string => `https://www.notion.so/${id.replace(/-/g, '')}`;

/** 페이지 하나 → 한 줄. 휴지통의 페이지·모양이 다른 것은 null */
export function toPage(raw: unknown, sourceId?: string): NotionPage | null {
  const p = obj(raw);
  if (!p || p.object !== 'page' || p.in_trash === true || p.archived === true) return null;
  const id = text(p.id);
  const editedAt = text(p.last_edited_time);
  if (!id || !editedAt) return null;
  let title = '';
  for (const prop of Object.values(obj(p.properties) ?? {})) {
    const q = obj(prop);
    if (q?.type === 'title') {
      title = plainText(q.title);
      break;
    }
  }
  const parent = obj(p.parent);
  const inSource = parent?.type === 'data_source_id' ? text(parent.data_source_id) : parent?.type === 'database_id' ? text(parent.database_id) : '';
  return {
    id,
    sourceId: sourceId ?? inSource,
    title: title || '제목 없음',
    createdAt: text(p.created_time) || editedAt,
    editedAt,
    url: notionUrl(p.url) || fallbackUrl(id),
  };
}

function messageFor(status: number, code: string, detail: string): NotionFailure {
  if (status === 401) return fail('unauthorized', 'Notion 키가 맞지 않습니다 — 연결(통합)의 키를 다시 복사해 저장하세요.');
  if (status === 403) return fail('forbidden', 'Notion 연결에 "콘텐츠 읽기" 권한이 없습니다 — 연결 설정에서 켜세요.');
  if (status === 404) return fail('not-found', '찾지 못했습니다 — 그 DB(또는 그 위 페이지)의 ⋯ → 연결에 이 연결을 더했는지 확인하세요.');
  if (status === 429) return fail('rate-limited', 'Notion이 요청이 많다고 합니다 — 잠시 뒤 다시 읽으세요.');
  return fail('api-error', `Notion이 요청을 받지 않았습니다 (${status}${code ? ` ${code}` : ''})${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
}

/** 한 번 부른다 — 한도(429)에 걸리면 알려 준 시간만큼(최대 3초) 기다렸다가 한 번 더 */
async function call(deps: NotionDeps, method: 'GET' | 'POST', path: string, body?: Json, retried = false): Promise<Got> {
  const doFetch = deps.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${deps.token}`,
        'Notion-Version': NOTION_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 429 && !retried) {
      const wait = Math.min(3, Math.max(1, Number(res.headers.get('retry-after')) || 1));
      await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait * 1000);
      return await call(deps, method, path, body, true);
    }
    const data = obj(await res.json().catch(() => null));
    if (!res.ok) return messageFor(res.status, text(data?.code), text(data?.message));
    if (!data) return fail('api-error', 'Notion의 응답을 읽지 못했습니다.');
    return { ok: true, data };
  } catch (err) {
    if (ctrl.signal.aborted) return fail('network', 'Notion이 응답하지 않습니다 (15초).');
    return fail('network', `Notion에 닿지 못했습니다${err instanceof Error && err.message ? ` — ${err.message.slice(0, 120)}` : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

function toSource(raw: unknown): NotionSource | null {
  const d = obj(raw);
  if (!d || d.object !== 'data_source' || d.in_trash === true) return null;
  const id = text(d.id);
  if (!id) return null;
  const parent = obj(d.parent);
  const dbId = parent?.type === 'database_id' ? text(parent.database_id) : '';
  return { id, name: plainText(d.title) || text(d.name) || '이름 없는 DB', url: notionUrl(d.url) || fallbackUrl(dbId || id) };
}

/** 이 연결이 볼 수 있는 DB(데이터 소스) — 검색으로 찾는다. 연결 확인을 겸한다 */
export async function listSources(deps: NotionDeps): Promise<NotionSourcesResult> {
  const sources: NotionSource[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const got = await call(deps, 'POST', '/search', { filter: { property: 'object', value: 'data_source' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    if (!got.ok) return got;
    for (const r of Array.isArray(got.data.results) ? got.data.results : []) {
      const s = toSource(r);
      if (s && !sources.some((x) => x.id === s.id)) sources.push(s);
    }
    cursor = got.data.has_more === true ? text(got.data.next_cursor) : undefined;
    if (!cursor) break;
  }
  return { ok: true, sources: sources.sort((a, b) => a.name.localeCompare(b.name, 'ko')) };
}

/** 주소나 ID로 DB 하나를 찾는다 — 검색에 안 나온 DB를 손으로 더할 때. DB 주소면 그 안의 데이터 소스를 모두 돌려준다 */
export async function resolveSource(deps: NotionDeps, input: unknown): Promise<NotionSourcesResult> {
  const id = parseNotionId(input);
  if (!id) return fail('not-found', 'Notion 주소나 ID가 아닙니다 — DB를 연 화면의 주소를 그대로 붙여 넣으세요.');
  const db = await call(deps, 'GET', `/databases/${id}`);
  if (db.ok) {
    const title = plainText(db.data.title);
    const url = notionUrl(db.data.url) || fallbackUrl(id);
    const sources: NotionSource[] = [];
    for (const d of Array.isArray(db.data.data_sources) ? db.data.data_sources : []) {
      const sid = text(obj(d)?.id);
      if (sid) sources.push({ id: sid, name: text(obj(d)?.name) || title || '이름 없는 DB', url });
    }
    if (sources.length) return { ok: true, sources };
    return fail('not-found', '그 DB에서 표(데이터 소스)를 찾지 못했습니다.');
  }
  if (db.code !== 'not-found' && db.code !== 'api-error') return db;
  // DB ID가 아니면 데이터 소스 ID일 수 있다
  const ds = await call(deps, 'GET', `/data_sources/${id}`);
  if (!ds.ok) return ds.code === 'api-error' ? db : ds;
  const s = toSource(ds.data);
  return s ? { ok: true, sources: [s] } : fail('not-found', '그 주소는 DB가 아닙니다.');
}

/** DB 하나에서 `since` 이후에 고친 행 — 최신순, 많아야 PAGE_SIZE × MAX_PAGES */
export async function queryRecent(deps: NotionDeps, sourceId: string, since: string): Promise<{ ok: true; pages: NotionPage[] } | NotionFailure> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const got = await call(deps, 'POST', `/data_sources/${encodeURIComponent(sourceId)}/query`, {
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: PAGE_SIZE,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (!got.ok) return got;
    for (const r of Array.isArray(got.data.results) ? got.data.results : []) {
      const p = toPage(r, sourceId);
      if (p) pages.push(p);
    }
    cursor = got.data.has_more === true ? text(got.data.next_cursor) : undefined;
    if (!cursor) break;
  }
  return { ok: true, pages };
}

/** DB에 들어 있지 않은 페이지 가운데 `since` 이후에 고친 것 — 검색 한 번(색인이 늦을 수 있다) */
export async function searchLoose(deps: NotionDeps, since: string): Promise<{ ok: true; pages: NotionPage[] } | NotionFailure> {
  const got = await call(deps, 'POST', '/search', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: PAGE_SIZE,
  });
  if (!got.ok) return got;
  const pages: NotionPage[] = [];
  for (const r of Array.isArray(got.data.results) ? got.data.results : []) {
    const p = toPage(r);
    if (p && !p.sourceId && p.editedAt >= since) pages.push(p);
  }
  return { ok: true, pages };
}

/**
 * 고른 DB들의 최근 행(+ DB 밖의 페이지)을 한데 모은다.
 * 키가 틀렸거나 권한이 없으면 전체 실패, DB 하나만 못 읽었으면 그 ID를 `failed`에 적고 나머지는 돌려준다.
 */
export async function readRecent(
  deps: NotionDeps,
  req: NotionRecentRequest,
): Promise<{ ok: true; pages: NotionPage[]; failed: string[] } | NotionFailure> {
  const since = text(req?.since);
  if (!since || Number.isNaN(Date.parse(since))) return fail('api-error', '읽을 기간이 올바르지 않습니다.');
  const ids = [...new Set((Array.isArray(req.sources) ? req.sources : []).filter((x): x is string => typeof x === 'string' && x.trim() !== ''))].slice(0, MAX_SOURCES);
  const jobs: Array<{ id: string; run: () => Promise<{ ok: true; pages: NotionPage[] } | NotionFailure> }> = ids.map((id) => ({ id, run: () => queryRecent(deps, id, since) }));
  if (req.loose) jobs.push({ id: '', run: () => searchLoose(deps, since) });
  const pages: NotionPage[] = [];
  const failed: string[] = [];
  // 일꾼들이 함께 쓰는 값 — 객체에 담아야 TS가 콜백 안의 대입을 놓치지 않는다
  const st: { fatal: NotionFailure | null; last: NotionFailure | null } = { fatal: null, last: null };
  let next = 0;
  const worker = async () => {
    while (!st.fatal && next < jobs.length) {
      const job = jobs[next++];
      const got = await job.run();
      if (got.ok) pages.push(...got.pages);
      else if (got.code === 'unauthorized' || got.code === 'forbidden' || got.code === 'network') st.fatal = got;
      else {
        st.last = got;
        if (job.id) failed.push(job.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  if (st.fatal) return st.fatal;
  // 고른 DB를 하나도 읽지 못했으면 실패로 알린다(대개 연결을 그 DB에 붙이지 않은 것)
  if (ids.length > 0 && failed.length === ids.length && st.last) return st.last;
  const seen = new Set<string>();
  const unique = pages.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  unique.sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : 0));
  return { ok: true, pages: unique, failed };
}
