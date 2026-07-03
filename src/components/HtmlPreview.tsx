import { useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_WIDTH } from '@core/index';

export type ZoomMode = 'fit' | '50' | '75' | '100';

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
      case '50':
        return 0.5;
      case '75':
        return 0.75;
      case '100':
      default:
        return 1;
    }
  }, [zoom, fitScale]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const body = html
      ? PREVIEW_SHELL(html, scale, canvasWidth)
      : PREVIEW_SHELL(
          `<div style="color:#94a3b8;text-align:center;padding:48px 12px;font-size:13px;">${
            emptyHint ?? '입력을 시작하면 이곳에 표가 나타납니다.'
          }</div>`,
          scale,
          canvasWidth,
        );
    frame.srcdoc = body;
  }, [html, emptyHint, scale, canvasWidth]);

  // iframe 스크롤 위치 보존 — srcdoc 교체 시마다 contentWindow가 새로 생성되며
  // scrollY가 0으로 리셋되는 문제를 해결. 사용자 스크롤을 ref에 저장하고 load 직후 복원.
  // 좌측 편집기 입력마다 미리보기가 맨 위로 점프하지 않도록 함.
  const scrollYRef = useRef(0);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const handleLoad = () => {
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
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
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
