/**
 * Gmail 임시보관함 초안 훅(useGmailDraft) — 주간보고와 이메일이 함께 쓴다 (v0.27.0에서 한 벌로).
 * 합치면서 바뀌면 안 되는 것: 주간보고는 HTML만 보낸다(평문 대안 없음), 같은 key는 갱신, 실패하면 클립보드로.
 * 바뀐 것: [다시 시도]는 부르는 쪽이 준 함수를 부른다(그때의 내용으로 다시 만든다).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGmailDraft } from '../src/hooks/useGmailDraft';
import { copyHtmlToClipboard } from '../src/hooks/useClipboard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
import { toast } from 'sonner';

vi.mock('../src/hooks/useClipboard', () => ({ copyHtmlToClipboard: vi.fn(async () => undefined) }));

type Sent = { to: string; cc: string; subject: string; html: string; text?: string; images: unknown[]; draftId?: string };
const setApi = (api: unknown) => {
  (window as unknown as { reportApi: unknown }).reportApi = api;
};
const REQ = { key: '[예시IT] 주간보고', to: 'team@example.com', cc: '', subject: '[예시IT] 주간보고', html: '<table></table>', plain: '표' };

beforeEach(() => {
  vi.clearAllMocks();
  setApi(undefined);
});

describe('Gmail 초안 훅', () => {
  it('같은 key는 기존 초안을 갱신하고, forget() 뒤에는 새로 만든다 — 평문을 주지 않으면 HTML만 보낸다', async () => {
    let n = 0;
    const createGmailDraft = vi.fn(async (p: Sent) => ({ ok: true as const, draftId: p.draftId ?? `D${++n}`, updated: !!p.draftId }));
    setApi({ createGmailDraft, openExternal: vi.fn(async () => ({ ok: true })) });
    const { result } = renderHook(() => useGmailDraft());
    await act(async () => result.current.createDraft(REQ, { note: '' }));
    await act(async () => result.current.createDraft(REQ));
    act(() => result.current.forget());
    await act(async () => result.current.createDraft(REQ));
    await act(async () => result.current.createDraft({ ...REQ, key: '다른 제목' }));
    expect(createGmailDraft.mock.calls.map((c) => c[0].draftId)).toEqual([undefined, 'D1', undefined, undefined]);
    const first = createGmailDraft.mock.calls[0][0];
    expect('text' in first).toBe(false);
    expect(first.images).toEqual([]);
    expect(vi.mocked(toast.success).mock.calls.map((c) => c[0])).toEqual([
      '임시보관함에 생성됨 — Gmail에서 검토 후 발송하세요.',
      '기존 임시보관함 초안을 업데이트했습니다 — Gmail에서 검토 후 발송하세요.',
      '임시보관함에 생성됨 — Gmail에서 검토 후 발송하세요.',
      '임시보관함에 생성됨 — Gmail에서 검토 후 발송하세요.',
    ]);
  });

  it('평문·이미지를 주면 함께 보내고, 알림에 덧붙일 말은 갱신 여부를 받는다', async () => {
    const createGmailDraft = vi.fn(async (p: Sent) => ({ ok: true as const, draftId: 'D1', updated: !!p.draftId }));
    setApi({ createGmailDraft });
    const { result } = renderHook(() => useGmailDraft());
    const images = [{ cid: 'img1', mime: 'image/png', base64: 'AAAA', filename: 'image1.png' }];
    const note = (updated: boolean) => ` (이미지 1개 인라인${updated ? '' : ' 포함'})`;
    await act(async () => result.current.createDraft({ ...REQ, text: '표', images, copyHtml: '<img src="data:…">' }, { note }));
    await act(async () => result.current.createDraft({ ...REQ, text: '표', images }, { note }));
    expect(createGmailDraft.mock.calls[0][0]).toMatchObject({ text: '표', images });
    expect(vi.mocked(toast.success).mock.calls.map((c) => c[0])).toEqual([
      '임시보관함에 생성됨 (이미지 1개 인라인 포함) — Gmail에서 검토 후 발송하세요.',
      '기존 임시보관함 초안을 업데이트했습니다 (이미지 1개 인라인) — Gmail에서 검토 후 발송하세요.',
    ]);
  });

  it('실패하면 HTML을 클립보드에 복사하고, 일시적 실패에만 [다시 시도]를 단다 — 누르면 부르는 쪽이 준 함수가 돈다', async () => {
    const createGmailDraft = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'network', message: 'x' })
      .mockResolvedValueOnce({ ok: false, code: 'scope-missing', message: 'x' });
    setApi({ createGmailDraft });
    const retry = vi.fn();
    const { result } = renderHook(() => useGmailDraft());
    await act(async () => result.current.createDraft({ ...REQ, copyHtml: '<p>원래 본문</p>' }, { retry }));
    expect(copyHtmlToClipboard).toHaveBeenCalledWith({ html: '<p>원래 본문</p>', plain: '표' });
    const [msg, opts] = vi.mocked(toast.error).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(msg).toContain('네트워크 오류');
    expect(opts.action.label).toBe('다시 시도');
    opts.action.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => result.current.createDraft(REQ, { retry }));
    expect(vi.mocked(toast.error).mock.calls[1]).toHaveLength(1);
    expect(copyHtmlToClipboard).toHaveBeenLastCalledWith({ html: '<table></table>', plain: '표' });
  });

  it('데스크톱 앱이 아니면 만들지 않고 클립보드로만 — 진행 중에 다시 부르면 막는다', async () => {
    const { result } = renderHook(() => useGmailDraft());
    await act(async () => result.current.createDraft(REQ));
    expect(copyHtmlToClipboard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);

    let release: (v: unknown) => void = () => undefined;
    const createGmailDraft = vi.fn(() => new Promise((res) => (release = res)));
    setApi({ createGmailDraft });
    const hook = renderHook(() => useGmailDraft());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = hook.result.current.createDraft(REQ);
    });
    await act(async () => hook.result.current.createDraft(REQ));
    expect(createGmailDraft).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('임시보관함 생성이 진행 중입니다.');
    await act(async () => {
      release({ ok: true, draftId: 'D1', updated: false });
      await first;
    });
    expect(hook.result.current.busy).toBe(false);
  });
});
