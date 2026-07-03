import { describe, expect, it, vi } from 'vitest';
import { upsertDraft } from '../electron/gmail/upsert';

const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('upsertDraft', () => {
  it('draftId 없으면 POST create만 호출', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(200, { id: 'd1', message: { id: 'm1' } }));
    const r = await upsertDraft('RAW', undefined, { getToken: async () => 'tok', fetchFn });
    expect(r).toEqual({ ok: true, draftId: 'd1', messageId: 'm1', updated: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(DRAFTS_URL);
    expect(fetchFn.mock.calls[0][1].method).toBe('POST');
  });

  it('draftId 있으면 PUT update — create 미호출', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes(200, { id: 'd1', message: { id: 'm2' } }));
    const r = await upsertDraft('RAW', 'd1', { getToken: async () => 'tok', fetchFn });
    expect(r).toEqual({ ok: true, draftId: 'd1', messageId: 'm2', updated: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(`${DRAFTS_URL}/d1`);
    expect(fetchFn.mock.calls[0][1].method).toBe('PUT');
  });

  it('update 404(발송/삭제된 draft) → create 폴백', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonRes(200, { id: 'd2', message: { id: 'm3' } }));
    const r = await upsertDraft('RAW', 'dead', { getToken: async () => 'tok', fetchFn });
    expect(r).toEqual({ ok: true, draftId: 'd2', messageId: 'm3', updated: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1].method).toBe('POST');
  });

  it('401 → 토큰 강제 갱신 후 1회 재시도', async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(401, {}))
      .mockResolvedValueOnce(jsonRes(200, { id: 'd1' }));
    const r = await upsertDraft('RAW', undefined, { getToken, fetchFn });
    expect(r.ok).toBe(true);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });

  it('update가 500이면 create 폴백 없이 에러 반환', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await upsertDraft('RAW', 'd1', { getToken: async () => 'tok', fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('gmail-error');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
