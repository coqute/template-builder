// @vitest-environment node
/**
 * Gmail 읽기 (v0.29.0) — 제목만 조회 → 고른 스레드만 읽기, 인용 걷어내기, 거르는 도구(sanitizer)를 거친 글만 돌려주기.
 * Gmail은 가짜 fetch로, 거르는 도구는 가짜 함수로 대신한다(실제 호출은 터미널에서 따로 확인한다). 값은 모두 합성이다.
 */
import { describe, expect, it, vi } from 'vitest';
import { canReadMail, displayName, extractBody, mailQuery, normalizeBody, readThread, searchThreads, SEARCH_MAX, THREAD_MAX_MESSAGES, type MailSanitize } from '../electron/mail-core';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const at = (iso: string) => String(new Date(iso).getTime());
const addr = (name: string, local: string, domain: string) => `${name} <${[local, domain].join('@')}>`;
const HONG = addr('홍길동 책임', 'gildong.hong', 'abz.example');
const ME = addr('박민수', 'minsu', 'support.example');

function msg(o: { id: string; from: string; to?: string; subject?: string; date: string; sent?: boolean; text?: string; html?: string }) {
  const headers = [
    { name: 'From', value: o.from },
    { name: 'To', value: o.to ?? ME },
    { name: 'Subject', value: o.subject ?? '수집 누락 원인 문의' },
  ];
  const parts = [...(o.text !== undefined ? [{ mimeType: 'text/plain', body: { data: b64(o.text) } }] : []), ...(o.html !== undefined ? [{ mimeType: 'text/html', body: { data: b64(o.html) } }] : [])];
  return { id: o.id, labelIds: o.sent ? ['SENT'] : ['INBOX'], internalDate: at(o.date), payload: { mimeType: 'multipart/alternative', headers, parts } };
}

/** 주소 → 응답. 부른 주소를 모아 둔다 */
function fakeGmail(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const code = Object.entries(status).find(([k]) => u.includes(k))?.[1] ?? (key ? 200 : 404);
    return new Response(JSON.stringify(key ? routes[key] : { error: 'not found' }), { status: code });
  }) as unknown as typeof fetch;
  return { deps: { getToken: async () => 'tok', fetchFn }, calls };
}

/** 가짜 거르는 도구 — IP와 주소의 앞부분을 표식으로 바꾼다 */
const fakeSanitize: MailSanitize = async (input) => {
  const clean = (s: string) => s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[IP주소]').replace(/[A-Za-z0-9._-]+@/g, '[사용자]@');
  return { ok: true, value: { subject: clean(input.subject), messages: input.messages.map((m) => ({ from: clean(m.from), to: clean(m.to), body: clean(m.body) })) } };
};

