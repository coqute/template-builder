import { describe, expect, it, vi } from 'vitest';
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
    // 표 안의 셀로 넣는다 — 표 밖의 <td>는 HTML 파서가 태그를 버리고 글자만 남긴다(브라우저도, happy-dom 21도)
    const out = sanitizeBodyHtml('<table><tr><td onclick="evil()" style="position:fixed;color:red">셀</td></tr></table>');
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

// P1-2 공격 벡터 회귀 게이트 — 이후 모든 sanitize 변경은 이 블록 green이 전제
describe('sanitizeBodyHtml 공격 벡터', () => {
  it('img onerror/onload 핸들러 제거', () => {
    const out = sanitizeBodyHtml('<img src="https://a/x.png" onerror="alert(1)" onload="evil()"/>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onload');
    expect(out).toContain('https://a/x.png');
  });

  it('blob: 이미지 src 차단', () => {
    const out = sanitizeBodyHtml('<img src="blob:https://mail.google.com/uuid"/>');
    expect(out).not.toContain('blob:');
  });

  it('iframe/object/embed 제거 (preStrip)', () => {
    const out = sanitizeBodyHtml('<iframe src="https://evil"></iframe><object data="x"></object><embed src="y"/>본문');
    expect(out).not.toMatch(/iframe|object|embed/i);
    expect(out).toContain('본문');
  });

  it('meta/link 태그 제거', () => {
    const out = sanitizeBodyHtml('<meta http-equiv="refresh" content="0;url=https://evil"/><link rel="stylesheet" href="x"/>텍스트');
    expect(out).not.toMatch(/meta|http-equiv|stylesheet/i);
    expect(out).toContain('텍스트');
  });

  it('대소문자 변조 javascript: href 차단', () => {
    const out = sanitizeBodyHtml('<a href="JaVaScRiPt:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('style expression()/-moz-binding/@import 차단', () => {
    const a = sanitizeBodyHtml('<span style="width:expression(alert(1))">t</span>');
    expect(a).not.toContain('expression');
    const b = sanitizeBodyHtml('<span style="color:red;-moz-binding:url(evil)">t</span>');
    expect(b).not.toContain('binding');
    const c = sanitizeBodyHtml('<div style="background:@import url(evil)">t</div>');
    expect(c).not.toContain('@import');
  });

  it('form/input/button은 펼쳐지고 텍스트만 보존', () => {
    const out = sanitizeBodyHtml('<form action="https://evil"><input value="x"/><button>클릭</button>내용</form>');
    expect(out).not.toMatch(/<form|<input|<button|action=/i);
    expect(out).toContain('클릭');
    expect(out).toContain('내용');
  });

  it('img srcset 등 비허용 속성 제거', () => {
    const out = sanitizeBodyHtml('<img src="https://a/x.png" srcset="https://evil 2x" referrerpolicy="unsafe-url"/>');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('referrerpolicy');
  });

  it('HTML 주석 제거', () => {
    const out = sanitizeBodyHtml('<p>앞<!-- secret -->뒤</p>');
    expect(out).not.toContain('secret');
    expect(out).toContain('앞');
    expect(out).toContain('뒤');
  });

  it('onDrop: 초과 크기 이미지 → image-oversize 콜백', () => {
    const onDrop = vi.fn();
    const huge = 'A'.repeat(2_300_000);
    sanitizeBodyHtml(`<img src="data:image/png;base64,${huge}"/>`, onDrop);
    expect(onDrop).toHaveBeenCalledWith('image-oversize');
  });

  it('onDrop: svg/blob 등 차단 스킴 → image-blocked 콜백', () => {
    const onDrop = vi.fn();
    sanitizeBodyHtml('<img src="data:image/svg+xml,<svg/>"/>', onDrop);
    expect(onDrop).toHaveBeenCalledWith('image-blocked');
  });

  it('onDrop: 정상 이미지에는 콜백 미호출', () => {
    const onDrop = vi.fn();
    sanitizeBodyHtml('<img src="data:image/png;base64,AAAA"/><img src="https://a/x.png"/>', onDrop);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('htmlToPlain', () => {
  it('br/li/p를 줄바꿈으로', () => {
    const plain = htmlToPlain('<p>줄1</p><ul><li>항목</li></ul>');
    expect(plain).toContain('줄1');
    expect(plain).toContain('- 항목');
  });
});
