import { useCallback, useEffect, useMemo, useRef } from 'react';
import { errText } from '../lib/err';
import { toast } from 'sonner';
import { copyHtmlToClipboard } from '../hooks/useClipboard';
import { useGmailDraft } from '../hooks/useGmailDraft';
import { josa } from '../lib/josa';
import { getTemplate } from './templates';
import { extractInlineImages } from './draft';
import { coerceDocState } from './useEmailDoc';
import type { EmailDocState, EmailRenderResult } from './types';

function sanitizeFileName(s: string): string {
  return (s || 'email-template').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

interface ExportApi {
  copyEmailHtml: () => Promise<void>;
  createDraft: () => Promise<void>;
  saveEmail: () => Promise<void>;
  openEmail: () => Promise<void>;
  /** 임시보관함 생성 진행 중 — 버튼 비활성·재진입 차단 (연속 클릭으로 초안이 여러 개 생기지 않도록) */
  busy: boolean;
}

export function useEmailExport(
  doc: EmailDocState,
  rendered: EmailRenderResult | undefined,
  loadDoc: (next: EmailDocState, opts?: { fresh?: boolean }) => void,
  /** 문서 세대(useEmailDoc.docGen) — 다른 메일이 되면 오른다 */
  docGen = 0,
): ExportApi {
  // 초안 추적(같은 메일에서 다시 누르면 갱신)·진행 중 표시·실패 폴백은 주간보고와 같은 훅이 맡는다
  const gmail = useGmailDraft();
  // "다른 메일"이 되는 순간 무조건 무효화 — 템플릿 전환(A→B→A 왕복 포함), 새 이메일(Ctrl+N), 파일 열기.
  // 전에는 템플릿이 바뀔 때만 지워서, 같은 템플릿에서 [새 이메일]로 쓴 다음 메일이
  // 아직 보내지 않은 앞 메일의 Gmail 초안을 덮어썼다("기존 초안을 업데이트했습니다").
  const prevGenRef = useRef(docGen);
  const prevTemplateRef = useRef(doc.templateId);
  const forgetDraft = gmail.forget;
  useEffect(() => {
    if (prevGenRef.current !== docGen || prevTemplateRef.current !== doc.templateId) {
      prevGenRef.current = docGen;
      prevTemplateRef.current = doc.templateId;
      forgetDraft();
    }
  }, [docGen, doc.templateId, forgetDraft]);
  // toast "다시 시도" 액션에서 최신 createDraft를 부르기 위한 자기 참조
  const createDraftRef = useRef<(() => Promise<void>) | null>(null);
  const sendDraft = gmail.createDraft;

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

  // Gmail API 임시보관함(draft) 생성 — CID 인라인 이미지 보존. 실패 시 클립보드 폴백(원래 HTML로).
  const createDraft = useCallback(async () => {
    if (!rendered) {
      toast.error('작성할 내용이 없습니다.');
      return;
    }
    const template = getTemplate(doc.templateId);
    const { html, images } = extractInlineImages(rendered.html);
    await sendDraft(
      {
        key: doc.templateId,
        to: template?.recipientHint ?? '',
        cc: template?.recipientCc?.join(', ') ?? '',
        subject: rendered.subject,
        html,
        // 평문 대안 — Gmail 작성창과 같은 multipart/alternative 구조 (이미지 차단·텍스트 전용 환경)
        text: rendered.plain,
        plain: rendered.plain,
        images,
        copyHtml: rendered.html,
      },
      {
        note: (updated) => ` (이미지 ${images.length}개 인라인${updated ? '' : ' 포함'})`,
        retry: () => void createDraftRef.current?.(),
      },
    );
  }, [doc.templateId, rendered, sendDraft]);
  createDraftRef.current = createDraft;

  const saveEmail = useCallback(async () => {
    if (!window.reportApi?.save) {
      toast.error('파일 저장은 데스크톱 앱에서만 됩니다.');
      return;
    }
    const defaultName = sanitizeFileName(rendered?.subject ?? doc.templateId);
    try {
      const result = await window.reportApi.save({
        defaultName,
        content: JSON.stringify(doc, null, 2),
        kind: 'json',
      });
      if (result.canceled) {
        if (result.error) toast.error(result.error);
        return;
      }
      toast.success(`저장됨: ${result.filePath}`);
    } catch (err) {
      toast.error(`저장 중 오류: ${errText(err)}`);
    }
  }, [doc, rendered]);

  const openEmail = useCallback(async () => {
    if (!window.reportApi?.openJson) {
      toast.error('파일 열기는 데스크톱 앱에서만 됩니다.');
      return;
    }
    try {
      const result = await window.reportApi.openJson();
      if (result.canceled) {
        if (result.error) toast.error(result.error);
        return;
      }
      let parsed: EmailDocState | null;
      try {
        parsed = coerceDocState(JSON.parse(result.content));
      } catch {
        toast.error('JSON 파싱 실패 — 올바른 템플릿 파일인지 확인하세요.');
        return;
      }
      if (!parsed) {
        toast.error('이메일 템플릿 파일 형식이 올바르지 않습니다.');
        return;
      }
      if (!getTemplate(parsed.templateId)) {
        toast.error(`${josa(`템플릿 '${parsed.templateId}'`, '을/를')} 찾을 수 없습니다. 팀/개인 템플릿 폴더를 확인하세요.`);
        return;
      }
      loadDoc(parsed, { fresh: true }); // subject 포함 — 수동 제목이 자동 모드로 강등되지 않도록
      forgetDraft(); // 다른 문서 — 이전 draft에 덮어쓰지 않도록 리셋
      toast.success(`불러옴: ${result.filePath}`);
    } catch (err) {
      toast.error(`파일을 열지 못했습니다: ${errText(err)}`);
    }
  }, [loadDoc]);

  // 반환 객체 신원 안정화 — App의 menu/keyboard effect가 매 렌더마다 재구독하지 않도록
  return useMemo(
    () => ({ copyEmailHtml, createDraft, saveEmail, openEmail, busy: gmail.busy }),
    [copyEmailHtml, createDraft, saveEmail, openEmail, gmail.busy],
  );
}
