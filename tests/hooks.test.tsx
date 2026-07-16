import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUserProfile } from '../src/hooks/useUserProfile';
import { useDocType } from '../src/hooks/useDocType';
import { useEmailDoc } from '../src/email/useEmailDoc';
import { useWeeklyState } from '../src/hooks/useWeeklyState';

// RTL + React 18 act 환경 플래그
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));
import { toast } from 'sonner';

// Node 22+ localStorage 스텁 가림 대응 — 인메모리 + quota 시뮬레이션
const store = new Map<string, string>();
const quotaKeys = new Set<string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (quotaKeys.has(k)) throw new Error('QuotaExceededError');
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => {
  store.clear();
  quotaKeys.clear();
  vi.clearAllMocks();
});

describe('useUserProfile', () => {
  it('tb:author 마이그레이션 + needsOnboarding', () => {
    store.set('tb:author', '홍길동');
    const { result } = renderHook(() => useUserProfile());
    expect(result.current.profile.name).toBe('홍길동');
    expect(result.current.needsOnboarding).toBe(false);
  });

  it('setProfile은 trim+빈 회사 기본값 보정 후 저장', () => {
    const { result } = renderHook(() => useUserProfile());
    expect(result.current.needsOnboarding).toBe(true);
    act(() => result.current.setProfile({ name: ' 김테스트 ', email: ' t@example.com ', company: '  ' }));
    expect(result.current.profile).toEqual({
      name: '김테스트',
      email: 't@example.com',
      company: '예시아이티',
    });
    expect(JSON.parse(store.get('tb:user-profile:v1')!).name).toBe('김테스트');
  });
});

describe('useDocType', () => {
  it('저장값이 유효 id면 복원, 무효면 첫 모듈로 폴백', () => {
    store.set('tb:doc-type', 'email');
    const a = renderHook(() => useDocType(['weekly', 'email']));
    expect(a.result.current.docType).toBe('email');

    store.set('tb:doc-type', 'ghost');
    const b = renderHook(() => useDocType(['weekly', 'email']));
    expect(b.result.current.docType).toBe('weekly');
  });

  it('무효 id로의 전환은 거부', () => {
    const { result } = renderHook(() => useDocType(['weekly', 'email']));
    act(() => result.current.setDocType('ghost'));
    expect(result.current.docType).toBe('weekly');
    act(() => result.current.setDocType('email'));
    expect(result.current.docType).toBe('email');
  });
});

describe('useEmailDoc', () => {
  it('subject 미지정 = 자동 모드 유지 — 필드 입력이 제목에 실시간 반영', () => {
    store.set(
      'tb:email-doc:v1',
      JSON.stringify({
        templateId: 'tech-inquiry',
        fieldValues: { topic: 'BMS 문의', customer: 'ABZ+' },
        bodyHtml: '',
      }),
    );
    const { result } = renderHook(() => useEmailDoc());
    expect(result.current.doc.subject).toBeUndefined(); // 자동 모드
    // 자동 모드에서 topic 변경 → 렌더 제목이 그대로 따라감 (renderEmail 폴백)
    act(() => result.current.setField('topic', '웹 점검 이벤트'));
    expect(result.current.doc.subject).toBeUndefined();
  });

  it('제목 직접 입력 = 수동 고정, 전부 지우면 자동 복귀, regenerate = 자동 복귀', () => {
    const { result } = renderHook(() => useEmailDoc());
    act(() => result.current.setSubject('직접 쓴 제목'));
    expect(result.current.doc.subject).toBe('직접 쓴 제목');
    act(() => result.current.setSubject(''));
    expect(result.current.doc.subject).toBeUndefined(); // 빈 값 → 자동
    act(() => result.current.setSubject('다시 수동'));
    act(() => result.current.regenerateSubject());
    expect(result.current.doc.subject).toBeUndefined(); // ↻ → 자동
  });

  it('quota 초과 시 toast 경고는 1회만 (작성은 계속)', () => {
    quotaKeys.add('tb:email-doc:v1');
    const { result } = renderHook(() => useEmailDoc());
    act(() => result.current.setBody('<p>a</p>'));
    act(() => result.current.setBody('<p>ab</p>'));
    expect(result.current.doc.bodyHtml).toBe('<p>ab</p>'); // 상태는 정상
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1); // 경고 스팸 없음
  });
});

describe('useWeeklyState', () => {
  it('md 변경은 localStorage에 자동 보존, 파일 미연결이면 dirty=false', () => {
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    act(() => result.current.setMd('@PREV 2026-05-11 ~ 2026-05-17\n@CURRENT 2026-05-18 ~ 2026-05-24\n'));
    expect(store.get('tb:md-draft:v1')).toContain('@PREV 2026-05-11');
    expect(result.current.dirty).toBe(false);
    expect(result.current.filePath).toBeNull();
  });

  it('newDoc은 내용 비우고 파일 연결 해제', () => {
    store.set('tb:md-file-path:v1', 'C:\\r\\w.md');
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    expect(result.current.filePath).toBe('C:\\r\\w.md');
    act(() => result.current.newDoc());
    expect(result.current.md).toBe('');
    expect(result.current.filePath).toBeNull();
    expect(store.get('tb:md-file-path:v1')).toBeUndefined();
  });
});
