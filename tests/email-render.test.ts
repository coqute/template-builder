import { describe, expect, it } from 'vitest';
import { renderEmailHtml, renderEmailPlain, decorateBodyHtml, renderEmail } from '../src/email/render';
import { sanitizeBodyHtml } from '../src/email/sanitize';
import { getTemplate } from '../src/email/templates';
import type { UserProfile } from '../src/email/profile';

// 테스트 전용 프로필 — 인사말·기본값이 프로필에서 파생됨을 함께 검증
const P: UserProfile = { name: '김테스트', email: 'tester@company.example', company: '예시아이티' };

const tech = getTemplate('tech-inquiry', P)!;
const install = getTemplate('install-delivery', P)!;

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

  it('설치파일 전달(bodyOnly): 표 없이 도입문장+본문만', () => {
    const html = renderEmailHtml(
      install,
      { intro: '요청주신 설치파일 전달드립니다.' },
      '<p>제조사 수집서버 설치파일 전달 드립니다.<br/>- 다운링크 : https://x</p>',
    );
    expect(html).not.toContain('<table'); // 표 없음
    expect(html).toContain('요청주신 설치파일 전달드립니다.'); // 도입 문장
    expect(html).toContain('제조사 수집서버 설치파일 전달 드립니다.'); // 본문
    // 순서: 인사말 → 도입 → 본문 → 맺음말
    expect(html.indexOf('요청주신')).toBeLessThan(html.indexOf('다운링크'));
  });

  it('설치파일 전달: bodyPresets 제품별 전달 문구 6종 존재', () => {
    expect(install.bodyPresets?.length).toBe(6);
    expect(install.bodyPresets?.some((p) => p.includes('수집서버 설치파일'))).toBe(true);
    expect(install.bodyPresets?.some((p) => p.includes('서버모니터링 에이전트'))).toBe(true);
    expect(install.bodyPresets?.some((p) => p.includes('MariaDB'))).toBe(true);
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
  it('td에 border 인라인 스타일 주입 + 표는 본문 전폭(width:100%)', () => {
    const out = decorateBodyHtml('<table><tr><td>셀</td></tr></table>');
    expect(out).toMatch(/<td style="[^"]*border:/);
    expect(out).toContain('border-collapse');
    expect(out).toMatch(/<table style="[^"]*width:100%/);
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

  it('링크(a)에 색·밑줄 인라인 스타일 주입 (클라이언트 편차 없이 링크로 보이도록)', () => {
    const out = decorateBodyHtml('<a href="https://example.com">제조사</a>');
    expect(out).toMatch(/<a[^>]*style="[^"]*color:#2563eb/);
    expect(out).toMatch(/<a[^>]*style="[^"]*text-decoration:underline/);
    expect(out).toContain('href="https://example.com"');
  });

  it('href 없는 <a>는 스타일 미적용 (위험 스킴 제거 후 가짜 파란 링크 방지)', () => {
    // sanitize가 javascript: href를 제거하면 <a target="_blank">텍스트</a>만 남는데
    // 여기에 링크 스타일을 칠하면 클릭되는 것처럼 보이는 가짜 링크가 됨 → 제외
    const out = decorateBodyHtml('<a target="_blank">결제</a>');
    expect(out).not.toMatch(/color:#2563eb/);
    expect(out).not.toMatch(/text-decoration:underline/);
  });

  it('코드 블록: <, >, & 포함 명령이 보존 (escape된 입력을 pre가 그대로 표시)', () => {
    // 에디터 onInsertCode는 escape 후 삽입 → 렌더 단계에서 텍스트가 소실되지 않아야 함.
    // 대비: <logfile>를 escape 없이 넣으면 태그로 파싱돼 sanitize에서 통째 소실되던 버그.
    const escaped = '<pre>java -jar a.jar &gt; out 2&gt;&amp;1 &amp;&amp; tail -f &lt;logfile&gt;</pre>';
    const clean = sanitizeBodyHtml(escaped);
    const out = decorateBodyHtml(clean);
    // pre 보존 + monospace 스타일
    expect(out).toMatch(/<pre style="[^"]*monospace/);
    // 렌더된 텍스트(디코드) 기준 특수문자 보존 — 파싱 소실 없음
    const plain = new DOMParser().parseFromString(out, 'text/html').body.textContent ?? '';
    expect(plain).toContain('2>&1');
    expect(plain).toContain('<logfile>');
    expect(plain).toContain('&& tail -f');
  });

  it('코드 블록 회귀 방어: <...>를 escape 없이 넣으면 소실됨 (버그 재현 — escape 필수 근거)', () => {
    // escape하지 않은 경우 sanitize가 <logfile>를 비허용 태그로 보고 제거 → 데이터 손실
    const unescaped = '<pre>tail -f <logfile></pre>';
    const clean = sanitizeBodyHtml(unescaped);
    const plain = new DOMParser().parseFromString(clean, 'text/html').body.textContent ?? '';
    expect(plain).not.toContain('logfile'); // 소실 확인 → onInsertCode의 escape가 필요한 이유
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
    const plain = renderEmailPlain(tech, { issue: 'CSV 실패' }, '<p>본문상세설명</p>');
    const idxIssue = plain.indexOf('이슈 : CSV 실패');
    const idxBody = plain.indexOf('본문상세설명');
    expect(idxIssue).toBeGreaterThan(-1);
    expect(idxIssue).toBeLessThan(idxBody);
  });
});

