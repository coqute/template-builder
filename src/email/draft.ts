export interface ExtractedImage {
  cid: string;
  mime: string;
  base64: string;
}

export interface ExtractResult {
  html: string; // data: 이미지가 cid:imgN 으로 치환된 html
  images: ExtractedImage[];
}

// 래스터 data 이미지만 (sanitize와 동일 정책 — svg 제외)
const RE_DATA = /^data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,(.+)$/i;

/**
 * 이메일 html에서 base64 data 이미지를 추출 → cid:imgN 참조로 치환.
 * Gmail API multipart/related 의 CID 인라인 이미지로 보내기 위함.
 * http(s) 이미지·svg는 그대로 둔다.
 */
export function extractInlineImages(html: string): ExtractResult {
  if (!html || typeof DOMParser === 'undefined') return { html, images: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images: ExtractedImage[] = [];
  let n = 0;
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const m = src.match(RE_DATA);
    if (!m) return;
    n += 1;
    const cid = `img${n}`;
    images.push({ cid, mime: m[1].toLowerCase(), base64: m[2] });
    img.setAttribute('src', `cid:${cid}`);
  });
  return { html: doc.body.innerHTML, images };
}
