import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_TEMPLATE_ID, getTemplate } from './templates';
import { buildEmailSubject } from './render';
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

/** 템플릿 + 필드값으로 제목 시드 생성 */
function seedSubject(templateId: string, values: Record<string, string>): string {
  const t = getTemplate(templateId);
  return t ? buildEmailSubject(t, values) : '';
}

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
            // 기존 저장본에 subject 없으면 패턴으로 시드 (무손실 마이그레이션)
            subject: parsed.subject ?? seedSubject(parsed.templateId, fieldValues),
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
    subject: seedSubject(DEFAULT_TEMPLATE_ID, fieldValues),
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
    setDoc({ templateId: id, fieldValues, bodyHtml: '', subject: seedSubject(id, fieldValues) });
    setBodyKey((k) => k + 1);
  }, []);

  const setField = useCallback((key: string, value: string) => {
    setDoc((d) => ({ ...d, fieldValues: { ...d.fieldValues, [key]: value } }));
  }, []);

  const setBody = useCallback((html: string) => {
    setDoc((d) => ({ ...d, bodyHtml: html }));
  }, []);

  const setSubject = useCallback((subject: string) => {
    setDoc((d) => ({ ...d, subject }));
  }, []);

  const regenerateSubject = useCallback(() => {
    setDoc((d) => ({ ...d, subject: seedSubject(d.templateId, d.fieldValues) }));
  }, []);

  const loadDocState = useCallback((next: EmailDocState) => {
    setDoc({
      ...next,
      subject: next.subject ?? seedSubject(next.templateId, next.fieldValues ?? {}),
    });
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
