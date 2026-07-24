import { describe, expect, it } from 'vitest';
import { buildEmailSubject } from '../src/email/render';
import { getTemplate } from '../src/email/templates';

const tech = getTemplate('tech-inquiry')!;
const license = getTemplate('license-delivery')!;

describe('buildEmailSubject', () => {
  it('제조사지원 제목 = 메일 제목 입력값 그대로 (패턴 래핑 없음)', () => {
    const s = buildEmailSubject(tech, {
      topic: "[예시IT] 웹 점검 '응답 본문 키워드 매칭 실패' 이벤트 문의",
      customer: 'ABZ+', // 제목에 개입하지 않음
    });
    expect(s).toBe("[예시IT] 웹 점검 '응답 본문 키워드 매칭 실패' 이벤트 문의");
  });

  it('접두사 자동 부착 없음 — 입력하지 않으면 [예시IT]도 없음', () => {
    const s = buildEmailSubject(tech, { topic: 'BMS customField 문의' });
    expect(s).toBe('BMS customField 문의');
  });

  it('전부 미입력이어도 중복 공백 없이 정리', () => {
    const s = buildEmailSubject(tech, {});
    expect(s).toBe('');
    expect(s).not.toMatch(/\s{2,}/);
  });

  it('라이선스 전달도 제목 = 입력값 그대로 ({topic})', () => {
    expect(buildEmailSubject(license, { topic: '수집서버 라이선스 전달드립니다.' })).toBe(
      '수집서버 라이선스 전달드립니다.',
    );
  });
});
