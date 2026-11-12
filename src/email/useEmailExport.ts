import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyHtmlToClipboard } from '../hooks/useClipboard';
import { DRAFT_ERROR_MSG } from '../hooks/useGmailDraft';
import { josa } from '../lib/josa';
import { getTemplate } from './templates';
import { extractInlineImages } from './draft';
import { coerceDocState } from './useEmailDoc';
import type { EmailDocState, EmailRenderResult } from './types';

function sanitizeFileName(s: string): string {
  return (s || 'email-template').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  // 세션 내 마지막 생성 draft 추적 — 같은 문서에서 반복 클릭 시 update(중복 생성 방지).
  const draftRef = useRef<{ draftId: string; templateId: string } | null>(null);
  // "다른 메일"이 되는 순간 무조건 무효화 — 템플릿 전환(A→B→A 왕복 포함), 새 이메일(Ctrl+N), 파일 열기.
  // 전에는 템플릿이 바뀔 때만 지워서, 같은 템플릿에서 [새 이메일]로 쓴 다음 메일이
  // 아직 보내지 않은 앞 메일의 Gmail 초안을 덮어썼다("기존 초안을 업데이트했습니다").
  const prevGenRef = useRef(docGen);
  const prevTemplateRef = useRef(doc.templateId);
  useEffect(() => {
    if (prevGenRef.current !== docGen || prevTemplateRef.current !== doc.templateId) {
      prevGenRef.current = docGen;
      prevTemplateRef.current = doc.templateId;
      draftRef.current = null;
    }
  }, [docGen, doc.templateId]);
  // toast "다시 시도" 액션에서 최신 createDraft를 부르기 위한 자기 참조
  const createDraftRef = useRef<(() => Promise<void>) | null>(null);
  // 진행 중 플래그 — ref는 동기 재진입 차단, state는 버튼 disabled 표시
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

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

  // Gmail API 임시보관함(draft) 생성 — CID 인라인 이미지 보존. 실패 시 클립보드 폴백.
  const createDraft = useCallback(async () => {
    if (!rendered) {
      toast.error('작성할 내용이 없습니다.');
      return;
    }
    // 재진입 차단 — 첫 응답이 오기 전의 모든 호출이 draftId 없이 create를 반복해 초안이 다중 생성되던 문제
    if (busyRef.current) {
      toast.info('임시보관함 생성이 진행 중입니다.');
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
    busyRef.current = true;
    setBusy(true);
    try {
      const template = getTemplate(doc.templateId);
      const { html, images } = extractInlineImages(rendered.html);
      const prevDraftId =
        draftRef.current && draftRef.current.templateId === doc.templateId
          ? draftRef.current.draftId
          : undefined;
      const result = await api.createGmailDraft({
        to: template?.recipientHint ?? '',
        cc: template?.recipientCc?.join(', ') ?? '',
        subject: rendered.subject,
        html,
        // 평문 대안 — Gmail 작성창과 같은 multipart/alternative 구조 (이미지 차단·텍스트 전용 환경)
        text: rendered.plain,
        images,
        draftId: prevDraftId,
      });
      if (result.ok) {
        draftRef.current = { draftId: result.draftId, templateId: doc.templateId };
        // 초안은 이미 생성됨 — Gmail 탭 열기 실패는 성공 토스트를 막지 않는다
        if (api.openExternal) {
          await api.openExternal('https://mail.google.com/mail/u/0/#drafts').catch(() => undefined);
        }
        toast.success(
          result.updated
            ? `기존 임시보관함 초안을 업데이트했습니다 (이미지 ${images.length}개 인라인) — Gmail에서 검토 후 발송하세요.`
            : `임시보관함에 생성됨 (이미지 ${images.length}개 인라인 포함) — Gmail에서 검토 후 발송하세요.`,
        );
      } else {
        await fallbackCopy();
        const msg =
          DRAFT_ERROR_MSG[result.code] ??
          `임시보관함 생성 실패: ${result.message}. HTML을 클립보드에 복사했습니다.`;
        // 일시적 실패(인증 만료/네트워크)는 재시도 액션 제공
        if (result.code === 'refresh-failed' || result.code === 'network') {
          toast.error(msg, {
            action: { label: '다시 시도', onClick: () => void createDraftRef.current?.() },
          });
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
  }, [doc.templateId, rendered]);
  createDraftRef.current = createDraft;

  const saveEmail = useCallback(async () => {
    if (!window.reportApi?.save) {
      toast.error('데스크탑 모드에서만 파일 저장을 지원합니다.');
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
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
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
      draftRef.current = null; // 다른 문서 — 이전 draft에 덮어쓰지 않도록 리셋
      toast.success(`불러옴: ${result.filePath}`);
    } catch (err) {
      toast.error(`파일을 열지 못했습니다: ${errText(err)}`);
    }
  }, [loadDoc]);

  // 반환 객체 신원 안정화 — App의 menu/keyboard effect가 매 렌더마다 재구독하지 않도록
  return useMemo(
    () => ({ copyEmailHtml, createDraft, saveEmail, openEmail, busy }),
    [copyEmailHtml, createDraft, saveEmail, openEmail, busy],
  );
}
