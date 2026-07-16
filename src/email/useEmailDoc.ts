import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_TEMPLATE_ID, getTemplate } from './templates';
import type { EmailDocState } from './types';

const KEY = 'tb:email-doc:v1';

/** 템플릿의 기본 필드값 채우기 (date 'today'는 오늘 날짜로) */
function initialValues(templateId: string): Record<string, string> {
  const t = getTemplate(templateId);
  const out: Record<string, string> = {};
  if (!t) return out;
  for (const section of t.sections) {
    for (const field of section.fields) {
      if (field.default === 'today') {
        out[field.key] = todayIso();
      } else if (field.default != null) {
        out[field.key] = field.default;
      }
    }
  }
  return out;
}

// 제목 의미론: doc.subject === undefined → "자동 모드" (렌더 시 subjectPattern에 필드값 실시간 반영).
// 사용자가 제목을 직접 입력하면 수동 고정, 비우면 다시 자동 복귀. (기존 시드 방식은
// 템플릿 선택 시점의 빈 필드로 제목이 고정되어 topic 입력이 반영되지 않던 문제가 있었다)

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadDoc(): EmailDocState {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as EmailDocState;
        if (parsed && typeof parsed.templateId === 'string' && getTemplate(parsed.templateId)) {
          const fieldValues = parsed.fieldValues ?? {};
          return {
            templateId: parsed.templateId,
            fieldValues,
            bodyHtml: parsed.bodyHtml ?? '',
            // subject 없으면 자동 모드 유지 — 렌더 시 패턴에 필드값 실시간 반영
            subject: parsed.subject,
          };
        }
      } catch {
        // ignore
      }
    }
  }
  const fieldValues = initialValues(DEFAULT_TEMPLATE_ID);
  return {
    templateId: DEFAULT_TEMPLATE_ID,
    fieldValues,
    bodyHtml: '',
    subject: undefined, // 자동 모드
  };
}

export interface EmailDocApi {
  doc: EmailDocState;
  /** 본문 에디터 remount 키 — 템플릿 전환/문서 로드 시 증가 */
  bodyKey: number;
  setTemplateId: (id: string) => void;
  setField: (key: string, value: string) => void;
  setBody: (html: string) => void;
  setSubject: (subject: string) => void;
  /** 현재 템플릿+필드로 제목 재생성 */
  regenerateSubject: () => void;
  loadDoc: (next: EmailDocState) => void;
}

export function useEmailDoc(): EmailDocApi {
  const [doc, setDoc] = useState<EmailDocState>(loadDoc);
  const [bodyKey, setBodyKey] = useState(0);
  const warnedQuotaRef = useRef(false);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
      warnedQuotaRef.current = false;
    } catch {
      // QuotaExceededError 등 — 자동 저장만 실패. 작성/복사/발송은 정상 동작.
      if (!warnedQuotaRef.current) {
        warnedQuotaRef.current = true;
        toast.warning('자동 저장 용량 초과 — 큰 이미지는 Gmail에서 직접 첨부를 권장합니다. (작성·복사·발송은 정상)');
      }
    }
  }, [doc]);

  const setTemplateId = useCallback((id: string) => {
    const fieldValues = initialValues(id);
    setDoc({ templateId: id, fieldValues, bodyHtml: '', subject: undefined }); // 자동 모드로 시작
    setBodyKey((k) => k + 1);
  }, []);

  const setField = useCallback((key: string, value: string) => {
    setDoc((d) => ({ ...d, fieldValues: { ...d.fieldValues, [key]: value } }));
  }, []);

  const setBody = useCallback((html: string) => {
    setDoc((d) => ({ ...d, bodyHtml: html }));
  }, []);

  const setSubject = useCallback((subject: string) => {
    // 직접 입력 = 수동 고정, 전부 지우면 자동 모드 복귀
    setDoc((d) => ({ ...d, subject: subject === '' ? undefined : subject }));
  }, []);

  /** 자동 모드 복귀 — 이후 제목은 패턴에 필드값이 실시간 반영 */
  const regenerateSubject = useCallback(() => {
    setDoc((d) => ({ ...d, subject: undefined }));
  }, []);

  const loadDocState = useCallback((next: EmailDocState) => {
    setDoc({ ...next, subject: next.subject }); // undefined = 자동 모드
    setBodyKey((k) => k + 1);
  }, []);

  return {
    doc,
    bodyKey,
    setTemplateId,
    setField,
    setBody,
    setSubject,
    regenerateSubject,
    loadDoc: loadDocState,
  };
}
