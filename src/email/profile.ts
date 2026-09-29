/**
 * 사용자 프로필 — 개인 식별 정보를 코드에서 분리하는 단일 소스 (순수 모듈, React 무의존).
 * 템플릿 로더(templates.ts)와 React 훅(hooks/useUserProfile.ts)이 공유한다.
 */

import { site } from '../core/site-config';
export interface UserProfile {
  name: string;
  email: string;
  company: string;
  /** 지정 시 파생 인사말 대신 전체 교체 */
  greetingOverride?: string;
  /** 지정 시 파생 맺음말 대신 전체 교체 */
  closingOverride?: string;
}

/** 회사 기본값 — site-config.ts의 값(실제 값은 그 파일에만) */
export function defaultCompany(): string {
  return site().company;
}
const KEY = 'tb:user-profile:v1';
const LEGACY_AUTHOR_KEY = 'tb:author';

export function defaultProfile(): UserProfile {
  return { name: '', email: '', company: defaultCompany() };
}

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadUserProfile(): UserProfile {
  const raw = safeGet(KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<UserProfile>;
      return {
        name: typeof p.name === 'string' ? p.name : '',
        email: typeof p.email === 'string' ? p.email : '',
        company:
          typeof p.company === 'string' && p.company.trim() && p.company.trim() !== site().legacyCompany
            ? p.company
            : defaultCompany(),
        greetingOverride: typeof p.greetingOverride === 'string' ? p.greetingOverride : undefined,
        closingOverride: typeof p.closingOverride === 'string' ? p.closingOverride : undefined,
      };
    } catch {
      // 손상된 저장값 — 기본으로
    }
  }
  // 마이그레이션: 기존 작성자명(tb:author)을 name 시드로
  const legacyAuthor = safeGet(LEGACY_AUTHOR_KEY);
  if (legacyAuthor?.trim()) {
    return { ...defaultProfile(), name: legacyAuthor.trim() };
  }
  return defaultProfile();
}

export function saveUserProfile(p: UserProfile): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // quota 등 — 저장 실패해도 세션 상태는 유지
  }
}

/** 인사말 — override 우선, 없으면 `안녕하세요.\n{회사} {이름}입니다.` 파생 */
export function buildGreeting(p: UserProfile): string {
  if (p.greetingOverride?.trim()) return p.greetingOverride;
  const who = [p.company, p.name].map((s) => s.trim()).filter(Boolean).join(' ');
  return who ? `안녕하세요.\n${who}입니다.` : '안녕하세요.';
}

export function buildClosing(p: UserProfile): string {
  return p.closingOverride?.trim() ? p.closingOverride : '감사합니다.';
}

/** 템플릿 데이터의 프로필 토큰({userName}/{userEmail}/{company}) 치환.
 *  subjectPattern의 필드 토큰({topic} 등)은 키가 달라 영향 없음. */
export function applyProfileTokens(s: string, p: UserProfile): string {
  return s
    .replace(/\{userName\}/g, p.name)
    .replace(/\{userEmail\}/g, p.email)
    .replace(/\{company\}/g, p.company);
}