describe('찾는 조건과 권한 범위', () => {
  it('그 사람이 보냈거나 받은 메일을, 그날 이후로 — 채팅·임시보관은 뺀다', () => {
    expect(mailQuery({ who: '홍길동', since: '2026-11-06' })).toBe('{from:"홍길동" to:"홍길동" cc:"홍길동"} after:2026/11/06 -in:chats -in:drafts');
    expect(mailQuery({ who: ' 홍길동 ', words: '수집 누락', since: '2026-11-06' })).toBe('{from:"홍길동" to:"홍길동" cc:"홍길동"} 수집 누락 after:2026/11/06 -in:chats -in:drafts');
    // 검색 연산자로 읽힐 글자는 뗀다
    expect(mailQuery({ who: '홍길동" OR in:anywhere {x}', since: '' })).toBe('{from:"홍길동 OR in anywhere x" to:"홍길동 OR in anywhere x" cc:"홍길동 OR in anywhere x"} -in:chats -in:drafts');
    expect(mailQuery({ who: '  ', since: '2026-11-06' })).toBeNull();
    // 요청자가 여럿이면 그중 누구든 — 셋까지
    expect(mailQuery({ who: '홍길동, 김철수', since: '' })).toBe('{from:"홍길동" to:"홍길동" cc:"홍길동" from:"김철수" to:"김철수" cc:"김철수"} -in:chats -in:drafts');
    expect(mailQuery({ who: '가나, 다라, 마바, 사아', since: '' })).not.toContain('사아');
  });

  it('메일을 읽는 범위가 있을 때만 — 범위 이름을 통째로 견준다', () => {
    const p = 'https://www.googleapis.com/auth/';
    expect(canReadMail(`${p}calendar.events.readonly ${p}gmail.modify`)).toBe(true);
    expect(canReadMail(`${p}gmail.readonly`)).toBe(true);
    expect(canReadMail('https://mail.google.com/')).toBe(true);
    expect(canReadMail(`${p}gmail.compose ${p}gmail.send`)).toBe(false); // 쓰기만 되는 범위
    expect(canReadMail(`${p}gmail.modify.extra`)).toBe(false);
    expect(canReadMail(undefined)).toBe(true); // 범위 정보가 없으면 시도한다
  });

  it('보낸 사람의 이름', () => {
    expect(displayName(HONG)).toBe('홍길동 책임');
    expect(displayName(`"홍길동" <${['a', 'b.example'].join('@')}>`)).toBe('홍길동');
    expect(displayName(['only', 'b.example'].join('@'))).toBe(['only', 'b.example'].join('@'));
  });
});

