import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProfileTokens,
  buildClosing,
  buildGreeting,
  defaultProfile,
  loadUserProfile,
  saveUserProfile,
  type UserProfile,
} from '../src/email/profile';

// Node 22+ localStorage 스텁 가림 대응 — 인메모리 스텁 (recent-files.test.ts와 동일 패턴)
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

const P: UserProfile = { name: '김테스트', email: 't@company.example', company: '예시아이티' };

describe('userProfile', () => {
  beforeEach(() => store.clear());

  it('저장/복원 roundtrip', () => {
    saveUserProfile(P);
    expect(loadUserProfile()).toEqual(P);
  });

  it('프로필 없고 tb:author만 있으면 name으로 마이그레이션', () => {
    store.set('tb:author', '홍길동');
    const p = loadUserProfile();
    expect(p.name).toBe('홍길동');
    expect(p.company).toBe('예시아이티'); // 기본 회사
  });

  it('손상된 저장값은 기본 프로필로', () => {
    store.set('tb:user-profile:v1', '{broken');
    expect(loadUserProfile()).toEqual(defaultProfile());
  });

  it('greeting/closing 파생 + override 우선', () => {
    expect(buildGreeting(P)).toBe('안녕하세요.\n예시아이티 김테스트입니다.');
    expect(buildGreeting({ ...P, name: '' })).toBe('안녕하세요.\n예시아이티입니다.');
    expect(buildGreeting({ name: '', email: '', company: '' })).toBe('안녕하세요.');
    expect(buildGreeting({ ...P, greetingOverride: '커스텀 인사' })).toBe('커스텀 인사');
    expect(buildClosing(P)).toBe('감사합니다.');
    expect(buildClosing({ ...P, closingOverride: '수고하세요.' })).toBe('수고하세요.');
  });

  it('프로필 토큰 치환 — 필드 토큰({topic})은 건드리지 않음', () => {
    const s = applyProfileTokens('{company} {userName} <{userEmail}> — {topic}', P);
    expect(s).toBe('예시아이티 김테스트 <t@company.example> — {topic}');
  });
});
