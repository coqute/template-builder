import { useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_WIDTH } from '@core/index';

/** Fit(화면 맞춤) / 100%(실제 크기) — 50%·75%는 쓰임이 없어 정리 */
export type ZoomMode = 'fit' | '100';

interface Props {
  html: string;
  emptyHint?: string;
  zoom: ZoomMode;
  /** 미리보기 캔버스 폭(px). 주간보고서 960(기본), 이메일 680 등 */
  canvasWidth?: number;
}

const CANVAS_PADDING_X = 28;

const PREVIEW_SHELL = (body: string, scale: number, width: number) => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
/>
<style>
  html { background: #ffffff; }
  body {
    margin: 0;
    padding: 28px 0 40px;
    background: #ffffff;
    color: #1f2937;
    font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
      'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.55;
    letter-spacing: -0.01em;
    word-break: keep-all;
    overflow-wrap: break-word;
    font-variant-ligatures: none; /* 문법 마커(-> <-)를 원문 그대로 */
    zoom: ${scale};
  }
  .canvas {
    width: ${width}px;
    margin: 0 auto;
    padding: 0 ${CANVAS_PADDING_X}px;
  }
  .canvas p {
    margin: 0 0 12px;
  }
  table {
    border-collapse: collapse;
  }
  td, th {
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  ::selection { background: rgba(99,102,241,0.25); }
</style>
</head>
<body><div class="canvas">${body}</div></body>
</html>`;

/**
 * 이미 실려 있는 미리보기 문서의 내용만 바꾼다 — 문서를 다시 싣지 않는다.
 * 다시 실으면(srcdoc 교체) 글자 하나마다 새 문서가 뜨면서 글꼴을 다시 입히고 빈 화면이 끼어 깜빡인다(v0.28.1에서 실측: 30글자에 30번).
 * 문서가 아직 준비되지 않았으면 false — 부르는 쪽이 문서를 싣는다.
 */
export function patchPreview(doc: Document | null | undefined, inner: string, scale: number, width: number): boolean {
  const canvas = doc?.querySelector<HTMLElement>('.canvas');
  if (!doc?.body || !canvas) return false;
  const zoom = String(scale);
  if (doc.body.style.getPropertyValue('zoom') !== zoom) doc.body.style.setProperty('zoom', zoom);
  const w = `${width}px`;
  if (canvas.style.width !== w) canvas.style.width = w;
  // 같은 내용이면 건드리지 않는다(배율만 바뀐 경우 등) — 바뀐 내용은 한 프레임 안에서 갈아 끼워져 빈 화면이 보이지 않는다
  if (shown.get(canvas) !== inner) {
    canvas.innerHTML = inner;
    shown.set(canvas, inner);
  }
  return true;
}

/** 그 문서에 지금 들어 있는 내용(넣은 원문) — 같은 내용을 다시 쓰지 않으려고 적어 둔다 */
const shown = new WeakMap<Element, string>();

const emptyBody = (hint?: string) =>
  `<div style="color:#94a3b8;text-align:center;padding:48px 12px;font-size:13px;">${hint ?? '입력을 시작하면 이곳에 표가 나타납니다.'}</div>`;

export function HtmlPreview({ html, emptyHint, zoom, canvasWidth = CANVAS_WIDTH }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(canvasWidth);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const fitScale = useMemo(() => {
    const innerWidth = Math.max(containerWidth - 24, 320);
    return Math.min(1, innerWidth / (canvasWidth + CANVAS_PADDING_X * 2));
  }, [containerWidth, canvasWidth]);

  const scale = useMemo(() => {
    switch (zoom) {
      case 'fit':
        return Math.max(0.4, fitScale);
      case '100':
      default:
        return 1;
    }
  }, [zoom, fitScale]);

  /** 지금 보여야 할 것 — 문서가 실린 직후(load)에도 이것으로 맞춘다 */
  const want = useRef({ inner: '', scale: 1, width: canvasWidth });
  /** 미리보기 문서가 실려 있는가 — 실려 있으면 내용만 바꾼다 */
  const ready = useRef(false);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const inner = html || emptyBody(emptyHint);
    want.current = { inner, scale, width: canvasWidth };
    // 문서가 실려 있으면 그 안의 내용만 바꾼다 — 글자를 넣을 때마다 문서를 다시 싣지 않는다(깜빡임의 원인)
    if (ready.current && patchPreview(frame.contentDocument, inner, scale, canvasWidth)) return;
    // 처음이거나 문서에 닿지 못할 때만 문서를 싣는다
    ready.current = false;
    frame.srcdoc = PREVIEW_SHELL(inner, scale, canvasWidth);
  }, [html, emptyHint, scale, canvasWidth]);

  // 문서가 실릴 때(load) — 처음 한 번, 그리고 문서에 닿지 못해 다시 실은 드문 경우.
  // 다시 실리면 contentWindow가 새로 생겨 scrollY가 0이 되므로, 사용자 스크롤을 ref에 적어 두었다가 되돌린다.
  // (v0.28.1부터 글자를 넣는 동안에는 문서를 다시 싣지 않아 스크롤이 그대로 남는다)
  const scrollYRef = useRef(0);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const handleLoad = () => {
      // 문서가 실렸다 — 지금 보여야 할 내용으로 한 번 맞추고(싣는 사이에 바뀌었을 수 있다. 어느 요청의 문서가 실렸는지 믿지 않는다),
      // 이 뒤로는 내용만 바꾼다
      ready.current = patchPreview(frame.contentDocument, want.current.inner, want.current.scale, want.current.width);
      const win = frame.contentWindow;
      if (!win) return;
      // 새 contentWindow에 사용자 스크롤 추적 리스너 부착 (이전 contentWindow는 GC됨)
      win.addEventListener(
        'scroll',
        () => {
          scrollYRef.current = win.scrollY;
        },
        { passive: true },
      );
      // 이전 저장 위치 복원 (최초 로드 시에는 scrollYRef.current=0이라 no-op)
      if (scrollYRef.current > 0) {
        win.scrollTo(0, scrollYRef.current);
      }
    };
    frame.addEventListener('load', handleLoad);
    return () => frame.removeEventListener('load', handleLoad);
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full bg-bg-deep p-3">
      <div className="scrollbar-thin h-full overflow-auto rounded-card border border-rule bg-white shadow-themed">
        <iframe
          ref={ref}
          title="HTML 미리보기"
          sandbox="allow-same-origin"
          className="preview-frame h-full w-full border-0"
        />
      </div>
      <span
        className="pointer-events-none absolute right-5 top-5 rounded-sharp px-2 py-0.5 text-[10px] font-medium tabular-nums"
        style={{ background: 'var(--accent)', color: 'var(--bg)' }}
      >
        {Math.round(scale * 100)}%
      </span>
    </div>
  );
}

interface ZoomToggleProps {
  zoom: ZoomMode;
  onZoomChange: (mode: ZoomMode) => void;
}

const ZOOM_OPTIONS: Array<{ value: ZoomMode; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: '100', label: '100%' },
];

export function ZoomToggle({ zoom, onZoomChange }: ZoomToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="미리보기 줌"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sharp border border-rule p-0.5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {ZOOM_OPTIONS.map((opt) => {
        const active = zoom === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onZoomChange(opt.value)}
            className={[
              'shrink-0 whitespace-nowrap rounded-sharp px-1.5 py-0.5 text-[10px] leading-none transition',
              active ? 'font-semibold' : 'text-fg-soft hover:text-fg',
            ].join(' ')}
            style={active ? { background: 'var(--accent)', color: 'var(--bg)' } : undefined}
            title={opt.value === 'fit' ? '컨테이너에 자동 맞춤' : `고정 ${opt.label} 줌`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
