/**
 * 이메일 템플릿 로더 — 내장 JSON(builtin/) + 오버레이(팀/개인)를 병합하고
 * 프로필 토큰({userName}/{userEmail}/{company})·인사말을 치환해 EmailTemplate로 해석한다.
 * 새 양식 추가 = JSON 파일 1개 (코드 변경 0).
 */
import type { EmailField, EmailTemplate, EmailTemplateData } from './types';
import {
  applyProfileTokens,
  buildClosing,
  buildGreeting,
  loadUserProfile,
  type UserProfile,
} from './profile';
import creInquiry from './builtin/tech-inquiry.json';
import licenseDelivery from './builtin/license-delivery.json';
import installDelivery from './builtin/install-delivery.json';

const BUILTIN_RAW: unknown[] = [creInquiry, licenseDelivery, installDelivery];

export const DEFAULT_TEMPLATE_ID = 'tech-inquiry';

// ── 스키마 검증 ────────────────────────────────────────────────────────────

const FIELD_TYPES = new Set(['text', 'date', 'select', 'textarea']);

export type TemplateValidation =
  | { ok: true; data: EmailTemplateData }
  | { ok: false; error: string };

/** 외부 유입(JSON 파일) 템플릿의 최소 스키마 검증 — 실패 파일은 스킵 대상 */
export function validateTemplateData(raw: unknown): TemplateValidation {
  const fail = (error: string): TemplateValidation => ({ ok: false, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('객체가 아닙니다');
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id.trim()) return fail('id 누락');
  if (typeof t.name !== 'string' || !t.name.trim()) return fail('name 누락');
  if (typeof t.subjectPattern !== 'string') return fail('subjectPattern 누락');
  if (typeof t.hasBody !== 'boolean') return fail('hasBody 누락');
  if (!Array.isArray(t.sections)) return fail('sections 배열 누락');
  for (const section of t.sections) {
    if (!section || typeof section !== 'object') return fail('section이 객체가 아닙니다');
    const s = section as Record<string, unknown>;
    if (typeof s.title !== 'string') return fail('section.title 누락');
    if (!Array.isArray(s.fields)) return fail('section.fields 배열 누락');
    for (const field of s.fields) {
      const f = field as Record<string, unknown>;
      if (!f || typeof f.key !== 'string' || !f.key) return fail('field.key 누락');
      if (typeof f.label !== 'string') return fail(`field(${f.key}).label 누락`);
      if (typeof f.type !== 'string' || !FIELD_TYPES.has(f.type)) {
        return fail(`field(${f.key}).type이 올바르지 않습니다`);
      }
    }
  }
  if (t.bodyPresets !== undefined) {
    if (!Array.isArray(t.bodyPresets) || t.bodyPresets.some((p) => typeof p !== 'string')) {
      return fail('bodyPresets는 문자열 배열이어야 합니다');
    }
  }
  if (t.recipientCc !== undefined) {
    if (!Array.isArray(t.recipientCc) || t.recipientCc.some((c) => typeof c !== 'string')) {
      return fail('recipientCc는 문자열 배열이어야 합니다');
    }
  }
  return { ok: true, data: t as unknown as EmailTemplateData };
}

const BUILTIN: EmailTemplateData[] = BUILTIN_RAW.map((raw) => {
  const v = validateTemplateData(raw);
  if (!v.ok) throw new Error(`내장 템플릿 스키마 오류: ${v.error}`); // 빌드 자산 — 테스트에서 고정
  return v.data;
});

// ── 오버레이 (팀/개인 JSON — G1-3에서 IPC 로드 후 주입) ─────────────────────

let teamOverlays: EmailTemplateData[] = [];
let personalOverlays: EmailTemplateData[] = [];

/** 병합 정책: 팀 > 내장(동일 id 교체 + 신규 허용), 개인은 신규 id만(팀 표준 드리프트 방지) */
export function setTemplateOverlays(team: EmailTemplateData[], personal: EmailTemplateData[]): void {
  teamOverlays = team;
  personalOverlays = personal;
}

function mergedData(): EmailTemplateData[] {
  const byId = new Map<string, EmailTemplateData>();
  for (const b of BUILTIN) byId.set(b.id, b);
  for (const t of teamOverlays) byId.set(t.id, t);
  for (const p of personalOverlays) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

// ── 해석 (프로필 토큰·인사말 주입) ──────────────────────────────────────────

function resolveField(f: EmailField, p: UserProfile): EmailField {
  return {
    ...f,
    default: f.default != null ? applyProfileTokens(f.default, p) : undefined,
    placeholder: f.placeholder != null ? applyProfileTokens(f.placeholder, p) : undefined,
  };
}

function resolveTemplate(data: EmailTemplateData, p: UserProfile): EmailTemplate {
  return {
    ...data,
    greeting: data.greeting != null ? applyProfileTokens(data.greeting, p) : buildGreeting(p),
    closing: data.closing != null ? applyProfileTokens(data.closing, p) : buildClosing(p),
    note: data.note != null ? applyProfileTokens(data.note, p) : undefined,
    subjectPattern: applyProfileTokens(data.subjectPattern, p),
    sections: data.sections.map((s) => ({ ...s, fields: s.fields.map((f) => resolveField(f, p)) })),
    bodyPresets: data.bodyPresets?.map((preset) => applyProfileTokens(preset, p)),
  };
}

/** 병합+해석된 템플릿 목록. profileOverride는 테스트/명시 주입용 — 생략 시 저장된 프로필 */
export function getTemplates(profileOverride?: UserProfile): EmailTemplate[] {
  const profile = profileOverride ?? loadUserProfile();
  return mergedData().map((d) => resolveTemplate(d, profile));
}

export function getTemplate(id: string, profileOverride?: UserProfile): EmailTemplate | undefined {
  const profile = profileOverride ?? loadUserProfile();
  const data = mergedData().find((d) => d.id === id);
  return data ? resolveTemplate(data, profile) : undefined;
}
