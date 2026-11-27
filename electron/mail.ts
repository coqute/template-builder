/**
 * Gmail 읽기 IPC (main 전용) — 읽을 수 있는지·제목만 조회(5분 기억)·고른 스레드 읽기. 호출은 mail-core.ts.
 *
 * - 토큰은 Gmail 초안·달력과 같은 자격증명이고, 그 파일은 읽기만 한다. 범위 검사는 여기서 한다
 *   (gmail/credentials.ts에는 함수를 더하지 않는다).
 * - 본문은 메일을 거르는 도구(mail-sanitize.ts)를 거친 것만 renderer로 간다. 도구가 없으면 메일 기능 전체를 쓸 수 없는 것으로 알린다.
 * - 제목 조회 결과는 5분 기억한다 — 같은 할 일의 창을 다시 열 때마다 부르지 않게. 본문은 기억하지도 저장하지도 않는다.
 */
import { ipcMain } from 'electron';
import { CredError, loadGmailCreds } from './gmail/credentials';
import { getAccessToken, OAuthError } from './gmail/oauth';
import { canReadMail, readThread, searchThreads, type MailDeps } from './mail-core';
import { sanitizerAvailable, sanitizeWithTool } from './mail-sanitize';
import type { MailFailure, MailSearchRequest, MailSearchResult, MailStatus, MailThreadInfo, MailThreadResult } from '../src/planner/types';

const MEMO_MS = 5 * 60 * 1000;
const MEMO_MAX = 30;
const NO_READ = '토큰에 메일을 읽는 권한 범위가 없습니다.';
const NO_SANITIZER = '메일을 거르는 도구(sanitizer)를 찾지 못했습니다 — 걸러지지 않은 메일은 읽지 않습니다.';

const memo = new Map<string, { threads: MailThreadInfo[]; query: string; more: boolean; readAt: number }>();

async function access(): Promise<{ canRead: boolean; deps: MailDeps }> {
  const creds = await loadGmailCreds();
  return { canRead: canReadMail(creds.scope), deps: { getToken: (force) => getAccessToken(creds, force) } };
}

function classify(err: unknown): MailFailure {
  if (err instanceof CredError) return { ok: false, code: 'credentials-missing', message: err.message };
  if (err instanceof OAuthError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : '알 수 없는 오류' };
}

export function registerMailIpc(): void {
  ipcMain.handle('mail:status', async (): Promise<MailStatus> => {
    try {
      const { canRead } = await access();
      if (!canRead) return { canRead: false, reason: 'scope-missing', message: NO_READ };
      // 거르는 도구가 없으면 찾기부터 막는다 — 고른 뒤에야 "읽을 수 없다"고 알리지 않게
      if (!(await sanitizerAvailable())) return { canRead: false, reason: 'sanitizer-missing', message: NO_SANITIZER };
      return { canRead: true };
    } catch (err) {
      return { canRead: false, reason: 'credentials-missing', message: err instanceof Error ? err.message : '알 수 없는 오류' };
    }
  });

  ipcMain.handle('mail:search', async (_evt, raw: MailSearchRequest): Promise<MailSearchResult> => {
    try {
      const req: MailSearchRequest = { who: String(raw?.who ?? ''), words: String(raw?.words ?? ''), since: String(raw?.since ?? '') };
      const key = `${req.who}\u0000${req.words}\u0000${req.since}`;
      const hit = memo.get(key);
      if (!raw?.force && hit && Date.now() - hit.readAt < MEMO_MS) return { ok: true, ...hit, fromCache: true };
      // 자격증명과 범위는 매번 본다(파일 읽기뿐이다)
      const { canRead, deps } = await access();
      if (!canRead) return { ok: false, code: 'scope-missing', message: NO_READ };
      if (!(await sanitizerAvailable())) return { ok: false, code: 'sanitizer-missing', message: NO_SANITIZER };
      const got = await searchThreads(deps, req);
      if (!got.ok) return got;
      const readAt = Date.now();
      if (memo.size >= MEMO_MAX) memo.clear();
      memo.set(key, { threads: got.threads, query: got.query, more: got.more, readAt });
      return { ok: true, threads: got.threads, query: got.query, more: got.more, readAt, fromCache: false };
    } catch (err) {
      return classify(err);
    }
  });

  ipcMain.handle('mail:thread', async (_evt, threadId: string): Promise<MailThreadResult> => {
    try {
      const { canRead, deps } = await access();
      if (!canRead) return { ok: false, code: 'scope-missing', message: NO_READ };
      return await readThread(deps, String(threadId ?? ''), sanitizeWithTool);
    } catch (err) {
      return classify(err);
    }
  });
}
