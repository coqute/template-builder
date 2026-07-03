import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECENT_FILES,
  fileBaseName,
  loadRecentFiles,
  pushRecentFile,
  removeRecentFile,
} from '../src/lib/recentFiles';

// Node 22+의 실험적 globalThis.localStorage 스텁이 happy-dom 것을 가림 → 인메모리 스텁으로 결정적 테스트
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

describe('recentFiles', () => {
  beforeEach(() => store.clear());

  it('push는 맨 앞 삽입 + 중복 제거 + 상한 5개', () => {
    for (let i = 1; i <= 6; i++) pushRecentFile(`C:\\r\\f${i}.md`);
    const list = loadRecentFiles();
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe('C:\\r\\f6.md');
    expect(list).not.toContain('C:\\r\\f1.md'); // 가장 오래된 것 탈락

    pushRecentFile('C:\\r\\f3.md'); // 기존 항목 재열기 → 맨 앞으로 (중복 없음)
    const again = loadRecentFiles();
    expect(again[0]).toBe('C:\\r\\f3.md');
    expect(again.filter((p) => p === 'C:\\r\\f3.md')).toHaveLength(1);
    expect(again).toHaveLength(MAX_RECENT_FILES);
  });

  it('remove는 해당 경로만 제거, 손상된 저장값은 빈 목록', () => {
    pushRecentFile('C:\\a.md');
    pushRecentFile('C:\\b.md');
    expect(removeRecentFile('C:\\a.md')).toEqual(['C:\\b.md']);

    localStorage.setItem('tb:recent-files:v1', '{broken');
    expect(loadRecentFiles()).toEqual([]);
    localStorage.setItem('tb:recent-files:v1', JSON.stringify([1, 'C:\\ok.md', null]));
    expect(loadRecentFiles()).toEqual(['C:\\ok.md']); // 문자열만 수용
  });

  it('fileBaseName은 윈도우/유닉스 경로 모두 처리', () => {
    expect(fileBaseName('C:\\Users\\user\\weekly.md')).toBe('weekly.md');
    expect(fileBaseName('/home/user/weekly.md')).toBe('weekly.md');
    expect(fileBaseName('weekly.md')).toBe('weekly.md');
  });
});