describe('① 제목만 조회', () => {
  it('스레드마다 제목·보낸 사람·날짜·메일 수만 — 본문을 읽는 호출은 하지 않는다', async () => {
    const g = fakeGmail({
      '/threads?q=': { threads: [{ id: 'aaaaaa01' }, { id: 'aaaaaa02' }], nextPageToken: 'next' },
      '/threads/aaaaaa01?': { messages: [msg({ id: 'm1', from: HONG, date: '2026-11-20T10:00:00+09:00' }), msg({ id: 'm2', from: ME, to: HONG, date: '2026-11-21T09:00:00+09:00', sent: true })] },
      '/threads/aaaaaa02?': { messages: [msg({ id: 'm3', from: addr('담당C', 'c', 'ganastore.example'), subject: '11월 정기점검 일정 협의', date: '2026-11-25T15:00:00+09:00' })] },
    });
    const r = await searchThreads(g.deps, { who: '홍길동', since: '2026-11-06' });
    expect(r).toEqual({
      ok: true,
      query: '{from:"홍길동" to:"홍길동" cc:"홍길동"} after:2026/11/06 -in:chats -in:drafts',
      more: true,
      // 최근 메일이 있는 스레드부터
      threads: [
        { threadId: 'aaaaaa02', subject: '11월 정기점검 일정 협의', from: '담당C', date: '2026-11-25', days: ['2026-11-25'], people: ['담당C', '박민수'], count: 1, mine: false },
        { threadId: 'aaaaaa01', subject: '수집 누락 원인 문의', from: '홍길동 책임', date: '2026-11-21', days: ['2026-11-20', '2026-11-21'], people: ['홍길동 책임', '박민수'], count: 2, mine: true },
      ],
    });
    expect(g.calls[0]).toContain(`maxResults=${SEARCH_MAX}`);
    expect(g.calls).toHaveLength(3);
    expect(g.calls.slice(1).every((u) => u.includes('format=metadata') && u.includes('metadataHeaders=Subject') && u.includes('metadataHeaders=Cc'))).toBe(true);
    expect(g.calls.some((u) => u.includes('format=full'))).toBe(false);
  });

  it('읽지 못한 스레드는 빼고, 찾을 사람이 없거나 권한이 없으면 실패로 알린다', async () => {
    const g = fakeGmail({ '/threads?q=': { threads: [{ id: 'aaaaaa01' }, { id: 'gone0001' }] }, '/threads/aaaaaa01?': { messages: [msg({ id: 'm1', from: HONG, date: '2026-11-20T10:00:00+09:00' })] } });
    const r = await searchThreads(g.deps, { who: '홍길동', since: '2026-11-06' });
    expect(r.ok && r.threads.map((t) => t.threadId)).toEqual(['aaaaaa01']);
    expect(await searchThreads(g.deps, { who: '', since: '2026-11-06' })).toMatchObject({ ok: false, code: 'unknown' });
    const denied = fakeGmail({ '/threads?q=': { error: { message: 'insufficient authentication scopes' } } }, { '/threads?q=': 403 });
    expect(await searchThreads(denied.deps, { who: '홍길동', since: '' })).toMatchObject({ ok: false, code: 'scope-missing' });
    const offline = { getToken: async () => 'tok', fetchFn: (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch };
    expect(await searchThreads(offline, { who: '홍길동', since: '' })).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('② 고른 스레드 읽기', () => {
  const thread = {
    messages: [
      msg({ id: 'm1', from: HONG, date: '2026-11-20T10:00:00+09:00', text: '수집 서버 192.0.2.11 에서 지표가 비어 있습니다.\r\n원인 확인 부탁드립니다.' }),
      msg({
        id: 'm2',
        from: ME,
        to: HONG,
        date: '2026-11-21T09:00:00+09:00',
        sent: true,
        text: '원인은 에이전트 2.9.4의 알려진 문제입니다.\n2.9.5 패치 파일을 전달드립니다.\n\n2026년 11월 20일 (금) 오전 10:00, 홍길동 책임 <x>님이 작성:\n> 수집 서버 192.0.2.11 에서 지표가 비어 있습니다.\n> 원인 확인 부탁드립니다.\n> 감사합니다.\n',
      }),
    ],
  };

  it('오래된 것부터, 인용을 걷어 낸 본문을 거르는 도구에 통과시켜 돌려준다', async () => {
    const g = fakeGmail({ '/threads/aaaaaa01?format=full': thread });
    const r = await readThread(g.deps, 'aaaaaa01', fakeSanitize);
    expect(r).toEqual({
      ok: true,
      threadId: 'aaaaaa01',
      subject: '수집 누락 원인 문의',
      truncated: false,
      sanitized: true,
      messages: [
        { from: '홍길동 책임 <[사용자]@abz.example>', to: '박민수 <[사용자]@support.example>', date: '2026-11-20', mine: false, body: '수집 서버 [IP주소] 에서 지표가 비어 있습니다.\n원인 확인 부탁드립니다.' },
        { from: '박민수 <[사용자]@support.example>', to: '홍길동 책임 <[사용자]@abz.example>', date: '2026-11-21', mine: true, body: '원인은 에이전트 2.9.4의 알려진 문제입니다.\n2.9.5 패치 파일을 전달드립니다.\n\n[이전 회신 생략]' },
      ],
    });
  });

  it('거르지 못하면 읽지 않은 것으로 한다 — 걸러지지 않은 글은 돌려주지 않는다', async () => {
    const g = fakeGmail({ '/threads/aaaaaa01?format=full': thread });
    const down: MailSanitize = async () => ({ ok: false, code: 'sanitizer-missing', message: '도구 없음' });
    const r = await readThread(g.deps, 'aaaaaa01', down);
    expect(r).toEqual({ ok: false, code: 'sanitizer-missing', message: '도구 없음' });
    expect(JSON.stringify(r)).not.toContain('192.0.2.11');
    // 돌아온 메일 수가 다르면(일부만 걸러졌을 수 있다) 받지 않는다
    const short: MailSanitize = async (input) => ({ ok: true, value: { subject: input.subject, messages: input.messages.slice(1) } });
    expect(await readThread(g.deps, 'aaaaaa01', short)).toMatchObject({ ok: false, code: 'sanitizer-failed' });
  });

  it('메일이 많으면 첫 메일과 최근 것들만, 가리키는 값이 이상하면 부르지 않는다', async () => {
    const many = { messages: Array.from({ length: THREAD_MAX_MESSAGES + 5 }, (_x, i) => msg({ id: `m${i}`, from: HONG, date: `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00+09:00`, text: `메일 ${i}` })) };
    const g = fakeGmail({ '/threads/aaaaaa01?format=full': many });
    const r = await readThread(g.deps, 'aaaaaa01', fakeSanitize);
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.messages.map((m) => m.body)).toEqual(['메일 0', ...Array.from({ length: THREAD_MAX_MESSAGES - 1 }, (_x, i) => `메일 ${i + 6}`)]);
    const bad = fakeGmail({});
    expect(await readThread(bad.deps, '../../etc', fakeSanitize)).toMatchObject({ ok: false, code: 'unknown' });
    expect(bad.calls).toHaveLength(0);
  });
});

describe('본문 뽑기와 인용 걷어내기', () => {
  it('text/plain이 먼저, 없으면 HTML에서 태그와 인용 묶음을 걷는다', () => {
    const html = '<div>확인 결과 전달드립니다.<br>재기동 후 정상입니다.</div><blockquote class="gmail_quote">이전 글</blockquote>';
    expect(extractBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64(html) } }, { mimeType: 'text/plain', body: { data: b64('글 본문') } }] })).toBe('글 본문');
    expect(extractBody({ mimeType: 'text/html', body: { data: b64(html) } })).toBe('확인 결과 전달드립니다.\n재기동 후 정상입니다.\n[이전 회신 생략]');
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('안쪽 글') } }] }, { mimeType: 'application/pdf', filename: 'a.pdf', body: {} }] })).toBe('안쪽 글');
    expect(extractBody({ mimeType: 'application/pdf', body: { data: b64('%PDF') } })).toBe('');
    expect(extractBody(undefined)).toBe('');
  });

  it('머리글 블록·"Original Message"부터는 인용이다 — 전달 메일의 본문은 지킨다', () => {
    const outlook = '확인했습니다.\n\nFrom: 홍길동\nSent: Friday\nTo: 박민수\nSubject: 문의\n\n이전 글';
    expect(normalizeBody(outlook)).toBe('확인했습니다.\n\n[이전 회신 생략]');
    expect(normalizeBody('답변드립니다.\n-----Original Message-----\n이전 글')).toBe('답변드립니다.\n[이전 회신 생략]');
    const korean = '확인했습니다.\n보낸사람: 홍길동\n받는사람: 박민수\n제목: 문의\n\n이전 글';
    expect(normalizeBody(korean)).toBe('확인했습니다.\n[이전 회신 생략]');
    // 전달 메일 — 머리글 블록 아래가 본문이다
    const fwd = '참고 부탁드립니다.\n\nFrom: 홍길동\nSent: Friday\nTo: 박민수\nSubject: 문의\n\n전달한 본문';
    expect(normalizeBody(fwd, 'FW: 문의')).toBe(fwd);
    // 머리글처럼 보여도 두 줄뿐이면 본문이다
    expect(normalizeBody('원인: 설정 누락\n조치: 재기동\n끝')).toBe('원인: 설정 누락\n조치: 재기동\n끝');
  });

  it('">"가 셋 이상 이어진 묶음과 인용 머리 줄을 걷고, 본문의 ">" 한두 줄은 둔다', () => {
    expect(normalizeBody('답변입니다.\nOn Fri, Nov 20, 2026 at 10:00 AM Hong <x> wrote:\n> a\n> b\n> c\n')).toBe('답변입니다.\n[이전 회신 생략]');
    expect(normalizeBody('설정은 아래와 같습니다.\n> collect_retry=3\n끝')).toBe('설정은 아래와 같습니다.\n> collect_retry=3\n끝');
    expect(normalizeBody('')).toBe('');
  });
});
