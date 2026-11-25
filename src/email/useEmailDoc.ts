import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_TEMPLATE_ID, getTemplate } from './templates';
import { safeSetItem } from '../lib/storage';
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

/**
 * 외부 유입(localStorage·.json 파일) fieldValues 정규화 — 문자열 값만 통과(숫자/불리언은 문자열화).
 * 객체·배열이 섞이면 렌더의 `.trim()`이 던져 미리보기가 백지가 되고 툴바가 전부 비활성되던 경로 차단.
 */
export function normalizeFieldValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * 저장본(localStorage/.json) → 문서 상태. templateId는 문자열이면 **그대로 보존**한다 —
 * 팀/개인 오버레이 템플릿은 앱 기동 후 IPC로 비동기 로드되므로, 이 시점에 getTemplate로 검증하면
 * 오버레이 전용 문서를 "알 수 없음"으로 오판해 기본 템플릿으로 리셋하고 곧바로 원본을 덮어썼다.
 * 미해석 템플릿은 useEmailState가 error로 알리고 헤더 드롭다운에서 다른 템플릿을 고를 수 있다.
 * subject는 비어 있지 않은 문자열만 수동 제목으로 복원(저장 → 열기 왕복 보존).
 */
export function coerceDocState(raw: unknown): EmailDocState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.templateId !== 'string' || !p.templateId.trim()) return null;
  return {
    templateId: p.templateId,
    fieldValues: normalizeFieldValues(p.fieldValues),
    bodyHtml: typeof p.bodyHtml === 'string' ? p.bodyHtml : '',
    subject: typeof p.subject === 'string' && p.subject.trim() ? p.subject : undefined,
  };
}

function freshDoc(templateId: string): EmailDocState {
  return { templateId, fieldValues: initialValues(templateId), bodyHtml: '', subject: undefined }; // 자동 모드
}

function loadDoc(): EmailDocState {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const doc = coerceDocState(JSON.parse(raw));
        if (doc) return doc;
      }
    } catch {
      // 손상된 저장값 — 기본으로
    }
  }
  return freshDoc(DEFAULT_TEMPLATE_ID);
}

export interface EmailDocApi {
  doc: EmailDocState;
  /** 본문 에디터 remount 키 — 템플릿 전환/문서 로드 시 증가 */
  bodyKey: number;
  /**
   * 문서 세대 — "다른 메일"이 될 때(템플릿 전환·새 이메일·파일 열기)마다 오른다.
   * 같은 메일을 고치는 동작(서술 → 문의로 넣기·되돌리기)에서는 오르지 않는다.
   * Gmail 초안 추적과 늦게 눌리는 토스트 액션이 이 값으로 "같은 메일인가"를 가린다.
   */
  docGen: number;
  /** 지금 문서 세대 (토스트 액션처럼 나중에 실행되는 코드용 — 항상 최신 값) */
  gen: () => number;
  setTemplateId: (id: string) => void;
  setField: (key: string, value: string) => void;
  setBody: (html: string) => void;
  setSubject: (subject: string) => void;
  /** 현재 템플릿+필드로 제목 재생성 */
  regenerateSubject: () => void;
  /** 새 문서 — 현재 템플릿의 기본값으로 필드·본문·제목 초기화 (메뉴 [새로 만들기]) */
  resetDoc: () => void;
  /** 문서 교체. `fresh`면 다른 메일로 본다(파일 열기) — 생략하면 같은 메일의 갱신(AI 적용·되돌리기) */
  loadDoc: (next: EmailDocState, opts?: { fresh?: boolean }) => void;
}

export function useEmailDoc(): EmailDocApi {
  const [doc, setDoc] = useState<EmailDocState>(loadDoc);
  const [bodyKey, setBodyKey] = useState(0);
  const genRef = useRef(0);
  const [docGen, setDocGen] = useState(0);
  const bumpGen = useCallback(() => {
    genRef.current += 1;
    setDocGen(genRef.current);
  }, []);
  const gen = useCallback(() => genRef.current, []);
  const warnedQuotaRef = useRef(false);

  useEffect(() => {
    if (safeSetItem(KEY, JSON.stringify(doc))) {
      warnedQuotaRef.current = false;
      return;
    }
    // QuotaExceededError 등 — 자동 저장만 실패. 작성/복사/발송은 정상 동작.
    if (!warnedQuotaRef.current) {
      warnedQuotaRef.current = true;
      toast.warning('자동 저장 용량 초과 — 큰 이미지는 Gmail에서 직접 첨부를 권장합니다. (작성·복사·발송은 정상)');
    }
  }, [doc]);

  const setTemplateId = useCallback(
    (id: string) => {
      setDoc(freshDoc(id));
      setBodyKey((k) => k + 1);
      bumpGen();
    },
    [bumpGen],
  );

  const resetDoc = useCallback(() => {
    setDoc((d) => freshDoc(d.templateId));
    setBodyKey((k) => k + 1);
    bumpGen();
  }, [bumpGen]);

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

  const loadDocState = useCallback(
    (next: EmailDocState, opts: { fresh?: boolean } = {}) => {
      setDoc({ ...next, subject: next.subject }); // undefined = 자동 모드
      setBodyKey((k) => k + 1);
      if (opts.fresh) bumpGen();
    },
    [bumpGen],
  );

  return {
    doc,
    bodyKey,
    docGen,
    gen,
    setTemplateId,
    setField,
    setBody,
    setSubject,
    regenerateSubject,
    resetDoc,
    loadDoc: loadDocState,
  };
}
