import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errText } from '../lib/err';
import type { ExtractedImage } from '../email/draft';
import { copyHtmlToClipboard } from './useClipboard';

/** Gmail 초안 실패 코드 → 안내 문구. 모두 HTML 클립보드 폴백을 전제로 한다 */
export const DRAFT_ERROR_MSG: Record<string, string> = {
  'credentials-missing': 'Gmail 자격증명을 찾을 수 없습니다. HTML을 클립보드에 복사했으니 Gmail에 붙여넣으세요.',
  'scope-missing': 'Gmail 권한(스코프)이 부족합니다. HTML을 클립보드에 복사했습니다.',
  'refresh-failed': 'Gmail 인증 만료 — 자격증명을 다시 발급해야 합니다. HTML을 클립보드에 복사했습니다.',
  network: '네트워크 오류 — HTML을 클립보드에 복사했습니다.',
};

export interface DraftRequest {
  /** 같은 key로 다시 만들면 기존 초안을 업데이트 (중복 생성 방지) */
  key: string;
  to: string;
  cc: string;
  subject: string;
  /** 보낼 본문 — 인라인 이미지가 있으면 `cid:`로 바꾼 것 */
  html: string;
  /** 실패·미지원 시 클립보드 폴백용 plain */
  plain: string;
  /** 평문 대안 — 주면 multipart/alternative로 보낸다(이메일). 안 주면 HTML만 보낸다(주간보고 — 전부터 그랬다) */
  text?: string;
  /** 본문에 박는 인라인 이미지 (없으면 빈 목록) */
  images?: ExtractedImage[];
  /** 클립보드 폴백에 쓸 HTML — 이미지를 `cid:`로 바꾸기 전의 것 (안 주면 html) */
  copyHtml?: string;
}

export interface DraftOptions {
  /** 성공 알림에 덧붙일 말 — ` (받는사람 미설정 …)`, ` (이미지 2개 인라인)` */
  note?: string | ((updated: boolean) => string);
  /** [다시 시도]가 부를 것 — 그때의 내용으로 다시 만든다. 없으면 단추를 달지 않는다 */
  retry?: () => void;
}

/**
 * Gmail 임시보관함 초안 만들기 — 주간보고와 이메일이 함께 쓴다(v0.27.0 전에는 같은 흐름이 두 곳에 따로 있었다).
 * 진행 중 재진입 차단(연속 클릭·키 리핏), 같은 key 재요청은 drafts.update, 실패 시 HTML 클립보드 폴백,
 * 일시적 실패(인증 만료·네트워크)에는 [다시 시도].
 * `forget()`은 "다른 메일이 됐다"를 알린다 — 다음 요청은 key가 같아도 새 초안을 만든다.
 */
export function useGmailDraft(): { busy: boolean; createDraft: (req: DraftRequest, opts?: DraftOptions) => Promise<void>; forget: () => void } {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef<{ key: string; draftId: string } | null>(null);

  const createDraft = useCallback(async (req: DraftRequest, opts: DraftOptions = {}) => {
    // 재진입 차단 — 첫 응답이 오기 전의 호출이 draftId 없이 create를 반복해 초안이 여러 개 생기지 않게
    if (busyRef.current) {
      toast.info('임시보관함 생성이 진행 중입니다.');
      return;
    }
    const fallbackCopy = async () => {
      try {
        await copyHtmlToClipboard({ html: req.copyHtml ?? req.html, plain: req.plain });
      } catch {
        // ignore
      }
    };
    const api = window.reportApi;
    if (!api?.createGmailDraft) {
      await fallbackCopy();
      toast.error('임시보관함 생성은 데스크톱 앱에서만 됩니다. HTML을 클립보드에 복사했습니다.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const prev = draftRef.current?.key === req.key ? draftRef.current.draftId : undefined;
      const result = await api.createGmailDraft({
        to: req.to,
        cc: req.cc,
        subject: req.subject,
        html: req.html,
        ...(req.text !== undefined ? { text: req.text } : {}),
        images: req.images ?? [],
        draftId: prev,
      });
      if (result.ok) {
        draftRef.current = { key: req.key, draftId: result.draftId };
        // 초안은 이미 생성됨 — Gmail 탭 열기 실패는 성공 알림을 막지 않는다
        if (api.openExternal) {
          await api.openExternal('https://mail.google.com/mail/u/0/#drafts').catch(() => undefined);
        }
        const note = typeof opts.note === 'function' ? opts.note(!!result.updated) : (opts.note ?? '');
        toast.success(`${result.updated ? '기존 임시보관함 초안을 업데이트했습니다' : '임시보관함에 생성됨'}${note} — Gmail에서 검토 후 발송하세요.`);
      } else {
        await fallbackCopy();
        const msg = DRAFT_ERROR_MSG[result.code] ?? `임시보관함 생성 실패: ${result.message}. HTML을 클립보드에 복사했습니다.`;
        // 일시적 실패(인증 만료/네트워크)는 재시도 액션 제공
        if (opts.retry && (result.code === 'refresh-failed' || result.code === 'network')) {
          toast.error(msg, { action: { label: '다시 시도', onClick: opts.retry } });
        } else {
          toast.error(msg);
        }
      }
    } catch (err) {
      await fallbackCopy();
      toast.error(`임시보관함 생성 중 오류: ${errText(err)}. HTML을 클립보드에 복사했습니다.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const forget = useCallback(() => {
    draftRef.current = null;
  }, []);

  return useMemo(() => ({ busy, createDraft, forget }), [busy, createDraft, forget]);
}
