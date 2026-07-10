import { describe, expect, it } from 'vitest';
import { renderEmailHtml, renderEmailPlain, decorateBodyHtml, renderEmail } from '../src/email/render';
import { getTemplate } from '../src/email/templates';
import type { UserProfile } from '../src/email/profile';

// 테스트 전용 프로필 — 인사말·기본값이 프로필에서 파생됨을 함께 검증
const P: UserProfile = { name: '김테스트', email: 'tester@company.example', company: '예시아이티' };

const tech = getTemplate('tech-inquiry', P)!;
const access = getTemplate('access-info', P)!;
const tech = getTemplate('tech-answer', P)!;

describe('renderEmailHtml', () => {
  it('인사말·맺음말은 프로필에서 파생', () => {
    const html = renderEmailHtml(tech, {}, '');
    expect(html).toContain('예시아이티 김테스트입니다');
    expect(html).toContain('감사합니다');
  });

  it('제조사지원: 섹션 rowspan (기본 정보=6, 제조사 정보=5)', () => {
    const html = renderEmailHtml(tech, {}, '');
    expect(html).toMatch(/rowspan="6"[^>]*>기본 정보/);
    expect(html).toMatch(/rowspan="5"[^>]*>제조사 정보/);
  });

  it('subjectOnly 필드(topic)는 표에 안 나옴', () => {
    const html = renderEmailHtml(tech, { topic: '제목용주제' }, '');
    expect(html).not.toContain('제목용주제');
    expect(html).not.toContain('문의 주제(제목용)');
  });

  it('필드값 escape + 표 셀 삽입', () => {
    const html = renderEmailHtml(tech, { customer: 'A&B <test>' }, '');
    expect(html).toContain('A&amp;B &lt;test&gt;');
  });

  it('본문(요청내용) 행에 sanitize된 bodyHtml 삽입', () => {
    const html = renderEmailHtml(tech, {}, '<p>본문<script>alert(1)</script></p>');
    expect(html).toContain('요청내용');
    expect(html).toContain('본문');
    expect(html).not.toContain('<script>');
  });

  it('전부 subjectOnly + hasBody면 표 없이 본문만 (tech-answer)', () => {
    const html = renderEmailHtml(tech, { customer: 'ABZ+', topic: '안내' }, '<p>답변 내용</p>');
    // 고객사/제목 표 행이 없어야 함
    expect(html).not.toMatch(/<td[^>]*>고객사<\/td>/);
    expect(html).toContain('답변 내용');
  });

  it('access-info: bullets 렌더 (표 아님 — 실제 메일과 일치)', () => {
    const html = renderEmailHtml(access, { name: '박민수', company: '예시아이티' }, '');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).not.toContain('<table');
    expect(html).toContain('회사: 예시아이티');
    expect(html).toContain('이름: 박민수');
  });
});

describe('renderEmailPlain', () => {
  it('plain 폴백 — 라벨: 값 + 본문 textContent', () => {
    const plain = renderEmailPlain(tech, { customer: 'ABZ+' }, '<p>본문줄</p>');
    expect(plain).toContain('고객사명: ABZ+');
    expect(plain).toContain('[요청내용]');
    expect(plain).toContain('본문줄');
    expect(plain.startsWith('안녕하세요')).toBe(true);
  });
});

