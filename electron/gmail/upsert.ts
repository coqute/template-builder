import type { GmailDraftResult } from './types';

const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

export interface UpsertDeps {
  /** forceRefresh=true면 refresh_token으로 강제 갱신 (401 재시도용) */
  getToken(forceRefresh?: boolean): Promise<string>;
  fetchFn?: typeof fetch;
}

/**
 * Gmail draft upsert — draftId가 있으면 drafts.update(PUT), 대상이 사라졌으면(404/400,
 * 사용자가 Gmail에서 발송/삭제한 경우) drafts.create(POST) 폴백. 401은 토큰 강제 갱신 후 1회 재시도.
 */
export async function upsertDraft(
  raw: string,
  draftId: string | undefined,
  deps: UpsertDeps,
): Promise<GmailDraftResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const body = JSON.stringify({ message: { raw } });

  let token = await deps.getToken();
  const send = async (method: 'POST' | 'PUT', url: string) => {
    const call = (t: string) =>
      fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body,
      });
    let res = await call(token);
    if (res.status === 401) {
      token = await deps.getToken(true);
      res = await call(token);
    }
    return res;
  };

  const parseOk = async (res: Response, updated: boolean): Promise<GmailDraftResult> => {
    const json = (await res.json()) as { id?: string; message?: { id?: string } };
    return { ok: true, draftId: json.id ?? draftId ?? '', messageId: json.message?.id, updated };
  };
  const parseErr = async (res: Response): Promise<GmailDraftResult> => {
    const detail = await res.text().catch(() => '');
    return { ok: false, code: 'gmail-error', message: `Gmail API ${res.status}: ${detail.slice(0, 200)}` };
  };

  if (draftId) {
    const res = await send('PUT', `${DRAFTS_URL}/${encodeURIComponent(draftId)}`);
    if (res.ok) return parseOk(res, true);
    if (res.status !== 404 && res.status !== 400) return parseErr(res);
    // 404/400 → 기존 draft 소멸 → create 폴백
  }

  const res = await send('POST', DRAFTS_URL);
  if (!res.ok) return parseErr(res);
  return parseOk(res, false);
}
