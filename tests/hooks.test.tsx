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
      company: '예시IT',
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

  it('[B-1] 오버레이 템플릿 id 문서는 로드 전이라도 보존되고 기본 템플릿으로 덮어쓰지 않는다', () => {
    store.set(
      'tb:email-doc:v1',
      JSON.stringify({ templateId: 'team-only', fieldValues: { a: '1' }, bodyHtml: '<p>x</p>', subject: '수동' }),
    );
    const { result } = renderHook(() => useEmailDoc());
    expect(result.current.doc.templateId).toBe('team-only');
    expect(result.current.doc.fieldValues).toEqual({ a: '1' });
    expect(result.current.doc.subject).toBe('수동');
    // persist effect가 원본을 기본 템플릿으로 덮어쓰지 않았는지
    expect(JSON.parse(store.get('tb:email-doc:v1')!).templateId).toBe('team-only');
  });

  it('resetDoc은 현재 템플릿의 기본값으로 필드·본문·제목을 초기화한다', () => {
    const { result } = renderHook(() => useEmailDoc());
    act(() => result.current.setField('topic', 'BMS 문의'));
    act(() => result.current.setBody('<p>x</p>'));
    act(() => result.current.setSubject('수동'));
    act(() => result.current.resetDoc());
    expect(result.current.doc.templateId).toBe('tech-inquiry');
    expect(result.current.doc.fieldValues.topic).toBeUndefined();
    expect(result.current.doc.bodyHtml).toBe('');
    expect(result.current.doc.subject).toBeUndefined();
  });
});

describe('useWeeklyState 문서 교체 되돌리기', () => {
  it('새 주간보고로 초안을 바꾼 뒤 토스트 [되돌리기]로 직전 초안이 돌아온다', async () => {
    store.set('tb:md-draft:v1', '@PREV 2026-09-21 ~ 2026-09-27\n\n# 2026-09-21(월)\n@LOC 파트너사\n');
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    await act(async () => {
      await result.current.loadTemplate();
    });
    // 골격은 빈 자리 — 자리 문구([고객사] 등)를 값으로 넣지 않는다
    expect(result.current.md).toMatch(/^@SUM$/m);
    expect(result.current.md).not.toContain('[고객사]');
    const call = vi.mocked(toast.success).mock.calls.at(-1)!;
    const opts = call[1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('되돌리기');
    act(() => opts.action.onClick());
    expect(result.current.md).toContain('@LOC 파트너사');
  });

  it('빈 초안을 바꿀 때는 되돌리기를 붙이지 않는다', async () => {
    store.set('tb:md-draft:v1', '');
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    await act(async () => {
      await result.current.loadTemplate();
    });
    expect(vi.mocked(toast.success).mock.calls.at(-1)![1]).toBeUndefined();
  });
});

describe('useWeeklyState 파일 저장 정합성', () => {
  type Api = NonNullable<Window['reportApi']>;
  function stubApi(over: Partial<Record<keyof Api, unknown>>): void {
    (window as unknown as { reportApi: unknown }).reportApi = {
      setDirty: vi.fn(),
      save: vi.fn(async () => ({ canceled: true })),
      saveToPath: vi.fn(async (filePath: string) => ({ ok: true, filePath })),
      readPath: vi.fn(async () => ({ ok: true, content: 'X' })),
      ...over,
    };
  }
  const flush = () => act(async () => { await Promise.resolve(); });

  it('[B-5] 덮어쓰기 실패 시 filePath와 savedSnapshot이 쌍으로 해제되어 dirty 불변식이 유지된다', async () => {
    stubApi({ saveToPath: vi.fn(async () => ({ ok: false, error: 'EPERM' })) });
    store.set('tb:md-file-path:v1', 'C:\\r\\w.md');
    store.set('tb:md-draft:v1', 'X');
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    await flush();
    act(() => result.current.setMd('Y'));
    expect(result.current.dirty).toBe(true);
    await act(async () => result.current.saveFile());
    expect(result.current.filePath).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
  });

  it('[B-3] 디스크 파일이 외부에서 바뀌었으면 덮어쓰지 않고 경고한다', async () => {
    const saveToPath = vi.fn(async (filePath: string) => ({ ok: true, filePath }));
    let disk = 'X';
    stubApi({ saveToPath, readPath: vi.fn(async () => ({ ok: true, content: disk })) });
    store.set('tb:md-file-path:v1', 'C:\\r\\w.md');
    store.set('tb:md-draft:v1', 'X');
    const { result } = renderHook(() => useWeeklyState('김테스트'));
    await flush();
    act(() => result.current.setMd('Y'));
    disk = 'Z'; // 앱이 열려 있는 동안 외부 편집
    await act(async () => result.current.saveFile());
    expect(saveToPath).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
    expect(result.current.filePath).toBe('C:\\r\\w.md'); // 연결 유지 — 사용자가 덮어쓰기를 선택할 수 있음
    (window as unknown as { reportApi: unknown }).reportApi = undefined;
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
});
