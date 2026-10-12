import { describe, expect, it } from 'vitest';
import { extractInlineImages } from '../src/email/draft';

describe('extractInlineImages', () => {
  it('data 이미지를 Gmail형 cid(ii_…)로 치환 + 추출, 빈 alt는 파일명', () => {
    const html = '<p>본문 <img src="data:image/png;base64,AAAABBBB" alt=""></p>';
    const { html: out, images } = extractInlineImages(html);
    expect(images).toHaveLength(1);
    expect(images[0].cid).toMatch(/^ii_[0-9a-f]{16}$/);
    expect(images[0].mime).toBe('image/png');
    expect(images[0].base64).toBe('AAAABBBB');
    expect(images[0].filename).toBe('image1.png');
    expect(out).toContain(`src="cid:${images[0].cid}"`);
    expect(out).toContain('alt="image1.png"');
    expect(out).not.toContain('data:image');
  });

  it('여러 이미지 — 초안마다 고유 cid, 확장자 있는 파일명', () => {
    const html =
      '<img src="data:image/png;base64,AAA"><img src="data:image/jpeg;base64,BBB">';
    let n = 0;
    const { images } = extractInlineImages(html, { idFactory: () => `ii_test${++n}` });
    expect(images.map((i) => i.cid)).toEqual(['ii_test1', 'ii_test2']);
    expect(images.map((i) => i.filename)).toEqual(['image1.png', 'image2.jpg']);
    expect(images[1].mime).toBe('image/jpeg');
    // 같은 초안을 다시 만들 때 cid가 겹치지 않는다
    const again = extractInlineImages('<img src="data:image/png;base64,AAA">');
    expect(again.images[0].cid).not.toBe(extractInlineImages('<img src="data:image/png;base64,AAA">').images[0].cid);
  });

  it('같은 이미지를 두 번 넣으면 첨부는 하나 — 두 img가 같은 cid', () => {
    const { html: out, images } = extractInlineImages(
      '<img src="data:image/png;base64,SAME"><p>x</p><img src="data:image/png;base64,SAME">',
    );
    expect(images).toHaveLength(1);
    expect(out.split(`cid:${images[0].cid}`).length - 1).toBe(2);
  });

  it('지정한 크기(width·height·style)는 그대로 남는다', () => {
    const { html: out } = extractInlineImages(
      '<img src="data:image/png;base64,AAA" width="320" height="100" style="width:320px;max-width:100%;height:auto;">',
    );
    expect(out).toMatch(/width="320"/);
    expect(out).toMatch(/height="100"/);
    expect(out).toContain('width:320px');
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
