/**
 * 본문 rich HTML 새니타이즈 — contenteditable/paste로 유입되는 임의 HTML을 allowlist로 정리.
 * DOMParser 트리 워크 (happy-dom 호환).
 */

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U',
  'UL', 'OL', 'LI', 'A', 'IMG', 'CODE', 'PRE', 'H3', 'H4', 'BLOCKQUOTE',
  // 표 — 실제 제조사지원/기술답변 메일 본문이 표를 다용
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
]);

// 태그별 허용 속성
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
  SPAN: new Set(['style']),
  DIV: new Set(['style']),
  P: new Set(['style']),
  TABLE: new Set(['style']),
  THEAD: new Set(['style']),
  TBODY: new Set(['style']),
  TFOOT: new Set(['style']),
  TR: new Set(['style']),
  TD: new Set(['colspan', 'rowspan', 'style']),
  TH: new Set(['colspan', 'rowspan', 'style']),
  CAPTION: new Set(['style']),
  COLGROUP: new Set(['span', 'style']),
  COL: new Set(['span', 'style']),
  PRE: new Set(['style']),
  CODE: new Set(['style']),
};

// 숫자만 허용하는 속성 (colspan/rowspan/span — CSS 인젝션·음수·과대값 차단)
const DIGIT_ATTRS = new Set(['colspan', 'rowspan', 'span']);
const RE_DIGITS = /^\d{1,3}$/;

// style 속성 중 허용할 프로퍼티
const ALLOWED_STYLE_PROPS = new Set([
  'color', 'font-weight', 'font-style', 'text-decoration', 'text-align',
  // 표·코드 블록 표현용
  'border', 'border-collapse', 'border-color', 'padding', 'background', 'background-color',
  'width', 'vertical-align', 'white-space', 'font-family',
]);

function isSafeHref(v: string): boolean {
  const t = v.trim().toLowerCase();
  return t.startsWith('http://') || t.startsWith('https://') || t.startsWith('mailto:') || t.startsWith('#');
}

// data: 이미지 최대 문자 길이 (≈ base64 길이). 약 1.6MB 디코딩 이미지 상당.
// HTML 붙여넣기 경로를 포함한 모든 삽입에서 거대 이미지가 localStorage quota를 터뜨리지 않도록 가드.
const MAX_DATA_IMAGE_CHARS = 2_200_000;

function isSafeImgSrc(v: string): boolean {
  const t = v.trim().toLowerCase();
  if (t.startsWith('http://') || t.startsWith('https://')) return true;
  // 래스터 이미지 data URI만 허용 — svg+xml은 스크립트 실행 가능 문서이므로 차단
  if (/^data:image\/(png|jpe?g|gif|webp|bmp)(;|,)/.test(t)) {
    return v.length <= MAX_DATA_IMAGE_CHARS;
  }
  return false;
}

/** CSS 이스케이프 디코드 (\75 → 'u', \28 → '(' 등) — 위험 함수 우회 탐지용 */
function cssDecode(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex, ch) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch,
  );
}

function sanitizeStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    // 백슬래시(CSS 이스케이프)는 허용 값 문법에 불필요 → 통째 거부 (\75rl(...) 류 우회 차단)
    if (val.includes('\\')) continue;
    // 디코드한 값으로 위험 함수/스킴 차단 (url()/expression/image-set/@import 등)
    const decoded = cssDecode(val).toLowerCase();
    if (/url\s*\(|expression|javascript:|image-set|-moz-binding|@import/i.test(decoded)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function cleanElement(el: Element, doc: Document): Node | null {
  const tag = el.tagName.toUpperCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // 비허용 태그 → 자식만 살려 fragment로 펼침 (텍스트/허용 자식 보존)
    const frag = doc.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      const cleaned = cleanNode(child, doc);
      if (cleaned) frag.appendChild(cleaned);
    }
    return frag;
  }

  const fresh = doc.createElement(tag.toLowerCase());
  const allowed = ALLOWED_ATTRS[tag];
  if (allowed) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) continue;
      if (!allowed.has(name)) continue;
      if (name === 'href' && !isSafeHref(attr.value)) continue;
      if (name === 'src' && !isSafeImgSrc(attr.value)) continue;
      if (DIGIT_ATTRS.has(name)) {
        const v = attr.value.trim();
        if (!RE_DIGITS.test(v)) continue;
        fresh.setAttribute(name, v); // 정규화된 정수만 저장 (공백 패딩 제거)
        continue;
      }
      if (name === 'style') {
        const s = sanitizeStyle(attr.value);
        if (s) fresh.setAttribute('style', s);
        continue;
      }
      fresh.setAttribute(name, attr.value);
    }
  }
  if (tag === 'A') fresh.setAttribute('target', '_blank');

  for (const child of Array.from(el.childNodes)) {
    const cleaned = cleanNode(child, doc);
    if (cleaned) fresh.appendChild(cleaned);
  }
  return fresh;
}

function cleanNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent ?? ''); // text
  if (node.nodeType === 1) return cleanElement(node as Element, doc);
  return null; // comment 등 제거
}

/** 파싱 전 script/style 등 실행성 태그를 선제거 — DOMParser가 스크립트를 실행하는 환경(테스트 등) 방어 */
function preStrip(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(?:script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '');
}

export function sanitizeBodyHtml(dirty: string): string {
  if (!dirty) return '';
  const pre = preStrip(dirty);
  if (typeof DOMParser === 'undefined') {
    // 비브라우저 폴백 — 태그 전부 제거(보수적)
    return pre.replace(/<[^>]*>/g, '');
  }
  const doc = new DOMParser().parseFromString(`<body>${pre}</body>`, 'text/html');
  const body = doc.body;
  const out = doc.createElement('div');
  for (const child of Array.from(body.childNodes)) {
    const cleaned = cleanNode(child, doc);
    if (cleaned) out.appendChild(cleaned);
  }
  return out.innerHTML;
}

/** 본문 HTML → 평문 (plain 폴백용) */
export function htmlToPlain(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '').trim();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // li/p/div/br를 줄바꿈으로
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('li').forEach((li) => {
    li.prepend('- ');
    li.append('\n');
  });
  // 표: 셀은 탭, 행은 줄바꿈으로 구분
  doc.querySelectorAll('td,th').forEach((c) => c.append('\t'));
  doc.querySelectorAll('tr').forEach((r) => r.append('\n'));
  doc.querySelectorAll('p,div').forEach((p) => p.append('\n'));
  return (doc.body.textContent ?? '')
    .replace(/\t\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
