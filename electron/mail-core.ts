/**
 * Gmail 읽기 — 제목만 조회(스레드 목록)와 고른 스레드 하나의 본문 읽기.
 * main 전용이지만 Electron에 기대지 않아 테스트에서 바로 쓴다(가짜 fetch).
 *
 * - 두 단계로 읽는다: ① 사람·날짜로 찾아 **제목·보낸 사람·날짜만**(format=metadata) ② 사용자가 고른 스레드만 본문(format=full).
 *   찾은 메일을 모두 읽지 않는다 — 호출 수와 읽는 내용을 줄인다.
 * - 본문 뽑기와 인용 걷어내기는 메일을 읽는 도구의 Gmail 읽기와 같은 규칙이다: text/plain 우선, 없으면 HTML에서 태그를 걷고,
 *   인용된 이전 회신(머리글 블록·`>` 묶음·"… 님이 작성:" 아래)은 버린다. 전달(FW) 메일의 본문은 지킨다.
 * - 본문은 메일을 거르는 도구(sanitizer — mail-sanitize.ts)를 거친 것만 돌려준다. 거르지 못하면 읽지 않은 것으로 한다.
 *   ①의 제목·보낸 사람은 고르는 화면에만 보이고 앱 밖으로 나가지 않는다(AI에 보내는 제목은 ②에서 걸러진 것이다).
 * - 쓰지 않는다(읽기만). 메일 내용은 파일로 남기지 않는다.
 * - 토큰을 어디서 받는지는 모른다(deps.getToken) — 달력 호출과 같은 세션 도우미를 쓴다.
 */
import { isoOf } from '../src/lib/dates';
import type { MailFailure, MailMessage, MailSearchRequest, MailThreadInfo } from '../src/planner/types';
import { FetchNetworkError, session, type CalendarDeps, type Send } from './calendar-core';

export type MailDeps = CalendarDeps;

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const READ_SCOPES = new Set(['gmail.readonly', 'gmail.modify', 'https://mail.google.com/']);

/** 한 번에 제목을 가져오는 스레드 수 — 최근 것부터. 화면이 이 가운데 사안과 가까운 것을 추려 보인다 */
export const SEARCH_MAX = 20;
/** 한 번에 찾는 사람 수 */
const WHO_MAX = 3;
/** 스레드에서 읽는 메일 수 — 넘으면 첫 메일과 최근 것들만 */
export const THREAD_MAX_MESSAGES = 12;
/** 메일 하나에서 받는 본문 길이 */
export const MESSAGE_MAX_CHARS = 6000;
const PARALLEL = 4;

/** 토큰의 범위 문자열로 메일을 읽을 수 있는지 — 범위 이름을 통째로 견준다. 범위 정보가 없으면 시도한다(REST가 알려 준다) */
export function canReadMail(scope?: string): boolean {
  if (typeof scope !== 'string' || !scope.trim()) return true;
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .some((s) => READ_SCOPES.has(s) || (s.startsWith(SCOPE_PREFIX) && READ_SCOPES.has(s.slice(SCOPE_PREFIX.length))));
}

// ── 찾는 조건 ───────────────────────────────────────────────────────────────

