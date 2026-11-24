import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FileText, MoreHorizontal } from 'lucide-react';
import { fileBaseName } from '../lib/recentFiles';

interface BtnProps {
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  /** 툴팁 대체 — 비활성 사유 등 (기본은 "라벨 (단축키)") */
  hint?: string;
  onClick: () => void;
}

/**
 * 툴바 버튼 공통 — 키보드 포커스 윤곽선은 잉크색(fg) 고정.
 * (색 미지정이면 currentColor = 주 버튼 글자색 --bg 라서 툴바 배경과 같아 보이지 않는다)
 * 가로 패딩은 버튼마다 다르므로 BASE에 두지 않는다 — 같은 명시도의 px-* 충돌 방지
 */
const BTN_BASE =
  'group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sharp border py-1.5 text-xs transition ' +
  'disabled:cursor-not-allowed disabled:opacity-40 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg';
/** 주 동작(채움) — 화면당 결과를 내보내는 1~2개만 */
const BTN_PRIMARY = 'border-accent font-semibold';
/** 보조 동작(윤곽선) — 주 동작이 묻히지 않도록 채우지 않는다 */
const BTN_SECONDARY =
  'border-rule bg-transparent font-medium text-fg-soft hover:border-rule-strong hover:bg-bg-sunken hover:text-fg';
const PRIMARY_STYLE = { background: 'var(--accent)', color: 'var(--bg)' } as const;

/** 툴바 표준 버튼 — DocType 모듈들이 슬롯 포털에 렌더 */
export function Btn({ label, shortcut, icon, primary, disabled, hint, onClick }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={[BTN_BASE, 'px-2', primary ? BTN_PRIMARY : BTN_SECONDARY].join(' ')}
      style={primary ? PRIMARY_STYLE : undefined}
      title={hint ?? (shortcut ? `${label} (${shortcut})` : label)}
    >
      <span aria-hidden="true">{icon}</span>
      {/* 1차 액션은 항상 라벨, 2차는 lg+에서만 (좁은 폭 가로 스크롤 방지) */}
      <span className={primary ? '' : 'hidden lg:inline'}>{label}</span>
    </button>
  );
}

export interface MoreItem {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 툴바 드롭다운 — 툴바 머리는 좁은 폭에서 넘치지 않게 overflow-hidden이라, 그 안에 펼치면 메뉴가 잘려
 * 보이지 않았다. 메뉴를 문서 맨 위(body)에 띄우고 버튼 바로 아래 오른쪽 끝에 맞춘다.
 * 바깥 클릭·Esc로 닫히고, 창 크기·스크롤이 바뀌면 다시 맞춘다.
 */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({ top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) });
    };
    place();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const panel = (children: React.ReactNode, minWidth = 240) =>
    open && pos
      ? createPortal(
          <div
            ref={panelRef}
            role="menu"
            className="tb-menu fixed z-50 rounded-sharp border border-rule-strong bg-bg-elevated py-1 shadow-pop"
            style={{ top: pos.top, right: pos.right, minWidth }}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return { open, setOpen, anchorRef, panel };
}

/**
 * ⋯ 더보기 — 유용하지만 매일 쓰지 않는 기능을 툴바 밖으로 뺀다 (핵심 동작이 묻히지 않도록).
 * 바깥 클릭·Esc로 닫힘.
 */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const { open, setOpen, anchorRef, panel } = useDropdown();

  return (
    <div ref={anchorRef} className="relative flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${BTN_BASE} ${BTN_SECONDARY} px-1.5`}
        title="더보기"
        aria-label="더보기"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={14} />
      </button>
      {panel(
        items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              setOpen(false);
              it.onClick();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg transition hover:bg-bg-sunken disabled:opacity-40"
          >
            <span className="text-fg-muted" aria-hidden="true">
              {it.icon}
            </span>
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-fg-muted">{it.shortcut}</span>}
          </button>
        )),
      )}
    </div>
  );
}

/** "열기" split-button — 본체는 다이얼로그 열기, 우측 화살표는 최근 파일 드롭다운 */
export function OpenSplitButton({
  onOpen,
  recentFiles,
  onOpenRecent,
}: {
  onOpen: () => void;
  recentFiles: string[];
  onOpenRecent?: (path: string) => void;
}) {
  const { open, setOpen, anchorRef, panel } = useDropdown();

  return (
    <div ref={anchorRef} className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className={`${BTN_BASE} ${BTN_SECONDARY} rounded-r-none px-2`}
        title="열기 (Ctrl+O)"
        aria-label="열기"
      >
        <span aria-hidden="true">
          <FileText size={14} />
        </span>
        <span className="hidden lg:inline">열기</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={recentFiles.length === 0}
        className={`${BTN_BASE} ${BTN_SECONDARY} rounded-l-none border-l-0 px-1`}
        title={recentFiles.length ? '최근 파일' : '최근 파일 없음'}
        aria-label="최근 파일"
        aria-expanded={open}
      >
        <ChevronDown size={12} />
      </button>
      {panel(
        recentFiles.map((path) => (
          <button
            key={path}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenRecent?.(path);
            }}
            className="flex w-full max-w-[420px] flex-col items-start gap-0 px-3 py-1.5 text-left hover:bg-bg-sunken"
            title={path}
          >
            <span className="w-full truncate text-xs text-fg">{fileBaseName(path)}</span>
            <span className="w-full truncate text-[10px] text-fg-muted">{path}</span>
          </button>
        )),
      )}
    </div>
  );
}
