import { describe, expect, it } from 'vitest';
import { extractInlineImages } from '../src/email/draft';

describe('extractInlineImages', () => {
  it('data 이미지를 cid로 치환 + 추출', () => {
    const html = '<p>본문 <img src="data:image/png;base64,AAAABBBB" alt=""></p>';
    const { html: out, images } = extractInlineImages(html);
    expect(images).toHaveLength(1);
    expect(images[0].cid).toBe('img1');
    expect(images[0].mime).toBe('image/png');
    expect(images[0].base64).toBe('AAAABBBB');
    expect(out).toContain('src="cid:img1"');
    expect(out).not.toContain('data:image');
  });

  it('여러 이미지 순번 cid 부여', () => {
    const html =
      '<img src="data:image/png;base64,AAA"><img src="data:image/jpeg;base64,BBB">';
    const { images } = extractInlineImages(html);
    expect(images.map((i) => i.cid)).toEqual(['img1', 'img2']);
    expect(images[1].mime).toBe('image/jpeg');
  });

  it('http(s) 이미지는 그대로 둠', () => {
    const html = '<img src="https://example.com/a.png">';
    const { html: out, images } = extractInlineImages(html);
    expect(images).toHaveLength(0);
    expect(out).toContain('https://example.com/a.png');
  });

  it('이미지 0개', () => {
    const { html: out, images } = extractInlineImages('<p>텍스트만</p>');
    expect(images).toHaveLength(0);
    expect(out).toContain('텍스트만');
  });

  it('svg data URI는 추출 대상 아님 (sanitize가 이미 차단하지만 방어)', () => {
    const html = '<img src="data:image/svg+xml;base64,PHN2Zz4=">';
    const { images } = extractInlineImages(html);
    expect(images).toHaveLength(0);
  });
});
