/**
 * 본문 이미지 크기 규칙 단일 소스 — 편집기(크기 조절)·새니타이저·발송 렌더가 같은 규칙을 쓴다.
 *
 * 크기는 Gmail 작성창과 같은 방식으로 <img>에 직접 남긴다.
 *  - width·height 속성: Outlook(Word 엔진)은 CSS 대신 속성을 본다
 *  - style "width:Npx;max-width:100%;height:auto": Gmail·웹메일은 CSS를 보고, 좁은 화면에서는 비율 유지로 줄어든다
 * 원본 픽셀은 그대로 두고 표시 크기만 바꾼다 (Gmail도 같다 — 원래 크기로 되돌릴 수 있게).
 */

/** Gmail "최적 크기"에 해당하는 폭 — 메일 본문 표준 폭(600px) */
export const BEST_FIT_WIDTH = 600;
/** Gmail "작게"에 해당하는 폭 */
export const SMALL_WIDTH = 200;
/** 끌어서 줄일 수 있는 최소 폭 */
export const MIN_WIDTH = 24;
/** 끌어서 키울 수 있는 최대 폭 — 받는 쪽 화면을 넘는 과대 지정 방지 */
export const MAX_WIDTH = 1600;

export type SizePreset = 'small' | 'best' | 'original';

export const SIZE_PRESETS: ReadonlyArray<{ id: SizePreset; label: string; hint: string }> = [
  { id: 'small', label: '작게', hint: `폭 ${SMALL_WIDTH}px (원본이 더 작으면 원본)` },
  { id: 'best', label: '최적 크기', hint: `메일 본문 폭 ${BEST_FIT_WIDTH}px에 맞춤 (원본이 더 작으면 원본)` },
  { id: 'original', label: '원래 크기', hint: '원본 픽셀 크기' },
];

export function clampWidth(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
}

/** 프리셋 → 표시 폭. natural이 0(아직 디코드 안 됨)이면 기준 폭을 그대로 쓴다 */
export function presetWidth(preset: SizePreset, natural: number): number {
  const n = natural > 0 ? natural : 0;
  switch (preset) {
    case 'small':
      return clampWidth(n ? Math.min(n, SMALL_WIDTH) : SMALL_WIDTH);
    case 'best':
      return clampWidth(n ? Math.min(n, BEST_FIT_WIDTH) : BEST_FIT_WIDTH);
    case 'original':
      return clampWidth(n || BEST_FIT_WIDTH);
  }
}

/** 속성 값 → 양의 정수 픽셀 (아니면 0) */
export function pxValue(v: string | null | undefined): number {
  if (!v) return 0;
  const m = /^\s*(\d{1,4})(?:px)?\s*$/i.exec(v);
  return m ? Number(m[1]) : 0;
}

/** 이미지의 가로세로 비율(높이/폭) — 원본 픽셀 → 속성 → 1 순으로 */
export function aspectOf(img: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight' | 'getAttribute'>): number {
  if (img.naturalWidth > 0 && img.naturalHeight > 0) return img.naturalHeight / img.naturalWidth;
  const w = pxValue(img.getAttribute('width'));
  const h = pxValue(img.getAttribute('height'));
  return w > 0 && h > 0 ? h / w : 1;
}

/** 원본 폭 — 디코드 전이면 속성 폭 */
export function naturalWidthOf(img: Pick<HTMLImageElement, 'naturalWidth' | 'getAttribute'>): number {
  return img.naturalWidth > 0 ? img.naturalWidth : pxValue(img.getAttribute('width'));
}

/** 지금 지정된 표시 폭 (속성 우선, 없으면 0) */
export function declaredWidth(img: Pick<HTMLImageElement, 'getAttribute'>): number {
  return pxValue(img.getAttribute('width'));
}

/** 크기 지정 style — 폭이 없으면 화면 폭을 넘지 않게만 */
export function sizingStyle(width: number): string {
  return width > 0 ? `width:${width}px;max-width:100%;height:auto;` : 'max-width:100%;height:auto;';
}

/** <img>에 표시 폭을 적용 — 속성(width·height)과 style을 함께 맞춘다 */
export function applyImageWidth(img: HTMLImageElement, width: number, aspect = aspectOf(img)): number {
  const w = clampWidth(width);
  const h = Math.max(1, Math.round(w * aspect));
  img.setAttribute('width', String(w));
  img.setAttribute('height', String(h));
  img.setAttribute('style', sizingStyle(w));
  return w;
}

/**
 * 발송·미리보기용 정규화 — 모든 <img>가 위 규칙의 style을 갖게 한다.
 * 폭 속성이 없으면(옛 초안·붙여넣은 이미지) 화면 폭을 넘지 않게만 둔다.
 */
export function normalizeImageSizing(img: Element): void {
  const w = pxValue(img.getAttribute('width'));
  const h = pxValue(img.getAttribute('height'));
  if (!w) img.removeAttribute('width');
  if (!h || !w) img.removeAttribute('height');
  img.setAttribute('style', sizingStyle(w));
}
