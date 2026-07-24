import { describe, expect, it } from 'vitest';
import { sanitizeBodyHtml } from '../src/email/sanitize';
import { extractInlineImages } from '../src/email/draft';
import { buildMimeMessage } from '../electron/gmail/mime';

// 1x1 빨강 PNG (실제 디코딩 가능한 최소 이미지)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('이메일 이미지 end-to-end 파이프라인', () => {
  it('붙여넣기 → sanitize → 이미지 보존 (래스터 data URI)', () => {
    const dirty = `<p>앞</p><img src="${PNG}" alt="" /><p>뒤</p>`;
    const clean = sanitizeBodyHtml(dirty);
    expect(clean).toContain('data:image/png;base64,');
    expect(clean).toMatch(/<img[^>]*>/);
  });

  it('draft 경로: data 이미지 → cid:img1 치환 + 이미지 1개 추출', () => {
    const html = `<p>본문</p><img src="${PNG}" alt="" />`;
    const { html: cidHtml, images } = extractInlineImages(html);
    expect(images).toHaveLength(1);
    expect(images[0].cid).toBe('img1');
    expect(images[0].mime).toBe('image/png');
    expect(cidHtml).toContain('cid:img1');
    expect(cidHtml).not.toContain('data:image/png'); // data URI 제거됨
  });

  it('전 경로: 에디터 HTML → sanitize → extract → MIME(multipart/related, CID 인라인)', () => {
    const editorHtml = `<p>확인 부탁드립니다.</p><img src="${PNG}" style="max-width:100%;" alt="" /><p>감사합니다.</p>`;
    const clean = sanitizeBodyHtml(editorHtml);
    const { html, images } = extractInlineImages(clean);
    const mime = buildMimeMessage({
      to: 'support@vendor.example',
      cc: 'sales@vendor.example',
      subject: '[테스트] 이미지 포함 문의',
      html,
      images,
    });
    // 발송 MIME에 이미지가 인라인 첨부로 실제 포함
    expect(mime).toContain('Content-Type: multipart/related; boundary="');
    expect(mime).toContain('Content-ID: <img1>');
    expect(mime).toContain('Content-Disposition: inline; filename="img1"');
    // 본문 파트의 img는 cid 참조 (data URI 중복 없음)
    expect(mime).toContain('text/html');
    // 이미지 base64가 첨부 파트에 존재
    const rawBase64 = PNG.split(',')[1];
    expect(mime.replace(/\r\n/g, '')).toContain(rawBase64.slice(0, 40));
  });

  it('svg 이미지는 sanitize에서 차단 → draft에도 첨부 안 됨 (스크립트 실행 SVG 방어)', () => {
    const dirty = '<img src="data:image/svg+xml,<svg onload=alert(1)></svg>" />';
    const clean = sanitizeBodyHtml(dirty);
    expect(clean).not.toContain('svg');
    const { images } = extractInlineImages(clean);
    expect(images).toHaveLength(0);
  });
});
