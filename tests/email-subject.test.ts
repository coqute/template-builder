import { describe, expect, it } from 'vitest';
import { buildEmailSubject } from '../src/email/render';
import { getTemplate } from '../src/email/templates';

const tech = getTemplate('tech-inquiry')!;
const access = getTemplate('access-info')!;

describe('buildEmailSubject', () => {
  it('{topic}·{customer} 치환', () => {
    const s = buildEmailSubject(tech, { topic: 'BMS customField 필드값', customer: 'ABZ+' });
    expect(s).toBe('[예시IT] BMS customField 필드값 문의 (ABZ+)');
  });

  it('customer 미입력 시 빈 괄호 제거', () => {
    const s = buildEmailSubject(tech, { topic: 'BMS customField' });
    expect(s).toBe('[예시IT] BMS customField 문의');
    expect(s).not.toContain('()');
  });

  it('전부 미입력이어도 중복 공백 없이 정리', () => {
    const s = buildEmailSubject(tech, {});
    expect(s).toBe('[예시IT] 문의');
    expect(s).not.toMatch(/\s{2,}/);
  });

  it('치환 없는 고정 제목', () => {
    expect(buildEmailSubject(access, {})).toBe('[예시IT] 출입 정보 전달드립니다.');
  });
});
