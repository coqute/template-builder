export interface ExtractedImage {
  /** Content-ID — Gmail 작성창과 같은 `ii_` 형식, 초안마다 고유 */
  cid: string;
  mime: string;
  base64: string;
  /** 첨부 파일명 — 확장자 포함 (`image1.png`) */
  filename: string;
}

export interface ExtractResult {
  html: string; // data: 이미지가 cid:ii_… 으로 치환된 html
  images: ExtractedImage[];
}

export interface ExtractOptions {
  /** 테스트용 — CID 생성기 고정 */
  idFactory?: () => string;
}

// 래스터 data 이미지만 (sanitize와 동일 정책 — svg 제외)
const RE_DATA = /^data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,(.+)$/i;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/** `ii_` + 16자리 hex — Gmail이 만드는 인라인 이미지 ID와 같은 모양. 메시지 간 충돌 방지 */
function randomCid(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `ii_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 이메일 html에서 base64 data 이미지를 추출 → cid 참조로 치환.
 * Gmail API multipart/related 의 CID 인라인 이미지로 보내기 위함.
 *
 * Gmail 작성창과 같은 모양으로 만든다 — 그래야 초안을 Gmail에서 다시 열어 크기를 바꾸거나
 * 글을 고친 뒤 보내도 이미지가 첨부와 연결된 채 남는다.
 *  - CID는 초안마다 고유한 `ii_…` (예전 `img1`은 모든 메일이 같은 ID)
 *  - 파일명에 확장자 (`image1.png`) — 확장자 없는 `img1`은 이미지로 인식되지 않을 수 있다
 *  - alt가 비면 파일명 (이미지가 차단된 받는 쪽에서 무엇이었는지 보이게)
 *  - 같은 이미지를 두 번 넣으면 첨부는 하나만
 * http(s) 이미지·svg는 그대로 둔다.
 */
export function extractInlineImages(html: string, opts: ExtractOptions = {}): ExtractResult {
  if (!html || typeof DOMParser === 'undefined') return { html, images: [] };
  const newId = opts.idFactory ?? randomCid;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images: ExtractedImage[] = [];
  const bySrc = new Map<string, ExtractedImage>();
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const m = src.match(RE_DATA);
    if (!m) return;
    let found = bySrc.get(src);
    if (!found) {
      const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
      found = {
        cid: newId(),
        mime,
        base64: m[2],
        filename: `image${images.length + 1}.${EXT[mime] ?? 'png'}`,
      };
      bySrc.set(src, found);
      images.push(found);
    }
    img.setAttribute('src', `cid:${found.cid}`);
    if (!(img.getAttribute('alt') ?? '').trim()) img.setAttribute('alt', found.filename);
  });
  return { html: doc.body.innerHTML, images };
}
