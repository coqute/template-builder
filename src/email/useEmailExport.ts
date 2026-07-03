import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { copyHtmlToClipboard } from '../hooks/useClipboard';
import { getTemplate } from './templates';
import { extractInlineImages } from './draft';
import type { EmailDocState, EmailRenderResult, EmailTemplate } from './types';

const DRAFT_ERROR_MSG: Record<string, string> = {
  'credentials-missing': 'Gmail 자격증명을 찾을 수 없습니다. HTML을 클립보드에 복사했으니 Gmail에 붙여넣으세요.',
  'scope-missing': 'Gmail 권한(스코프)이 부족합니다. HTML을 클립보드에 복사했습니다.',
  'refresh-failed': 'Gmail 인증 만료 — 자격증명을 다시 발급해야 합니다. HTML을 클립보드에 복사했습니다.',
  network: '네트워크 오류 — HTML을 클립보드에 복사했습니다.',
};

function sanitizeFileName(s: string): string {
  return (s || 'email-template').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function buildComposeUrl(template: EmailTemplate | undefined, subject: string): string {
  const to = template?.recipientHint ?? '';
  const cc = template?.recipientCc ?? [];
  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  if (to) params.set('to', to);
  if (cc.length) params.set('cc', cc.join(','));
  if (subject) params.set('su', subject);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

interface ExportApi {
  copyEmailHtml: () => Promise<void>;
  composeInGmail: () => Promise<void>;
  createDraft: () => Promise<void>;
  saveEmail: () => Promise<void>;
  openEmail: () => Promise<void>;
}

export function useEmailExport(
  doc: EmailDocState,
  rendered: EmailRenderResult | undefined,
  loadDoc: (next: EmailDocState) => void,
): ExportApi {
  const copyEmailHtml = useCallback(async () => {
    if (!rendered) {
      toast.error('복사할 내용이 없습니다.');
      return;
    }
    try {
      await copyHtmlToClipboard({ html: rendered.html, plain: rendered.plain });
      toast.success('이메일 HTML 복사 완료 — Gmail 본문에 Ctrl+V 하세요.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '복사 실패');
    }
  }, [rendered]);

  const composeInGmail = useCallback(async () => {
    if (!rendered) {
      toast.error('작성할 내용이 없습니다.');
      return;
    }
    const template = getTemplate(doc.templateId);
    // 본문은 URL로 전달 불가 → 클립보드 복사 후 작성창에서 붙여넣기
    try {
      await copyHtmlToClipboard({ html: rendered.html, plain: rendered.plain });
    } catch {
      // 복사 실패해도 작성창은 연다
    }
    const url = buildComposeUrl(template, rendered.subject);
    if (window.reportApi?.openExternal) {
      await window.reportApi.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
    toast.success('Gmail 작성창을 열었습니다. 본문에 Ctrl+V 하세요. (이미지는 Gmail에서 직접 첨부 권장)');
  }, [doc.templateId, rendered]);

  // Gmail API 임시보관함(draft) 생성 — CID 인라인 이미지 보존. 실패 시 클립보드 폴백.
  const createDraft = useCallback(async () => {
    if (!rendered) {
      toast.error('작성할 내용이 없습니다.');
      return;
    }
    const api = window.reportApi;
    const fallbackCopy = async () => {
      try {
        await copyHtmlToClipboard({ html: rendered.html, plain: rendered.plain });
      } catch {
        // ignore
      }
    };
    if (!api?.createGmailDraft) {
      await fallbackCopy();
      toast.error('데스크탑 모드에서만 임시보관함 생성을 지원합니다. HTML을 클립보드에 복사했습니다.');
      return;
    }
    const template = getTemplate(doc.templateId);
    const { html, images } = extractInlineImages(rendered.html);
    const result = await api.createGmailDraft({
      to: template?.recipientHint ?? '',
      cc: template?.recipientCc?.join(', ') ?? '',
      subject: rendered.subject,
      html,
      images,
    });
    if (result.ok) {
      if (api.openExternal) await api.openExternal('https://mail.google.com/mail/u/0/#drafts');
      toast.success(
        `임시보관함에 생성됨 (이미지 ${images.length}개 인라인 포함) — Gmail에서 검토 후 발송하세요.`,
      );
    } else {
      await fallbackCopy();
      toast.error(DRAFT_ERROR_MSG[result.code] ?? `임시보관함 생성 실패: ${result.message}. HTML을 클립보드에 복사했습니다.`);
    }
  }, [doc.templateId, rendered]);

  const saveEmail = useCallback(async () => {
    if (!window.reportApi?.save) {
      toast.error('데스크탑 모드에서만 파일 저장을 지원합니다.');
      return;
    }
    const defaultName = sanitizeFileName(rendered?.subject ?? doc.templateId);
    const result = await window.reportApi.save({
      defaultName,
      content: JSON.stringify(doc, null, 2),
      kind: 'json',
    });
    if (!result.canceled) toast.success(`저장됨: ${result.filePath}`);
  }, [doc, rendered]);

  const openEmail = useCallback(async () => {
    if (!window.reportApi?.openJson) {
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
      return;
    }
    const result = await window.reportApi.openJson();
    if (result.canceled) return;
    try {
      const parsed = JSON.parse(result.content) as EmailDocState;
      if (!parsed || typeof parsed.templateId !== 'string' || !getTemplate(parsed.templateId)) {
        toast.error('이메일 템플릿 파일 형식이 올바르지 않습니다.');
        return;
      }
      loadDoc({
        templateId: parsed.templateId,
        fieldValues: parsed.fieldValues ?? {},
        bodyHtml: parsed.bodyHtml ?? '',
      });
      toast.success(`불러옴: ${result.filePath}`);
    } catch {
      toast.error('JSON 파싱 실패 — 올바른 템플릿 파일인지 확인하세요.');
    }
  }, [loadDoc]);

  // 반환 객체 신원 안정화 — App의 menu/keyboard effect가 매 렌더마다 재구독하지 않도록
  return useMemo(
    () => ({ copyEmailHtml, composeInGmail, createDraft, saveEmail, openEmail }),
    [copyEmailHtml, composeInGmail, createDraft, saveEmail, openEmail],
  );
}
