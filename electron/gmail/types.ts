export interface DraftInlineImage {
  cid: string;
  mime: string;
  base64: string;
}

export interface DraftPayload {
  to: string;
  cc?: string; // 쉼표 구분 CC (예: 'sales@vendor.example, biz@vendor.example')
  subject: string;
  html: string; // <img src="cid:imgN"> 로 치환된 html
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
