import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bold, Code, Image as ImageIcon, Italic, Link2, List, ListOrdered, Table, Trash2, Underline } from 'lucide-react';
import { sanitizeBodyHtml } from '../sanitize';
import { normalizeUrl } from '../url';
import { escapeHtml } from '../../lib/html';
import {
  MAX_WIDTH,
  MIN_WIDTH,
  SIZE_PRESETS,
  applyImageWidth,
  aspectOf,
  clampWidth,
  declaredWidth,
  naturalWidthOf,
  presetWidth,
  sizingStyle,
  type SizePreset,
} from '../imageSize';

interface Props {
  /** 초기 HTML (비제어 — mount/리셋 시에만 주입). 외부 리셋은 부모가 key remount */
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onImageOversize?: () => void;
  /** 이미지 파일 읽기 실패 (삭제·네트워크 드라이브 분리 등) — 조용히 무시되면 삽입된 줄 알고 초안을 만들게 된다 */
  onImageError?: (reason: string) => void;
  /** 자주 쓰는 본문 문구 (템플릿 bodyPresets) — 드롭다운으로 커서 위치에 삽입 */
  presets?: string[];
}

const MAX_IMAGE_BYTES = 1_500_000; // 1.5MB — base64 가드

/** 선택한 이미지의 화면 위치 (편집 영역 기준) */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];
const CORNER_CURSOR: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
const HANDLE = 10;
/** 크기 도구 막대 높이 — 아래 공간이 모자라면 이미지 위로 */
const BAR_H = 30;

