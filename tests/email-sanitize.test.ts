import { describe, expect, it } from 'vitest';
import { sanitizeBodyHtml, htmlToPlain } from '../src/email/sanitize';

describe('sanitizeBodyHtml', () => {
  it('<script> 제거', () => {
    expect(sanitizeBodyHtml('<p>안녕<script>alert(1)</script></p>')).not.toContain('script');
  });

  it('onclick 등 이벤트 핸들러 제거', () => {
    const out = sanitizeBodyHtml('<p onclick="evil()">텍스트</p>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('텍스트');
  });

  it('javascript: href 차단, http/mailto 허용', () => {
    expect(sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(sanitizeBodyHtml('<a href="https://example.com">w</a>')).toContain('https://example.com');
    expect(sanitizeBodyHtml('<a href="mailto:a@example.com">m</a>')).toContain('mailto:a@example.com');
  });

  it('data:image(png) 허용, data:text/html 차단', () => {
    const img = sanitizeBodyHtml('<img src="data:image/png;base64,AAAA"/>');
    expect(img).toContain('data:image/png');
    const evil = sanitizeBodyHtml('<img src="data:text/html,<script>1</script>"/>');
    expect(evil).not.toContain('data:text/html');
  });

  it('data:image/svg+xml 차단 (스크립트 실행 가능 SVG)', () => {
    const lit = sanitizeBodyHtml('<img src="data:image/svg+xml,<svg onload=alert(1)></svg>"/>');
    expect(lit).not.toContain('data:image/svg+xml');
    const b64 = sanitizeBodyHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>');
    expect(b64).not.toContain('data:image/svg+xml');
  });

  it('거대 data: 이미지(2.2MB+ 문자)는 차단 — localStorage quota 가드', () => {
    const huge = 'A'.repeat(2_300_000);
    const out = sanitizeBodyHtml(`<img src="data:image/png;base64,${huge}"/>`);
    expect(out).not.toContain('data:image/png');
  });

  it('글머리 기호(ul/ol/li) 보존', () => {
    const out = sanitizeBodyHtml('<ul><li>항목1</li><li>항목2</li></ul>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>항목1</li>');
  });

  it('허용 style(color/font-weight)만 통과, 위험 style 제거', () => {
    const out = sanitizeBodyHtml('<span style="color:red;position:fixed;background:url(x)">t</span>');
    expect(out).toContain('color: red');
    expect(out).not.toContain('position');
    expect(out).not.toContain('url(');
  });

  it('CSS 이스케이프로 위장한 url() 우회 차단 (\\75rl / \\000075rl)', () => {
    const a = sanitizeBodyHtml('<span style="background:\\75rl(http://evil/x)">t</span>');
    expect(a).not.toContain('evil');
    expect(a).not.toMatch(/75rl/i);
    const b = sanitizeBodyHtml('<span style="background:\\000075rl(http://evil/y)">t</span>');
    expect(b).not.toContain('evil');
    // 백슬래시 포함 값은 통째 거부 → background 선언 자체가 빠짐
    expect(b).not.toMatch(/background/i);
  });

  it('colspan 공백 패딩은 정규화 저장 (" 2 " → colspan="2")', () => {
    const out = sanitizeBodyHtml('<table><tr><td colspan=" 2 ">병합</td></tr></table>');
    expect(out).toContain('colspan="2"');
    expect(out).not.toContain('colspan=" 2');
  });

  it('표(table/tr/td/th)는 보존된다', () => {
    const out = sanitizeBodyHtml('<table><thead><tr><th>항목</th></tr></thead><tbody><tr><td>셀텍스트</td></tr></tbody></table>');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>항목</th>');
    expect(out).toContain('<td>셀텍스트</td>');
  });

  it('colspan/rowspan은 숫자만 허용 (CSS 인젝션 차단)', () => {
    const ok = sanitizeBodyHtml('<table><tr><td colspan="2">병합</td></tr></table>');
    expect(ok).toContain('colspan="2"');
    const evil = sanitizeBodyHtml('<table><tr><td colspan="x);background:url(evil)">셀값</td></tr></table>');
    expect(evil).not.toContain('colspan="x');
    expect(evil).not.toContain('url(');
    expect(evil).toContain('셀값'); // 셀 텍스트는 보존
  });

  it('td의 onclick/위험 style은 제거하되 셀은 보존', () => {
    const out = sanitizeBodyHtml('<td onclick="evil()" style="position:fixed;color:red">셀</td>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('position');
    expect(out).toContain('color: red');
    expect(out).toContain('셀');
  });

  it('pre/code 코드 블록 보존', () => {
    const out = sanitizeBodyHtml('<pre>systemctl status collector</pre><code>grep -i x</code>');
    expect(out).toContain('<pre>systemctl status collector</pre>');
    expect(out).toContain('<code>grep -i x</code>');
  });
});

describe('htmlToPlain', () => {
  it('br/li/p를 줄바꿈으로', () => {
    const plain = htmlToPlain('<p>줄1</p><ul><li>항목</li></ul>');
    expect(plain).toContain('줄1');
    expect(plain).toContain('- 항목');
  });
});