describe('decorateBodyHtml', () => {
  it('td에 border 인라인 스타일 주입', () => {
    const out = decorateBodyHtml('<table><tr><td>셀</td></tr></table>');
    expect(out).toMatch(/<td style="[^"]*border:/);
    expect(out).toContain('border-collapse');
  });

  it('pre에 monospace 인라인 스타일 주입', () => {
    const out = decorateBodyHtml('<pre>cmd</pre>');
    expect(out).toMatch(/monospace/);
    expect(out).toMatch(/white-space:pre-wrap/);
  });

  it('idempotent — 재적용해도 스타일 중복 없음', () => {
    const once = decorateBodyHtml('<table><tr><td>x</td></tr></table>');
    const twice = decorateBodyHtml(once);
    expect(twice).toBe(once);
  });

  it('빈 입력은 그대로', () => {
    expect(decorateBodyHtml('')).toBe('');
  });

  it('기존 td style은 보존하며 border만 추가', () => {
    const out = decorateBodyHtml('<table><tr><td style="color:red">x</td></tr></table>');
    expect(out).toContain('color:red');
    expect(out).toMatch(/border:/);
  });

  it('표 셀은 가로·세로 중앙 정렬 (좌상단 고정 문제 방지)', () => {
    const out = decorateBodyHtml('<table><tr><th>헤더</th><td>셀</td></tr></table>');
    expect(out).toMatch(/<th style="[^"]*text-align:center/);
    expect(out).toMatch(/<th style="[^"]*vertical-align:middle/);
    expect(out).toMatch(/<td style="[^"]*text-align:center/);
    expect(out).toMatch(/<td style="[^"]*vertical-align:middle/);
  });

  it('ul/ol/li에 마커·들여쓰기 인라인 스타일 (메일 클라이언트 견고성)', () => {
    const out = decorateBodyHtml('<ul><li>불릿</li></ul><ol><li>번호</li></ol>');
    expect(out).toMatch(/<ul style="[^"]*list-style:disc/);
    expect(out).toMatch(/<ol style="[^"]*list-style:decimal/);
    expect(out).toMatch(/padding-left:22px/);
    expect(out).toMatch(/<li style="[^"]*margin:2px 0/);
  });

  it('blockquote 좌측 보더 스타일 주입', () => {
    const out = decorateBodyHtml('<blockquote>인용</blockquote>');
    expect(out).toMatch(/<blockquote style="[^"]*border-left:3px solid/);
  });
});

describe('이슈 서두 (bodyLead)', () => {
  it('이슈 입력 시 요청내용 서두에 "이슈 : ..." 굵게, 표 행엔 안 나옴', () => {
    const html = renderEmailHtml(tech, { topic: 'BMS', customer: 'ABZ+', issue: 'CSV 다운로드 실패' }, '<p>상세</p>');
    expect(html).toContain('이슈 : CSV 다운로드 실패');
    expect(html).toMatch(/font-weight:600[^>]*>이슈 : CSV 다운로드 실패|이슈 : CSV 다운로드 실패/);
    // 표 라벨 셀에 '이슈'가 행으로 들어가지 않음 (서두 div로만)
    expect(html).not.toMatch(/<td[^>]*>이슈<\/td>/);
    // 본문 상세도 포함
    expect(html).toContain('상세');
  });

  it('이슈 미입력 시 서두 줄 생략', () => {
    const html = renderEmailHtml(tech, { topic: 'BMS', customer: 'ABZ+' }, '<p>상세</p>');
    expect(html).not.toContain('이슈 :');
  });

  it('plain에도 이슈 서두가 본문 앞에 들어감', () => {
    const plain = renderEmailPlain(tech, { issue: 'CSV 실패' }, '<p>상세</p>');
    const idxIssue = plain.indexOf('이슈 : CSV 실패');
    const idxBody = plain.indexOf('상세');
    expect(idxIssue).toBeGreaterThan(-1);
    expect(idxIssue).toBeLessThan(idxBody);
  });
});

describe('renderEmail — 제목 override', () => {
  it('subjectOverride가 있으면 우선 사용', () => {
    const r = renderEmail(tech, { topic: 'x', customer: 'ABZ+' }, '', 'Re: 직접 입력한 제목');
    expect(r.subject).toBe('Re: 직접 입력한 제목');
  });

  it('subjectOverride가 비어있으면 패턴으로 폴백', () => {
    const r = renderEmail(tech, { topic: 'BMS customField', customer: 'ABZ+' }, '', '   ');
    expect(r.subject).toBe('[예시IT] BMS customField 문의 (ABZ+)');
  });

  it('subjectOverride 미전달 시 패턴', () => {
    const r = renderEmail(tech, { topic: 'BMS customField', customer: 'ABZ+' }, '');
    expect(r.subject).toBe('[예시IT] BMS customField 문의 (ABZ+)');
  });
});

describe('renderEmailHtml — 본문 표 통합', () => {
  it('본문에 표를 넣으면 보존 + 인라인 스타일', () => {
    const html = renderEmailHtml(tech, { customer: 'ABZ+', topic: '안내' }, '<table><tr><td>호스트</td></tr></table>');
    expect(html).toContain('<table');
    expect(html).toContain('호스트');
    expect(html).toMatch(/<td style="[^"]*border:/);
  });
});