export function RichBodyEditor({ initialHtml, onChange, placeholder, onImageOversize, onImageError, presets }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 이미지 크기 조절 — Gmail 작성창처럼 이미지를 누르면 테두리·모서리 핸들·크기 막대
  const [selected, setSelected] = useState<HTMLImageElement | null>(null);
  const selectedRef = useRef<HTMLImageElement | null>(null);
  selectedRef.current = selected;
  const [box, setBox] = useState<Box | null>(null);
  const dragRef = useRef<{ corner: Corner; x0: number; w0: number; aspect: number; maxW: number } | null>(null);

  // mount 시 1회 주입 (비제어 — value 재주입 안 함 → 커서 보존)
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    if (ref.current) onChangeRef.current(sanitizeBodyHtml(ref.current.innerHTML));
  };

  /** 선택 이미지의 위치를 다시 잰다 — 편집 영역에서 사라졌으면(잘라내기·되돌리기) 선택 해제 */
  const measure = useCallback(() => {
    const img = selectedRef.current;
    const ed = ref.current;
    const wrap = wrapRef.current;
    if (!img || !ed || !wrap) {
      setBox(null);
      return;
    }
    if (!ed.contains(img)) {
      setSelected(null);
      setBox(null);
      return;
    }
    const r = img.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setBox({ left: r.left - w.left, top: r.top - w.top, width: r.width, height: r.height });
  }, []);

  useLayoutEffect(() => {
    measure();
    if (!selected) return;
    // 아직 디코드 전이면 다 읽힌 뒤 다시 잰다
    selected.addEventListener('load', measure);
    window.addEventListener('resize', measure);
    return () => {
      selected.removeEventListener('load', measure);
      window.removeEventListener('resize', measure);
    };
  }, [selected, measure]);

  // 편집 영역 밖을 누르면 선택 해제
  useEffect(() => {
    if (!selected) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setSelected(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [selected]);

  const selectImage = (img: HTMLImageElement) => {
    setSelected(img);
    // 캐럿은 이미지 바로 뒤로 — 이어서 타이핑하면 이미지 다음에 글이 들어간다 (이미지 자체를 파란 선택 영역으로 덮지 않음)
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  /** 표시 폭 적용 — 원본 픽셀은 그대로, width·height 속성과 style만 (발송 메일에도 그대로 나간다) */
  const resizeTo = (width: number) => {
    const img = selectedRef.current;
    if (!img) return;
    applyImageWidth(img, width);
    emit();
    measure();
  };

  const applyPreset = (preset: SizePreset) => {
    const img = selectedRef.current;
    if (!img) return;
    resizeTo(presetWidth(preset, naturalWidthOf(img)));
  };

  const removeSelected = () => {
    const img = selectedRef.current;
    if (!img || !ref.current) return;
    // execCommand로 지워야 Ctrl+Z로 되돌릴 수 있다
    ref.current.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNode(img);
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (typeof document.execCommand === 'function') document.execCommand('delete');
    // execCommand를 못 쓰는 환경(일부 웹뷰·테스트)에서는 직접 제거
    if (ref.current.contains(img)) img.remove();
    setSelected(null);
    emit();
  };

  // ── 모서리 끌기 — 비율 유지 ──
  const onHandleDown = (corner: Corner) => (e: React.PointerEvent<HTMLDivElement>) => {
    const img = selectedRef.current;
    const ed = ref.current;
    if (!img || !ed) return;
    e.preventDefault();
    e.stopPropagation();
    // 핸들 밖으로 빨리 움직여도 끌기가 이어지게 — 캡처를 못 잡는 환경에서도 끌기는 진행
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 무시 */
    }
    const shown = img.getBoundingClientRect().width || declaredWidth(img) || naturalWidthOf(img);
    // 편집 영역 폭을 넘겨 키우면 화면에는 더 커지지 않고 숫자만 커진다 — 영역 폭(여백 제외)까지
    const maxW = ed.clientWidth > 0 ? Math.max(MIN_WIDTH, ed.clientWidth - 24) : MAX_WIDTH;
    dragRef.current = { corner, x0: e.clientX, w0: shown, aspect: aspectOf(img), maxW };
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const img = selectedRef.current;
    if (!d || !img) return;
    const dx = e.clientX - d.x0;
    const next = d.corner === 'ne' || d.corner === 'se' ? d.w0 + dx : d.w0 - dx;
    applyImageWidth(img, Math.min(clampWidth(next), d.maxW), d.aspect);
    measure();
  };
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 무시 */
    }
    emit();
  };

  const exec = (command: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, value);
    emit();
  };

  const insertImageFile = (file: File) => {
    if (file.size > MAX_IMAGE_BYTES) {
      onImageOversize?.();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // 언마운트(탭 전환) 후 도착한 결과는 무시 — execCommand가 문서의 다른 선택 영역에 삽입되는 것을 방지
      if (!ref.current) return;
      const dataUrl = String(reader.result);
      const insert = (natural: number, naturalH: number) => {
        if (!ref.current) return;
        // Gmail처럼 넣자마자 "최적 크기" — 큰 화면 캡처가 메일 폭을 넘지 않게
        const w = presetWidth('best', natural);
        const size = natural > 0 && naturalH > 0 ? ` width="${w}" height="${Math.max(1, Math.round((w * naturalH) / natural))}"` : '';
        ref.current.focus();
        document.execCommand(
          'insertHTML',
          false,
          `<img src="${dataUrl}" alt=""${size} style="${sizingStyle(size ? w : 0)}" />`,
        );
        emit();
      };
      const probe = new Image();
      probe.onload = () => insert(probe.naturalWidth, probe.naturalHeight);
      probe.onerror = () => onImageError?.('이미지를 해석할 수 없습니다 (손상되었거나 지원하지 않는 형식)');
      probe.src = dataUrl;
    };
    reader.onerror = () => onImageError?.(reader.error?.message ?? '파일을 읽을 수 없습니다');
    reader.readAsDataURL(file);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    setSelected(null);
    const dt = e.clipboardData;
    // 1) 이미지 우선
    const imageItem = Array.from(dt.items).find((it) => it.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        insertImageFile(file);
        return;
      }
    }
    // 2) HTML → sanitize 후 삽입. 이미지가 조용히 제거되면 알림 (붙여넣기 성공으로 오인 방지)
    const html = dt.getData('text/html');
    if (html) {
      let dropped = false;
      const clean = sanitizeBodyHtml(html, (reason) => {
        if (reason === 'image-oversize' && !dropped) {
          dropped = true;
          onImageOversize?.();
        }
      });
      document.execCommand('insertHTML', false, clean);
      emit();
      return;
    }
    // 3) plain
    const text = dt.getData('text/plain');
    document.execCommand('insertText', false, text);
    emit();
  };

  const onImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) insertImageFile(file);
    e.target.value = '';
  };

  const onInsertLink = () => {
    // prompt가 뜨면 에디터 선택이 흐려질 수 있어 Range를 미리 저장했다가 복원.
    // 단, 에디터(ref.current) 내부 선택만 신뢰 — 문서 다른 곳의 선택을 복원하면 링크가 밖에 삽입/유실됨
    const selObj = window.getSelection();
    const rawRange = selObj && selObj.rangeCount > 0 ? selObj.getRangeAt(0) : null;
    const inEditor =
      !!rawRange && !!ref.current && ref.current.contains(rawRange.commonAncestorContainer);
    const savedRange = inEditor ? rawRange.cloneRange() : null;
    const hadSelection = !!savedRange && !savedRange.collapsed;

    const raw = window.prompt('링크 URL을 입력하세요 (예: docs.example.com · https://… · mailto:name@example.com)');
    if (!raw || !raw.trim()) return;
    const url = normalizeUrl(raw); // 스킴 없으면 https:// 부착. 지원 안 하는 스킴이면 '' → 삽입 안 함
    if (!url) return; // javascript:/data: 등 위험·미지원 스킴 — 링크 만들지 않음

    ref.current?.focus();
    if (savedRange) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(savedRange);
    }
    if (hadSelection) {
      // 선택 텍스트를 링크로 감쌈
      document.execCommand('createLink', false, url);
    } else {
      // 선택 없음 → URL 텍스트를 링크로 삽입 (커서 위치)
      document.execCommand(
        'insertHTML',
        false,
        `<a href="${escapeHtml(url)}">${escapeHtml(raw.trim())}</a>&nbsp;`,
      );
    }
    emit();
  };

  const insertHtmlAtCursor = (html: string) => {
    ref.current?.focus();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const onInsertTable = () => {
    // 편집 가능한 2×2 표 (헤더 1행 + 본문 1행). 셀은 contenteditable 네이티브 편집.
    const cell = (t: string) => `<td>${t}</td>`;
    const th = (t: string) => `<th>${t}</th>`;
    insertHtmlAtCursor(
      `<table><thead><tr>${th('항목')}${th('내용')}</tr></thead>` +
        `<tbody><tr>${cell('')}${cell('')}</tr><tr>${cell('')}${cell('')}</tr></tbody></table><p><br/></p>`,
    );
  };

  const onInsertCode = () => {
    // 선택 텍스트는 반드시 escape — 명령어에 흔한 <, >, & (리다이렉트 2>&1, <logfile> 등)가
    // HTML 태그로 파싱돼 소실되던 문제 차단. pre는 개행을 보존하므로 \n은 그대로 둔다.
    const sel = window.getSelection()?.toString() ?? '';
    const inner = sel ? escapeHtml(sel) : '명령어 / 코드';
    insertHtmlAtCursor(`<pre>${inner}</pre><p><br/></p>`);
  };

  // 크기 막대 정보
  const img = selected;
  const shownW = img ? declaredWidth(img) || Math.round(box?.width ?? 0) : 0;
  const shownH = img ? Math.round(shownW * aspectOf(img)) : 0;
  const natural = img ? naturalWidthOf(img) : 0;
  const wrapH = wrapRef.current?.clientHeight ?? 0;
  const barTop = box ? (box.top + box.height + 6 + BAR_H > wrapH && box.top > BAR_H + 6 ? box.top - BAR_H - 6 : box.top + box.height + 6) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-rule bg-bg-deep px-2 py-1">
        <ToolBtn title="굵게" onClick={() => exec('bold')}><Bold size={13} /></ToolBtn>
        <ToolBtn title="기울임" onClick={() => exec('italic')}><Italic size={13} /></ToolBtn>
        <ToolBtn title="밑줄" onClick={() => exec('underline')}><Underline size={13} /></ToolBtn>
        <span className="mx-1 h-4 w-px bg-rule" />
        <ToolBtn title="글머리 기호" onClick={() => exec('insertUnorderedList')}><List size={13} /></ToolBtn>
        <ToolBtn title="번호 목록" onClick={() => exec('insertOrderedList')}><ListOrdered size={13} /></ToolBtn>
        <span className="mx-1 h-4 w-px bg-rule" />
        <ToolBtn title="표 삽입" onClick={onInsertTable}><Table size={13} /></ToolBtn>
        <ToolBtn title="코드/커맨드 블록" onClick={onInsertCode}><Code size={13} /></ToolBtn>
        <span className="mx-1 h-4 w-px bg-rule" />
        <ToolBtn title="링크" onClick={onInsertLink}><Link2 size={13} /></ToolBtn>
        <label
          className="flex cursor-pointer items-center rounded-sharp p-1 text-fg-soft hover:bg-bg-sunken hover:text-fg focus-within:outline focus-within:outline-2 focus-within:outline-fg"
          title="이미지 삽입 — 넣은 뒤 이미지를 누르면 크기를 바꿀 수 있습니다"
        >
          <ImageIcon size={13} aria-hidden="true" />
          {/* hidden(display:none)이면 Tab으로 닿지 않는다 — sr-only로 포커스 가능하게 */}
          <input type="file" accept="image/*" className="sr-only" aria-label="이미지 삽입" onChange={onImagePick} />
        </label>
        {presets && presets.length > 0 && (
          <>
            <span className="mx-1 h-4 w-px bg-rule" />
            <select
              value=""
              title="자주 쓰는 문구 삽입"
              onChange={(e) => {
                const text = e.target.value;
                if (!text) return;
                insertHtmlAtCursor(`${escapeHtml(text).replace(/\n/g, '<br/>')}`);
                e.target.value = '';
              }}
              className="max-w-[160px] rounded-sharp border border-rule bg-bg-elevated px-1.5 py-0.5 text-[11px] text-fg-soft outline-none focus:border-fg"
            >
              <option value="">문구 삽입…</option>
              {presets.map((p, i) => (
                <option key={i} value={p}>
                  {p.length > 30 ? `${p.slice(0, 30)}…` : p}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={() => {
            emit();
            if (selectedRef.current) measure();
          }}
          onPaste={onPaste}
          onScroll={() => selectedRef.current && measure()}
          onClick={(e) => {
            const t = e.target as HTMLElement;
            if (t.tagName === 'IMG') selectImage(t as HTMLImageElement);
            else if (selectedRef.current) setSelected(null);
          }}
          onKeyDown={(e) => {
            if (!selectedRef.current || e.nativeEvent.isComposing) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              removeSelected();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setSelected(null);
            } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.key.startsWith('Shift')) {
              // 이어서 타이핑 — 선택 해제하고 이미지 다음에 입력
              setSelected(null);
            }
          }}
          data-placeholder={placeholder}
          className="email-body-editor scrollbar-thin h-full overflow-auto px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none"
        />
        {img && box && (
          <>
            {/* 선택 테두리 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute"
              style={{
                left: box.left - 1,
                top: box.top - 1,
                width: box.width + 2,
                height: box.height + 2,
                outline: '2px solid var(--accent)',
              }}
            />
            {/* 모서리 핸들 — 끌면 비율을 유지한 채 크기 변경 */}
            {CORNERS.map((c) => (
              <div
                key={c}
                role="presentation"
                data-handle={c}
                onPointerDown={onHandleDown(c)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                className="absolute border-2 bg-bg-elevated"
                style={{
                  width: HANDLE,
                  height: HANDLE,
                  left: (c === 'nw' || c === 'sw' ? box.left : box.left + box.width) - HANDLE / 2,
                  top: (c === 'nw' || c === 'ne' ? box.top : box.top + box.height) - HANDLE / 2,
                  borderColor: 'var(--accent)',
                  cursor: CORNER_CURSOR[c],
                  touchAction: 'none',
                }}
              />
            ))}
            {/* 크기 막대 — Gmail 작성창의 작게 / 최적 크기 / 원래 크기 / 삭제 */}
            <div
              role="toolbar"
              aria-label="이미지 크기"
              className="absolute z-10 flex max-w-[calc(100%-8px)] flex-wrap items-center gap-0.5 rounded-sharp border border-rule-strong bg-bg-elevated px-1 py-0.5 text-[11px] shadow-pop"
              style={{ left: Math.max(4, box.left), top: barTop }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {SIZE_PRESETS.map((p) => {
                const active = shownW === presetWidth(p.id, natural);
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={p.hint}
                    aria-pressed={active}
                    onClick={() => applyPreset(p.id)}
                    className={[
                      'rounded-sharp px-1.5 py-0.5 transition hover:bg-bg-sunken',
                      active ? 'font-semibold text-fg underline' : 'text-fg-soft',
                    ].join(' ')}
                  >
                    {p.label}
                  </button>
                );
              })}
              <span className="mx-1 h-3 w-px bg-rule" aria-hidden="true" />
              <span className="px-1 tabular-nums text-fg-muted" aria-live="polite" title="표시 크기 (원본은 그대로 첨부)">
                {shownW} × {shownH}
                {natural > 0 && natural !== shownW ? ` · 원본 ${natural}` : ''}
              </span>
              <span className="mx-1 h-3 w-px bg-rule" aria-hidden="true" />
              <button
                type="button"
                title="이미지 삭제 (Delete)"
                aria-label="이미지 삭제"
                onClick={removeSelected}
                className="flex items-center rounded-sharp px-1 py-0.5 text-fg-soft transition hover:bg-bg-sunken hover:text-fg"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()} // 선택 영역 유지
      onClick={onClick}
      className="flex items-center rounded-sharp p-1 text-fg-soft transition hover:bg-bg-sunken hover:text-fg"
    >
      {children}
    </button>
  );
}
