import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  getTemplates,
  setTemplateOverlays,
  validateTemplateData,
} from '../src/email/templates';
import type { EmailTemplateData } from '../src/email/types';
import type { UserProfile } from '../src/email/profile';

const P: UserProfile = { name: '김테스트', email: 't@company.example', company: '예시아이티' };

afterEach(() => setTemplateOverlays([], []));

describe('템플릿 로더', () => {
  it('내장 6종이 전부 로드되고 기본 템플릿이 존재한다', () => {
    const all = getTemplates(P);
    expect(all.map((t) => t.id).sort()).toEqual(
      ['access-info', 'tech-inquiry', 'install-delivery', 'license-delivery', 'partner-account', 'tech-answer'].sort(),
    );
    expect(getTemplate(DEFAULT_TEMPLATE_ID, P)).toBeDefined();
  });

  it('프로필 토큰이 필드 기본값·인사말에 치환된다 (출입정보/파트너계정)', () => {
    const access = getTemplate('access-info', P)!;
    const fields = access.sections[0].fields;
    expect(fields.find((f) => f.key === 'name')?.default).toBe('김테스트');
    expect(fields.find((f) => f.key === 'email')?.default).toBe('t@company.example');
    expect(fields.find((f) => f.key === 'company')?.default).toBe('예시아이티');
    expect(access.greeting).toContain('김테스트');

    const partner = getTemplate('partner-account', P)!;
    expect(partner.sections[0].fields.find((f) => f.key === 'contact')?.default).toBe('김테스트');
  });

  it('제조사지원 회사 표준(수신자·CC·제목 프리픽스)은 프로필과 무관하게 유지', () => {
    const tech = getTemplate('tech-inquiry', P)!;
    expect(tech.recipientHint).toBe('support@vendor.example');
    expect(tech.recipientCc).toEqual(['sales@vendor.example', 'biz@vendor.example']);
    expect(tech.subjectPattern).toContain('[예시IT]');
  });

  it('validateTemplateData — 필수 필드 누락/타입 오류를 거부', () => {
    expect(validateTemplateData(null).ok).toBe(false);
    expect(validateTemplateData({ id: 'x' }).ok).toBe(false); // name/subjectPattern 등 누락
    expect(
      validateTemplateData({
        id: 'x', name: 'X', subjectPattern: 's', hasBody: false,
        sections: [{ title: '', fields: [{ key: 'a', label: 'A', type: 'nope' }] }],
      }).ok,
    ).toBe(false); // 잘못된 field.type
    expect(
      validateTemplateData({
        id: 'x', name: 'X', subjectPattern: 's', hasBody: true,
        sections: [{ title: '', fields: [{ key: 'a', label: 'A', type: 'text' }] }],
      }).ok,
    ).toBe(true);
  });

  it('오버레이 병합: 팀은 동일 id 교체+신규, 개인은 신규 id만', () => {
    const teamCre: EmailTemplateData = {
      id: 'tech-inquiry', name: '팀 개정 제조사지원', subjectPattern: '[예시IT] {topic}', hasBody: true,
      sections: [{ title: '', fields: [{ key: 'topic', label: '주제', type: 'text' }] }],
    };
    const teamNew: EmailTemplateData = {
      id: 'quote-request', name: '견적 요청', subjectPattern: '[예시IT] 견적', hasBody: true, sections: [],
    };
    const personalHijack: EmailTemplateData = {
      id: 'tech-answer', name: '개인 변조 시도', subjectPattern: 'x', hasBody: false, sections: [],
    };
    const personalNew: EmailTemplateData = {
      id: 'my-memo', name: '개인 메모', subjectPattern: 'm', hasBody: true, sections: [],
    };
    setTemplateOverlays([teamCre, teamNew], [personalHijack, personalNew]);

    const all = getTemplates(P);
    expect(all.find((t) => t.id === 'tech-inquiry')?.name).toBe('팀 개정 제조사지원'); // 팀 > 내장
    expect(all.find((t) => t.id === 'quote-request')).toBeDefined(); // 팀 신규
    expect(all.find((t) => t.id === 'tech-answer')?.name).toBe('고객 기술 답변/안내'); // 개인의 내장 교체 차단
    expect(all.find((t) => t.id === 'my-memo')).toBeDefined(); // 개인 신규 허용
  });
});
