export interface DraftInlineImage {
  cid: string;
  mime: string;
  base64: string;
  /** 첨부 파일명 (확장자 포함). 없으면 cid + 확장자 */
  filename?: string;
}

export interface DraftPayload {
  to: string;
  cc?: string; // 쉼표 구분 CC (예: 'sales@vendor.example, biz@vendor.example')
  subject: string;
  html: string; // <img src="cid:ii_…"> 로 치환된 html
  /** 평문 대안 본문 — 있으면 multipart/alternative(text/plain + text/html)로 보낸다 (Gmail 작성창과 같은 구조) */
  text?: string;
  images: DraftInlineImage[];
  draftId?: string; // 있으면 기존 draft 업데이트 (drafts.update), 404/400 시 create 폴백
}

export type GmailDraftErrorCode =
  | 'credentials-missing'
  | 'scope-missing'
  | 'refresh-failed'
  | 'network'
  | 'gmail-error'
  | 'unknown';

export type GmailDraftResult =
  | { ok: true; draftId: string; messageId?: string; updated?: boolean }
  | { ok: false; code: GmailDraftErrorCode; message: string };
