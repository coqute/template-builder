import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyHtmlToClipboard } from './useClipboard';

/** Gmail 초안 실패 코드 → 안내 문구 (이메일·주간보고 공용). 모두 HTML 클립보드 폴백을 전제로 한다 */
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
  html: string;
  /** 실패·미지원 시 클립보드 폴백용 plain */
  plain: string;
}

/**
 * 본문 이미지가 없는 문서(주간보고)의 Gmail 임시보관함 초안 생성.
 * 진행 중 재진입 차단(연속 클릭·키 리핏), 같은 key 재요청은 drafts.update, 실패 시 HTML 클립보드 폴백.
 */
export function useGmailDraft(): { busy: boolean; createDraft: (req: DraftRequest) => Promise<void> } {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef<{ key: string; draftId: string } | null>(null);
  const selfRef = useRef<((req: DraftRequest) => Promise<void>) | null>(null);

  const createDraft = useCallback(async (req: DraftRequest) => {
    if (busyRef.current) {
      toast.info('임시보관함 생성이 진행 중입니다.');
      return;
    }
    const fallbackCopy = async () => {
      try {
        await copyHtmlToClipboard({ html: req.html, plain: req.plain });
      } catch {
        // ignore
      }
    };
    const api = window.reportApi;
    if (!api?.createGmailDraft) {
      await fallbackCopy();
      toast.error('데스크탑 모드에서만 임시보관함 생성을 지원합니다. HTML을 클립보드에 복사했습니다.');
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
        images: [],
        draftId: prev,
      });
      if (result.ok) {
        draftRef.current = { key: req.key, draftId: result.draftId };
        if (api.openExternal) {
          await api.openExternal('https://mail.google.com/mail/u/0/#drafts').catch(() => undefined);
        }
        const who = req.to ? '' : ' (받는사람 미설정 — 설정 F1에서 지정)';
        toast.success(
          `${result.updated ? '기존 임시보관함 초안을 업데이트했습니다' : '임시보관함에 생성됨'}${who} — Gmail에서 검토 후 발송하세요.`,
        );
      } else {
        await fallbackCopy();
        const msg = DRAFT_ERROR_MSG[result.code] ?? `임시보관함 생성 실패: ${result.message}. HTML을 클립보드에 복사했습니다.`;
        if (result.code === 'refresh-failed' || result.code === 'network') {
          toast.error(msg, { action: { label: '다시 시도', onClick: () => void selfRef.current?.(req) } });
        } else {
          toast.error(msg);
        }
      }
    } catch (err) {
      await fallbackCopy();
      toast.error(`임시보관함 생성 중 오류: ${err instanceof Error ? err.message : String(err)}. HTML을 클립보드에 복사했습니다.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  selfRef.current = createDraft;

  return useMemo(() => ({ busy, createDraft }), [busy, createDraft]);
}