describe('제조사지원 실측 형식 (도입 문장 · 표 헤더)', () => {
  it('도입 문장은 인사말 아래·표 위에 문단으로, 표에는 안 나옴', () => {
    const html = renderEmailHtml(
      tech,
      { intro: '제트플러스 지원 중 개선 요청사항이 있어 메일 드립니다.', customer: '제트플러스' },
      '',
    );
    expect(html).toContain('제트플러스 지원 중 개선 요청사항이 있어 메일 드립니다.');
    const idxIntro = html.indexOf('제트플러스 지원 중');
    const idxTable = html.indexOf('<table');
    expect(idxIntro).toBeLessThan(idxTable); // 표 앞
    // 도입 문장은 표 행(라벨 셀)으로는 안 나옴
    expect(html).not.toMatch(/<td[^>]*>도입 문장<\/td>/);
  });

  it('도입 문장 미입력 시 문단 생략', () => {
    const html = renderEmailHtml(tech, { customer: '제트플러스' }, '');
    expect(html).not.toContain('도입 문장');
  });

  it('표 최상단에 [구분 | 상세내용] 헤더 행', () => {
    const html = renderEmailHtml(tech, { customer: '제트플러스' }, '');
    expect(html).toContain('구분');
    expect(html).toContain('상세내용');
    const idxHeader = html.indexOf('상세내용');
    const idxFirstField = html.indexOf('요청일자');
    expect(idxHeader).toBeLessThan(idxFirstField); // 헤더가 첫 필드보다 위
  });

  it('계약 유형에 "계약" 옵션 존재', () => {
    const opts = tech.sections
      .flatMap((s) => s.fields)
      .find((f) => f.key === 'contractType')?.options;
    expect(opts).toContain('계약');
  });

  it('문의 제품은 자유 입력(text) + 추천 옵션', () => {
    const product = tech.sections.flatMap((s) => s.fields).find((f) => f.key === 'product');
    expect(product?.type).toBe('text');
    expect(product?.options).toContain('이벤트');
  });
});

describe('renderEmail — 제목 override', () => {
  it('subjectOverride가 있으면 우선 사용', () => {
    const r = renderEmail(tech, { topic: 'x', customer: 'ABZ+' }, '', 'Re: 직접 입력한 제목');
    expect(r.subject).toBe('Re: 직접 입력한 제목');
  });

  it('subjectOverride가 비어있으면 메일 제목 입력값 그대로 폴백', () => {
    const r = renderEmail(tech, { topic: 'BMS customField 문의', customer: 'ABZ+' }, '', '   ');
    expect(r.subject).toBe('BMS customField 문의');
  });

  it('subjectOverride 미전달 시 메일 제목 입력값 그대로', () => {
    const r = renderEmail(tech, { topic: 'BMS customField 문의', customer: 'ABZ+' }, '');
    expect(r.subject).toBe('BMS customField 문의');
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