/** 검색식에 넣을 낱말 — 연산자로 읽힐 글자(따옴표·괄호·중괄호·콜론)를 뗀다 */
function plain(s: string): string {
  return s.replace(/["'(){}:\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Gmail 검색식 — 그 사람이 보냈거나 받은(참조 포함) 메일, 그날 이후, 채팅·임시보관 제외.
 * 사람은 이름이나 주소 — Gmail은 `from:"이름"`으로 머리글의 표시 이름도 찾는다. 쉼표로 여럿이면 그중 누구든(셋까지).
 */
export function mailQuery(req: Pick<MailSearchRequest, 'who' | 'words' | 'since'>): string | null {
  const names = [...new Set((req.who ?? '').split(/\s*[,·;]\s*/).map(plain).filter(Boolean))].slice(0, WHO_MAX);
  if (names.length === 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(req.since ?? '');
  const parts = [`{${names.map((who) => `from:"${who}" to:"${who}" cc:"${who}"`).join(' ')}}`];
  const words = plain(req.words ?? '');
  if (words) parts.push(words);
  if (m) parts.push(`after:${m[1]}/${m[2]}/${m[3]}`);
  parts.push('-in:chats', '-in:drafts');
  return parts.join(' ');
}

// ── 호출 공통 ───────────────────────────────────────────────────────────────

const SCOPE_LACK_RE = /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

async function failure(res: Response): Promise<MailFailure> {
  const detail = await res.text().catch(() => '');
  if (res.status === 401) return { ok: false, code: 'refresh-failed', message: 'Gmail 인증이 거부되었습니다(401) — 토큰을 다시 받아야 합니다.' };
  if (res.status === 403 && SCOPE_LACK_RE.test(detail)) return { ok: false, code: 'scope-missing', message: '토큰에 메일을 읽는 권한 범위가 없습니다.' };
  return { ok: false, code: 'api-error', message: `Gmail API ${res.status}: ${detail.slice(0, 200)}` };
}

/** fetch 실패를 network 결과로 — 그 밖의 예외(토큰 받기 실패)는 그대로 올린다 */
async function guard<T>(run: () => Promise<T | MailFailure>): Promise<T | MailFailure> {
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

/** 한 번에 몇 개씩만 부른다 — Gmail의 요청 한도(429)를 건드리지 않게 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Gmail 응답의 모양 ───────────────────────────────────────────────────────

interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GPart[];
}

interface GMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart;
}

function header(msg: GMessage, name: string): string {
  const want = name.toLowerCase();
  return (msg.payload?.headers ?? []).find((h) => (h.name ?? '').toLowerCase() === want)?.value ?? '';
}

/** `"홍길동 책임" <a@b.example>` → `홍길동 책임`, 이름이 없으면 주소 */
export function displayName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return from.trim();
  return m[1].trim() || m[2].trim();
}

/** 스레드 한 줄에 담는 사람·날짜 수 */
const PEOPLE_MAX = 16;

/** `이름 <주소>, "성, 이름" <주소>` → 하나씩 (따옴표·꺾쇠 안의 쉼표는 가르지 않는다) */
function splitAddresses(value: string): string[] {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)(?![^<]*>)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dayOf(msg: GMessage): string {
  const ms = Number(msg.internalDate);
  return Number.isFinite(ms) && ms > 0 ? isoOf(new Date(ms)) : '';
}

const isMine = (msg: GMessage): boolean => (msg.labelIds ?? []).includes('SENT');

// ── ① 제목만 조회 ───────────────────────────────────────────────────────────

export type MailSearchCore = { ok: true; threads: MailThreadInfo[]; query: string; more: boolean } | MailFailure;

/**
 * 조건에 맞는 스레드를 최근 것부터 — 스레드마다 제목·보낸 사람·날짜·메일 수만 받는다(본문은 받지 않는다).
 * 읽지 못한 스레드(그 사이 지워짐 등)는 빼고 나머지를 돌려준다.
 */
export async function searchThreads(deps: MailDeps, req: MailSearchRequest): Promise<MailSearchCore> {
  const query = mailQuery(req);
  if (!query) return { ok: false, code: 'unknown', message: '찾을 사람을 적어 주세요.' };
  return guard(async () => {
    const send = session(deps);
    const list = await send('GET', `${API}/threads?q=${encodeURIComponent(query)}&maxResults=${SEARCH_MAX}`);
    if (!list.ok) return failure(list);
    const json = await readJson(list);
    const ids = (Array.isArray(json.threads) ? (json.threads as Array<{ id?: unknown }>) : []).map((t) => t.id).filter((id): id is string => typeof id === 'string' && !!id);
    const infos = await mapLimit(ids, PARALLEL, (id) => threadInfo(send, id));
    const threads = infos.filter((t): t is MailThreadInfo & { at: number } => t !== null).sort((a, b) => b.at - a.at);
    return { ok: true, threads: threads.map(({ at: _at, ...t }) => t), query, more: typeof json.nextPageToken === 'string' && !!json.nextPageToken };
  });
}

async function threadInfo(send: Send, id: string): Promise<(MailThreadInfo & { at: number }) | null> {
  const res = await send('GET', `${API}/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date`);
  if (!res.ok) return null;
  const messages = ((await readJson(res)).messages ?? []) as GMessage[];
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const people = new Set<string>();
  for (const msg of messages) {
    for (const part of [header(msg, 'From'), ...splitAddresses(header(msg, 'To')), ...splitAddresses(header(msg, 'Cc'))]) {
      const name = displayName(part);
      if (name) people.add(name);
    }
  }
  return {
    threadId: id,
    subject: header(first, 'Subject').trim() || '(제목 없음)',
    from: displayName(header(first, 'From')),
    date: dayOf(last),
    days: [...new Set(messages.map(dayOf).filter(Boolean))].sort().slice(-PEOPLE_MAX),
    people: [...people].slice(0, PEOPLE_MAX),
    count: messages.length,
    mine: messages.some(isMine),
    at: Number(last.internalDate) || 0,
  };
}

// ── ② 고른 스레드 읽기 ──────────────────────────────────────────────────────

export type MailThreadCore = { ok: true; threadId: string; subject: string; messages: MailMessage[]; truncated: boolean; sanitized: true } | MailFailure;

/** 거르는 도구 — 제목과 메일마다 보낸 사람·받는 사람·본문을 넣으면 같은 모양으로 걸러 돌려준다 (mail-sanitize.ts) */
export type MailSanitize = (input: { subject: string; messages: Array<{ from: string; to: string; body: string }> }) => Promise<
  { ok: true; value: { subject: string; messages: Array<{ from: string; to: string; body: string }> } } | MailFailure
>;

const THREAD_ID_RE = /^[0-9a-zA-Z_-]{6,40}$/;

/**
 * 스레드의 메일을 오래된 것부터 — 인용된 이전 회신을 걷어 낸 본문으로. 많으면 첫 메일과 최근 것들만.
 * 읽은 글은 **거르는 도구를 거친 뒤에만** 돌려준다. 거르지 못하면 글 없이 실패를 돌려준다.
 */
export async function readThread(deps: MailDeps, threadId: string, sanitize: MailSanitize): Promise<MailThreadCore> {
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return { ok: false, code: 'unknown', message: '스레드를 가리키는 값이 올바르지 않습니다.' };
  return guard(async () => {
    const send = session(deps);
    const res = await send('GET', `${API}/threads/${encodeURIComponent(threadId)}?format=full`);
    if (!res.ok) return failure(res);
    const all = ((await readJson(res)).messages ?? []) as GMessage[];
    if (!Array.isArray(all) || all.length === 0) return { ok: false, code: 'api-error', message: '스레드에 메일이 없습니다.' };
    let truncated = all.length > THREAD_MAX_MESSAGES;
    const picked = truncated ? [all[0], ...all.slice(-(THREAD_MAX_MESSAGES - 1))] : all;
    const subject = header(all[0], 'Subject').trim() || '(제목 없음)';
    const raw = picked.map((msg) => {
      let body = normalizeBody(extractBody(msg.payload), header(msg, 'Subject'));
      if (body.length > MESSAGE_MAX_CHARS) {
        body = `${body.slice(0, MESSAGE_MAX_CHARS)}\n[뒤는 길어 생략]`;
        truncated = true;
      }
      return { from: header(msg, 'From'), to: [header(msg, 'To'), header(msg, 'Cc')].filter(Boolean).join(', '), body };
    });
    // 날짜와 "내가 보낸 메일" 표시는 민감한 값이 아니다 — 거르는 도구에 넣지 않고(날짜 모양이 다른 규칙에 걸리지 않게) 뒤에 다시 붙인다
    const clean = await sanitize({ subject, messages: raw });
    if (!clean.ok) return clean;
    if (clean.value.messages.length !== picked.length) return { ok: false, code: 'sanitizer-failed', message: '메일을 거르지 못해 본문을 읽지 않았습니다 — 돌아온 메일 수가 다릅니다.' };
    const messages = clean.value.messages.map((m, i): MailMessage => ({ from: m.from, to: m.to, date: dayOf(picked[i]), mine: isMine(picked[i]), body: m.body }));
    return { ok: true, threadId, subject: clean.value.subject, messages, truncated, sanitized: true };
  });
}

// ── 본문 뽑기 (메일을 읽는 도구의 Gmail 읽기와 같은 규칙) ─────────────────────

function decode64(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function findPart(parts: GPart[], mime: string): GPart | null {
  for (const p of parts) {
    if (p.mimeType === mime) return p;
    if (p.parts) {
      const found = findPart(p.parts, mime);
      if (found) return found;
    }
  }
  return null;
}

/** HTML 메일의 인용 묶음(Gmail·Outlook)을 표식 한 줄로 */
function stripHtmlQuotes(html: string): string {
  return html
    .replace(/<blockquote[^>]*class="gmail_quote"[^>]*>[\s\S]*?<\/blockquote>/gi, '<p>[이전 회신 생략]</p>')
    .replace(/<div[^>]*id="divRplyFwdMsg"[^>]*>[\s\S]*$/gi, '<p>[이전 회신 생략]</p>');
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 메일의 글 — text/plain 우선, 없으면 HTML에서 태그를 걷는다. 글이 아닌 단일 파트(첨부)는 본문이 아니다 */
export function extractBody(payload: GPart | undefined): string {
  if (!payload) return '';
  if (payload.body?.data) {
    const mt = (payload.mimeType ?? '').toLowerCase();
    if (mt === 'text/html') return stripHtml(stripHtmlQuotes(decode64(payload.body.data)));
    if (!mt || mt.startsWith('text/')) return decode64(payload.body.data);
    return '';
  }
  if (payload.parts) {
    const text = findPart(payload.parts, 'text/plain');
    if (text?.body?.data) return decode64(text.body.data);
    const html = findPart(payload.parts, 'text/html');
    if (html?.body?.data) return stripHtml(stripHtmlQuotes(decode64(html.body.data)));
    for (const part of payload.parts) {
      if (!part.parts) continue;
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

// ── 인용 걷어내기 ───────────────────────────────────────────────────────────

const KNOWN_KEYS = new Set(['from', 'sent', 'to', 'cc', 'bcc', 'subject', 'date', '보내는사람', '보낸사람', '받는사람', '참조', '숨은참조', '보낸 날짜', '보낸날짜', '제목', '날짜']);
const SENDER_KEYS = new Set(['from', '보내는사람', '보낸사람']);
const SUBJECT_DATE_KEYS = new Set(['subject', '제목', 'date', 'sent', '보낸 날짜', '보낸날짜', '날짜']);
const FORWARD_MARKERS = [/forwarded message/i, /전달된 메시지/i];
/** 전달 메일의 제목 머리 — 이런 메일은 인용처럼 보이는 머리글 블록 아래가 본문이다 */
const FORWARD_SUBJECT_RE = /^\s*(?:\[?(?:fw|fwd|전달)\]?\s*:?\s*)+/i;
/** 전달 제목이라도 머리글 블록 앞에 이만큼 직접 썼으면 그 앞이 본문이고 뒤는 인용이다 */
const FORWARD_LEAD_MAX_CHARS = 120;
const SEPARATOR_RE = /^-{3,}\s*(?:Original Message|원본 메시지)\s*-{3,}$/i;
const HEADER_LINE_RE = /^([^:*\t]+?)\s*:\s*.+/;
const QUOTED = '[이전 회신 생략]';

function headerKey(line: string): string | null {
  const m = HEADER_LINE_RE.exec(line.replace(/\*/g, '').trim());
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  return KNOWN_KEYS.has(key) ? key : null;
}

/**
 * 머리글 블록(보낸 사람 + 제목·날짜가 든 3줄 이상)이나 "--- Original Message ---"부터를 인용으로 보고 자른다.
 * 전달 메일은 지킨다 — 바로 앞에 전달 표식이 있거나, 전달 제목인데 그 앞에 직접 쓴 글이 거의 없을 때.
 */
function stripQuotedHeaderBlocks(text: string, forwardSubject: boolean): string {
  const lines = text.split('\n');
  const result: string[] = [];
  const forwardNearby = () => FORWARD_MARKERS.some((re) => re.test(result.slice(-3).join('\n')));
  const forwardOnly = () => forwardSubject && result.join('').replace(/\s/g, '').length < FORWARD_LEAD_MAX_CHARS;

  for (let i = 0; i < lines.length; ) {
    if (SEPARATOR_RE.test(lines[i].trim())) {
      if (forwardNearby()) {
        result.push(lines[i++]);
        continue;
      }
      if (forwardOnly()) return text;
      result.push(QUOTED);
      return result.join('\n');
    }
    if (headerKey(lines[i])) {
      let j = i;
      let count = 0;
      const seen = new Set<string>();
      while (j < lines.length) {
        const key = headerKey(lines[j]);
        if (key) {
          count++;
          seen.add(key);
          j++;
          // 여러 줄로 이어진 받는 사람 목록 (들여쓰기 + 콜론 없음)
          for (let cont = 0; j < lines.length && cont < 20 && /^\s+[^:\n]+$/.test(lines[j]); cont++) j++;
          continue;
        }
        if (lines[j].trim() === '') {
          j++;
          continue;
        }
        break;
      }
      if (count >= 3 && [...seen].some((k) => SENDER_KEYS.has(k)) && [...seen].some((k) => SUBJECT_DATE_KEYS.has(k))) {
        if (forwardNearby()) {
          for (let k = i; k < j; k++) result.push(lines[k]);
          i = j;
          continue;
        }
        if (forwardOnly()) return text;
        result.push(QUOTED);
        return result.join('\n');
      }
    }
    result.push(lines[i++]);
  }
  return result.join('\n');
}

/** 본문 정리 — 인용된 이전 회신을 걷고 빈 줄·공백을 줄인다. 이번 메일에 새로 쓴 글은 바꾸지 않는다 */
export function normalizeBody(text: string, subject = ''): string {
  if (!text) return '';
  let out = stripQuotedHeaderBlocks(text.replace(/\r\n?/g, '\n'), FORWARD_SUBJECT_RE.test(subject));
  // Gmail의 인용 머리 줄 — "2026년 11월 20일 (금) 오후 2:31, 이름 <주소>님이 작성:" / "On … wrote:"
  out = out.replace(/\n\d{4}년 \d{1,2}월 \d{1,2}일[^\n]*님이 작성:[ \t]*\n/g, '\n').replace(/\nOn [^\n]{6,160} wrote:[ \t]*\n/g, '\n');
  // `>`로 시작하는 줄이 셋 이상 이어지면 인용 묶음
  out = out.replace(/\n(?:>[^\n]*\n){3,}(?:>[^\n]*(?:\n|$))*/g, `\n${QUOTED}\n`);
  return out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {4,}/g, ' ')
    .trim();
}
