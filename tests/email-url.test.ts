import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/email/url';
import { sanitizeBodyHtml } from '../src/email/sanitize';

describe('normalizeUrl — 링크 입력 정규화', () => {
  it('스킴 없는 도메인 → https:// 부착 (핵심: sanitize href 통과)', () => {
    expect(normalizeUrl('www.example.com')).toBe('https://www.example.com');
    expect(normalizeUrl('docs.example.com/guide')).toBe('https://docs.example.com/guide');
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
  });

  it('이미 http/https/mailto는 보존', () => {
    expect(normalizeUrl('https://x.io')).toBe('https://x.io');
    expect(normalizeUrl('http://x.io')).toBe('http://x.io');
    expect(normalizeUrl('mailto:a@example.org')).toBe('mailto:a@example.org');
  });

  it('스킴 없는 이메일 → mailto:', () => {
    expect(normalizeUrl('support@vendor.example')).toBe('mailto:support@vendor.example');
  });

  it('페이지 앵커(#)는 보존', () => {
    expect(normalizeUrl('#section')).toBe('#section');
  });

  it('host:port(호스트명)도 https 부착 — 스킴으로 오분류돼 링크 소실되지 않도록', () => {
    // 회귀 방어: example.com/localhost 는 RFC 스킴 문법상 유효해 스킴으로 오인되던 결함
    expect(normalizeUrl('example.com:8080')).toBe('https://example.com:8080');
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeUrl('collector.example.com:8443/path')).toBe('https://collector.example.com:8443/path');
    expect(normalizeUrl('192.0.2.1:8080')).toBe('https://192.0.2.1:8080');
  });

  it('위험·미지원 스킴은 빈 문자열 반환 → 링크 생성 안 함 (라이브 DOM 오염 차단)', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBe('');
    expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(normalizeUrl('vbscript:msgbox(1)')).toBe('');
    // 그래도 최종 게이트 sanitize는 방어를 유지
    const clean = sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>');
    expect(clean).not.toContain('javascript:');
  });

  it('정규화된 도메인 링크는 sanitize에서 href 생존', () => {
    const url = normalizeUrl('www.example.com'); // https://www.example.com
    const clean = sanitizeBodyHtml(`<a href="${url}">제조사</a>`);
    expect(clean).toContain('href="https://www.example.com"');
  });

  it('빈 입력 → 빈 문자열', () => {
    expect(normalizeUrl('   ')).toBe('');
  });
});
