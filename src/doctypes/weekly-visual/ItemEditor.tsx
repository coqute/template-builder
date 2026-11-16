import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  IndentDecrease,
  IndentIncrease,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ClientItem, ContentBlock, DialogTurn } from '@core/index';
import {
  MAX_INDENT,
  NOTE_PREFIX,
  isBlankItem,
  isNoteLine,
  noteText,
  splitTypedTurn,
  turnMarker,
  typedListStart,
  typedTurnStart,
} from '@core/index';

/** 줄 종류를 바꾼 뒤 포커스할 자리 (core/edit.ts ContentAt과 같은 모양) */
export interface LineAt {
  ci: number;
  index: number;
}

type HeaderPatch = Partial<Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>>;

interface ItemEditorProps {
  item: ClientItem;
  /** 날짜 내 순번 (1-based) — 화면에는 표시하지 않음 (항목은 순서가 아니라 건 단위) */
  order: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** DOM id — 이어쓰기·미결 바로가기·추가 후 스크롤·포커스 대상 */
  anchorId: string;
  /** 이어쓰기 대상 일자 (자기 날짜 제외) */
  continueDates: Array<{ date: string; label: string }>;
  /** 접힘 — 제목 줄만 보인다 */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onField: (patch: HeaderPatch) => void;
  /** 고객사 입력칸을 벗어날 때 — 행의 고객사|작업구분이 비어 있으면 채운다 */
  onClientCommit: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onContinue: (date: string) => void;
  onAddBlock: (kind: ContentBlock['kind']) => void;
  onUpdateBlock: (ci: number, block: ContentBlock) => void;
  onMoveBlock: (ci: number, dir: -1 | 1) => void;
  onRemoveBlock: (ci: number) => void;
  onIndentBlock: (ci: number, indent: number) => void;
  onAddTurn: (ci: number, turn: DialogTurn, at?: number) => void;
  onUpdateTurn: (ci: number, ti: number, patch: Partial<DialogTurn>) => void;
  onReplaceTurn: (ci: number, ti: number, turns: DialogTurn[]) => void;
  onRemoveTurn: (ci: number, ti: number) => void;
  onMoveTurn: (ci: number, ti: number, dir: -1 | 1) => void;
  /** 대화 턴 → 목록 줄 (lines는 목록 줄, 노트는 `> ` 접두). 바뀐 자리를 돌려준다 */
  onTurnToList: (ci: number, ti: number, lines: string[]) => LineAt | null;
  /** 목록 줄 → 대화 턴. 바뀐 자리를 돌려준다 */
  onLineToTurn: (ci: number, li: number, turns: DialogTurn[]) => LineAt | null;
}

/** 캡션 + 입력 — 마스트헤드(보고 주·일정 예정)용 */
export function Field({
  label,
  required,
  grow,
  width,
  children,
}: {
  label: string;
  required?: boolean;
  grow?: boolean;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={['flex flex-col gap-1', grow ? 'min-w-[180px] flex-1' : '', width ?? ''].join(' ')}>
      <span className="ms-caption">
        {label}
        {required && <span style={{ color: 'var(--stamp-red)' }}> *</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * 이름표 칸 — 상자 안 왼쪽에 칸 이름, 오른쪽에 값. 칸마다 무엇을 쓰는 곳인지 늘 보이고,
 * 캡션 줄을 따로 쌓지 않는다. 항목 머리(고객사·건물·담당자·채널)와 행 머리(지원장소·고객사|작업구분) 공용.
 */
export function Chip({
  label,
  field,
  value,
  onChange,
  onBlur,
  ariaLabel,
  list,
  title,
  invalid,
  strong,
  placeholder,
  grow,
}: {
  label: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  ariaLabel?: string;
  list?: string;
  title?: string;
  invalid?: boolean;
  /** 값을 굵게 — 고객사·지원장소처럼 그 묶음을 대표하는 칸 */
  strong?: boolean;
  placeholder?: string;
  /** 남은 폭을 채운다 — 휴일 사유처럼 문장이 들어가는 칸 */
  grow?: boolean;
}) {
  return (
    <label className={`vx-chip ${grow ? 'vx-chip--grow' : ''}`} title={title}>
      <span className="vx-chip-k">{label}</span>
      <input
        type="text"
        data-field={field}
        aria-label={ariaLabel ?? label}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        value={value}
        placeholder={placeholder}
        list={list}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`vx-chip-v ${strong ? 'vx-chip-v--strong' : ''}`}
      />
    </label>
  );
}

/** 항목 요약 — 접힌 항목·일자 요약 공용 (턴 수·미결 수) */
export function itemStats(item: ClientItem): {
  turns: number;
  pending: number;
} {
  let turns = 0;
  let pending = 0;
  for (const c of item.content) {
    if (c.kind !== 'dialog') continue;
    for (const t of c.turns) {
      if (!t.text.trim()) continue;
      turns += 1;
      if (t.pending) pending += 1;
    }
  }
  return { turns, pending };
}

/** 바깥을 누르거나 Esc면 닫히는 메뉴 — data 속성으로 메뉴 영역을 표시한다 */
export function useDismiss(open: boolean, close: () => void, attr: string) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(`[${attr}]`)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, attr]);
}

/**
 * 항목 — 이름표 칸 한 줄(고객사·건물·담당자·채널) + 상자 하나(제목 줄 + 대화 턴).
 * 상자 하나가 보고서 표의 "내용" 칸 한 건과 같다. 항목끼리는 상자 경계로 구분된다.
 */
export function ItemEditor({
  item,
  canMoveUp,
  canMoveDown,
  anchorId,
  continueDates,
  collapsed,
  onToggleCollapse,
  onField,
  onClientCommit,
  onMove,
  onRemove,
  onContinue,
  onAddBlock,
  onUpdateBlock,
  onMoveBlock,
  onRemoveBlock,
  onIndentBlock,
  onAddTurn,
  onUpdateTurn,
  onReplaceTurn,
  onRemoveTurn,
  onMoveTurn,
  onTurnToList,
  onLineToTurn,
}: ItemEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 턴 추가·이동·분할 직후 포커스 — 렌더 후 대상 textarea를 찾아 포커스
  const turnRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    const el = turnRefs.current.get(focusKey);
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setFocusKey(null);
    }
  }, [focusKey, item]);

  // 본문 블록 추가 직후 — 새 블록의 첫 입력칸으로
  const [focusBlock, setFocusBlock] = useState<number | null>(null);
  useEffect(() => {
    if (focusBlock === null) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-ci="${focusBlock}"] textarea, [data-ci="${focusBlock}"] input`,
    );
    if (el) {
      el.focus();
      setFocusBlock(null);
    }
  }, [focusBlock, item]);

  // 턴 ↔ 목록 줄을 바꾼 직후 — 바뀐 블록의 그 줄로 (블록이 나뉘거나 합쳐져 번호가 바뀐다)
  const [focusLine, setFocusLine] = useState<LineAt | null>(null);
  useEffect(() => {
    if (!focusLine) return;
    const el = rootRef.current?.querySelector<HTMLTextAreaElement>(
      `[data-ci="${focusLine.ci}"] textarea[data-line="${focusLine.index}"], [data-ci="${focusLine.ci}"] textarea[data-turn="${focusLine.index}"]`,
    );
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setFocusLine(null);
    }
  }, [focusLine, item]);
  const toList = (ci: number, ti: number, lines: string[]) => {
    const at = onTurnToList(ci, ti, lines);
    if (at) setFocusLine(at);
  };
  const toTurn = (ci: number, li: number, turns: DialogTurn[]) => {
    const at = onLineToTurn(ci, li, turns);
    if (at) setFocusLine(at);
  };

  const [addOpen, setAddOpen] = useState(false);
  useDismiss(addOpen, () => setAddOpen(false), 'data-add-menu');
  const [continueOpen, setContinueOpen] = useState(false);
  useDismiss(continueOpen, () => setContinueOpen(false), 'data-continue-menu');

  const addBlock = (kind: ContentBlock['kind']) => {
    onAddBlock(kind);
    setFocusBlock(item.content.length);
    setAddOpen(false);
  };
  // 턴은 마지막 대화 이력에 붙인다. 마지막 턴이 비어 있으면 새로 쌓지 않고 그 턴의 종류만 바꾼다
  let lastDialog = -1;
  item.content.forEach((c, i) => {
    if (c.kind === 'dialog') lastDialog = i;
  });
  const addTurnOf = (turn: Pick<DialogTurn, 'kind' | 'pending'>) => {
    setAddOpen(false);
    const block = item.content[lastDialog];
    if (!block || block.kind !== 'dialog') return;
    const ti = block.turns.length - 1;
    if (ti >= 0 && !block.turns[ti].text.trim()) {
      onUpdateTurn(lastDialog, ti, { kind: turn.kind, pending: turn.pending });
      setFocusKey(`${lastDialog}:${ti}`);
      return;
    }
    onAddTurn(lastDialog, { kind: turn.kind, pending: turn.pending, text: '' });
    setFocusKey(`${lastDialog}:${block.turns.length}`);
  };

  const { turns, pending } = itemStats(item);

  return (
    <div className="vx-item" id={anchorId} ref={rootRef}>
      {/* 머리 정보 — 보고서의 [고객사] (건물) (담당자/채널) */}
      <div className="vx-meta">
        <Chip
          label="고객사"
          field="client"
          value={item.client}
          list="visual-customer-options"
          onChange={(v) => onField({ client: v })}
          onBlur={onClientCommit}
          // 쓰기 시작한 항목만 필수 표시 — 빈 골격은 출력에서 빠지므로 표시하지 않는다
          invalid={!item.client.trim() && !isBlankItem(item)}
          strong
        />
        <Chip
          label="건물"
          field="site"
          ariaLabel="건물(현장)"
          value={item.site ?? ''}
          title="현장 방문 시 건물명 — 지원장소 MX(누리사옥)의 '누리사옥'. 원격이면 비워 둡니다"
          onChange={(v) => onField({ site: v })}
        />
        <Chip
          label="담당자"
          field="contact"
          value={item.contact ?? ''}
          list="visual-contact-options"
          onChange={(v) => onField({ contact: v })}
        />
        <Chip
          label="채널"
          field="channel"
          value={item.channel ?? ''}
          list="visual-channel-options"
          onChange={(v) => onField({ channel: v })}
        />
        <span className={`vx-tools ${addOpen || continueOpen ? 'vx-tools--open' : ''}`}>
          {continueDates.length > 0 && (
            <span className="relative" data-continue-menu={continueOpen ? '' : undefined}>
              <IconBtn
                title="다른 날에 이어쓰기 — 머리를 복사하고 빈 대화 이력을 만듭니다"
                onClick={() => setContinueOpen((o) => !o)}
                expanded={continueOpen}
              >
                <CornerDownRight size={13} />
              </IconBtn>
              {continueOpen && (
                <div className="vx-menu vx-menu--right" role="menu" aria-label="이어 쓸 날">
                  <div className="vx-menu-h">이어 쓸 날</div>
                  {continueDates.map((d) => (
                    <MenuBtn
                      key={d.date}
                      label={`${d.label}에 이어쓰기`}
                      onPick={() => {
                        setContinueOpen(false);
                        onContinue(d.date);
                      }}
                    >
                      {d.label}
                    </MenuBtn>
                  ))}
                </div>
              )}
            </span>
          )}
          <span className="relative" data-add-menu={addOpen ? '' : undefined}>
            <IconBtn title="턴·블록 추가" onClick={() => setAddOpen((o) => !o)} expanded={addOpen}>
              <Plus size={13} />
            </IconBtn>
            {addOpen && (
              <div className="vx-menu vx-menu--right" role="menu" aria-label="추가">
                {lastDialog >= 0 && <div className="vx-menu-h">대화 이력에 턴 추가</div>}
                {lastDialog >= 0 &&
                  TURN_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addTurnOf(o.turn)}
                    >
                      <span className="vx-glyph">{turnMarker({ ...o.turn, text: '' })}</span>
                      {o.label}
                    </button>
                  ))}
                {lastDialog >= 0 && <hr />}
                <div className="vx-menu-h">새 블록</div>
                {(['bullets', 'dialog', 'numbered'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    title={BLOCK_META[kind].hint}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addBlock(kind)}
                  >
                    <span className="vx-glyph">{BLOCK_META[kind].glyph}</span>
                    {BLOCK_META[kind].label}
                  </button>
                ))}
              </div>
            )}
          </span>
          <IconBtn title={collapsed ? '펼치기' : '접기'} onClick={onToggleCollapse}>
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </IconBtn>
          <IconBtn title="위로 이동" disabled={!canMoveUp} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconBtn>
          <IconBtn title="아래로 이동" disabled={!canMoveDown} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconBtn>
          <IconBtn title="항목 삭제" onClick={onRemove}>
            <Trash2 size={13} />
          </IconBtn>
        </span>
      </div>

      <div className="vx-box">
        {/* 제목 줄 — 원격은 상대 메일 제목, 현장은 작업명. 길면 줄을 바꿔 전부 보인다 */}
        <div className="vx-titlebar">
          <textarea
            data-field="workType"
            aria-label="제목"
            spellCheck={false}
            rows={1}
            value={item.workType}
            placeholder="제목 — 원격은 상대 메일 제목, 현장은 작업명"
            onChange={(e) => onField({ workType: e.target.value.replace(/\s*\n\s*/g, ' ') })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey || e.ctrlKey || e.metaKey) return;
              e.preventDefault();
              // 본문 첫 입력칸으로 — 대화 턴이든 목록 줄이든, 본문이 없으면 본문 고르기 단추로
              rootRef.current?.querySelector<HTMLElement>('.vx-body textarea, .vx-body input, .vx-body .vx-add')?.focus();
            }}
            className="vx-title"
          />
          {collapsed && (
            <button type="button" className="vx-foldsum" onClick={onToggleCollapse} aria-expanded={false}>
              턴 {turns}
              {pending > 0 && <span className="vx-foldsum-pending">미결 {pending}</span>}
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="vx-body">
            {item.content.length === 0 ? (
              // 본문이 없을 때만 — 무엇을 쓸 수 있는지 그 자리에서 고른다
              <div className="vx-empty">
                {(['bullets', 'dialog', 'numbered'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="vx-add"
                    title={BLOCK_META[kind].hint}
                    onClick={() => addBlock(kind)}
                  >
                    <Plus size={11} /> {BLOCK_META[kind].label}
                  </button>
                ))}
              </div>
            ) : (
              item.content.map((block, ci) => (
                <div
                  key={ci}
                  data-ci={ci}
                  data-lvl={block.indent ?? 0}
                  className="vx-block"
                  style={{ '--lvl': block.indent ?? 0 } as React.CSSProperties}
                >
                  <ContentBlockEditor
                    block={block}
                    canMoveUp={ci > 0}
                    canMoveDown={ci < item.content.length - 1}
                    onChange={(b) => onUpdateBlock(ci, b)}
                    onMove={(dir) => onMoveBlock(ci, dir)}
                    onRemove={() => onRemoveBlock(ci)}
                    onIndent={(delta) => onIndentBlock(ci, (block.indent ?? 0) + delta)}
                    registerTurn={(ti, el) => {
                      const key = `${ci}:${ti}`;
                      if (el) turnRefs.current.set(key, el);
                      else turnRefs.current.delete(key);
                    }}
                    onFocusTurn={(ti) => setFocusKey(`${ci}:${ti}`)}
                    onAddTurn={(turn, at) => {
                      onAddTurn(ci, turn, at);
                      const count = block.kind === 'dialog' ? block.turns.length : 0;
                      setFocusKey(`${ci}:${at ?? count}`);
                    }}
                    onUpdateTurn={(ti, patch) => onUpdateTurn(ci, ti, patch)}
                    onReplaceTurn={(ti, next) => {
                      onReplaceTurn(ci, ti, next);
                      setFocusKey(`${ci}:${ti + next.length - 1}`);
                    }}
                    onRemoveTurn={(ti) => {
                      onRemoveTurn(ci, ti);
                      if (ti > 0) setFocusKey(`${ci}:${ti - 1}`);
                    }}
                    onMoveTurn={(ti, dir) => {
                      onMoveTurn(ci, ti, dir);
                      setFocusKey(`${ci}:${ti + dir}`);
                    }}
                    onToList={(ti, lines) => toList(ci, ti, lines)}
                    onToTurn={(li, turns) => toTurn(ci, li, turns)}
                  />
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const BLOCK_META: Record<ContentBlock['kind'], { label: string; glyph: string; hint: string }> = {
  dialog: {
    label: '대화 이력',
    glyph: '->',
    hint: '->·<- 로 문의·대응 경과를 시간순으로',
  },
  numbered: {
    label: '번호 작업',
    glyph: '1)',
    hint: '1) 2) 작업 단계·안건 — 표에서 "1) 제목 + - 세부 / > 노트" 형태',
  },
  bullets: { label: '목록', glyph: '-', hint: '표에서 "- 항목" 형태' },
};

/** 턴 종류 — 표지 메뉴·추가 메뉴의 선택지 */
const TURN_OPTIONS: Array<{
  value: string;
  label: string;
  turn: Pick<DialogTurn, 'kind' | 'pending'>;
}> = [
  { value: 'in', label: '상대 발화', turn: { kind: 'in' } },
  { value: 'out', label: '내 대응', turn: { kind: 'out' } },
  {
    value: 'out-pending',
    label: '미결 — 내 후속 조치',
    turn: { kind: 'out', pending: true },
  },
  {
    value: 'in-pending',
    label: '대기 — 상대 회신',
    turn: { kind: 'in', pending: true },
  },
  {
    value: 'conclusion',
    label: '결론·후속 과제',
    turn: { kind: 'conclusion' },
  },
  { value: 'note', label: '노트', turn: { kind: 'note' } },
];

function turnValue(t: DialogTurn): string {
  if (t.kind === 'in' || t.kind === 'out') return t.pending ? `${t.kind}-pending` : t.kind;
  return t.kind;
}

/** 표지의 짧은 이름 — 기호만으로는 읽기 어려워 말을 함께 적는다 */
function turnLabel(t: DialogTurn): string {
  if (t.kind === 'conclusion') return '결론';
  if (t.kind === 'note') return '노트';
  if (t.kind === 'in') return t.pending ? '대기' : '상대';
  return t.pending ? '미결' : '대응';
}

function turnPlaceholder(t: DialogTurn, first: boolean): string {
  if (t.kind === 'conclusion') return '정리할 후속 과제';
  if (t.kind === 'note') return '참고 메모';
  if (t.kind === 'in') return first ? '상대 문의·요청·회신 (Enter 다음 턴, 줄 앞 "- " 목록)' : '상대 문의·요청·회신';
  return t.pending ? '남은 후속 조치' : '내 안내·전달·조치';
}

/** 턴 → 목록 줄 — 첫 줄은 목록 줄, 이어지는 줄은 그 아래 노트(보고서의 "- 헤드라인 / > 상세" 모양) */
export function linesFromTurn(turn: DialogTurn): string[] {
  const [first, ...rest] = turn.text.split('\n');
  return [first.trim(), ...rest.filter((l) => l.trim()).map((l) => `${NOTE_PREFIX}${l.trim()}`)];
}

/** 목록 줄 표지 메뉴의 대화 턴 선택지 */
const LINE_TO_TURN: Array<{ label: string; turn: Pick<DialogTurn, 'kind' | 'pending'> }> = [
  { label: '상대 발화', turn: { kind: 'in' } },
  { label: '내 대응', turn: { kind: 'out' } },
];

// ── 목록·세부 줄 ─────────────────────────────────────────────────────────────
// `-` 목록 줄과 그 아래 `>` 노트는 모델에서 한 배열(bullets.items / numbered.details)에 들어 있고
// 노트는 `> ` 접두로 구분된다. 화면에서는 줄마다 표지를 달아 노트를 바로 위 줄에 딸린 것으로 들여 보여 준다.

type LineKind = 'dash' | 'note';

function lineKind(s: string): LineKind {
  return isNoteLine(s) ? 'note' : 'dash';
}

function lineText(s: string): string {
  return isNoteLine(s) ? noteText(s) : s;
}

function toLine(kind: LineKind, text: string): string {
  return kind === 'note' ? `${NOTE_PREFIX}${text}` : text;
}

/** 줄 앞에 친 표지 — `> `는 노트, `- `는 목록 줄. 표지가 없으면 null */
function typedLineMarker(v: string): { kind: LineKind; rest: string } | null {
  const m = /^(>|-)(?:\s+|$)/.exec(v);
  if (!m) return null;
  return { kind: m[1] === '>' ? 'note' : 'dash', rest: v.slice(m[0].length) };
}

/**
 * 입력칸 값 → 줄 목록. 첫 줄은 지금 줄(표지를 쳤으면 그 종류로), 붙여 넣은 둘째 줄부터는 줄마다 표지로 종류를 정한다.
 * 표지 없는 붙여 넣은 줄은 목록 줄이다.
 */
export function splitTypedLines(kind: LineKind, value: string): string[] {
  const parts = value.replace(/\r\n?/g, '\n').split('\n');
  return parts.map((p, i) => {
    const typed = typedLineMarker(i === 0 ? p : p.trimStart());
    if (typed) return toLine(typed.kind, typed.rest);
    return toLine(i === 0 ? kind : 'dash', p);
  });
}

const LINE_META: Record<LineKind, { glyph: string; label: string; menu: string }> = {
  dash: { glyph: '-', label: '목록', menu: '목록 줄' },
  note: { glyph: '>', label: '노트', menu: '노트 — 위 줄의 보충 설명' },
};

/**
 * 목록(`-`)·노트(`>`) 줄 편집 — 한 줄에 표지 하나, 노트는 위 줄 아래로 들여 옅게 보인다.
 * - 줄 앞에 `> `를 치면 노트, `- `를 치면 목록 줄로 바뀐다. 표지를 누르면 종류·순서·삭제 메뉴.
 * - Enter는 커서 자리에서 줄을 나눠 같은 종류의 새 줄, 빈 줄에서 Backspace는 줄 삭제, ↑↓는 줄 사이 이동.
 * - 여러 줄을 붙여 넣으면 줄마다 나눈다.
 * @param variant list = 목록 블록(표지 칸에 이름까지), detail = 번호 작업의 세부(작은 표지)
 */
function LineRows({
  lines,
  onChange,
  variant,
  ariaLabel,
  placeholder,
  extraMenu,
  onToTurn,
}: {
  lines: readonly string[];
  onChange: (lines: string[]) => void;
  variant: 'list' | 'detail';
  ariaLabel: string;
  placeholder: string;
  /** 표지 메뉴 끝에 붙일 블록 조작(목록 블록) */
  extraMenu?: React.ReactNode;
  /** 목록 블록만 — 줄 하나를 대화 턴으로 (줄 앞 `-> `·`<- `, 표지 메뉴) */
  onToTurn?: (i: number, turns: DialogTurn[]) => void;
}) {
  const rows = lines.length ? lines : [''];
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const [focusAt, setFocusAt] = useState<{ i: number; caret: number | 'end' } | null>(null);
  const [menuAt, setMenuAt] = useState<number | null>(null);
  useDismiss(menuAt !== null, () => setMenuAt(null), 'data-line-menu');

  useEffect(() => {
    if (!focusAt) return;
    const el = refs.current[focusAt.i];
    if (el) {
      el.focus();
      const pos = focusAt.caret === 'end' ? el.value.length : focusAt.caret;
      el.setSelectionRange(pos, pos);
    }
    setFocusAt(null);
  }, [focusAt]);

  const commit = (next: string[], focus?: { i: number; caret: number | 'end' }) => {
    onChange(next);
    if (focus) setFocusAt(focus);
  };
  const setKind = (i: number, kind: LineKind) => commit(rows.map((s, k) => (k === i ? toLine(kind, lineText(s)) : s)), { i, caret: 'end' });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next, { i: j, caret: 'end' });
  };
  const remove = (i: number) => {
    const next = rows.filter((_, k) => k !== i);
    commit(next, next.length ? { i: Math.max(0, i - 1), caret: 'end' } : undefined);
  };

  return (
    <div className={variant === 'list' ? 'vx-lines' : 'vx-lines vx-lines--detail'} role="group" aria-label={ariaLabel}>
      {rows.map((s, i) => {
        const kind = lineKind(s);
        const meta = LINE_META[kind];
        return (
          <div key={i} className={variant === 'list' ? 'vx-line vx-li' : 'vx-li vx-li--detail'} data-kind={kind} data-line-menu={menuAt === i ? '' : undefined}>
            <button
              type="button"
              className="vx-mark vx-li-mark"
              aria-label={`${meta.label} 줄 메뉴`}
              aria-haspopup="menu"
              aria-expanded={menuAt === i}
              tabIndex={-1}
              title="목록·노트 바꾸기, 줄 이동·삭제 — 줄 앞에 > 나 - 를 쳐도 바뀝니다"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenuAt(menuAt === i ? null : i)}
            >
              <span className="vx-mark-glyph">{meta.glyph}</span>
              {variant === 'list' && <span className="vx-mark-label">{meta.label}</span>}
            </button>
            {menuAt === i && (
              <div className="vx-menu" role="menu" aria-label="줄">
                {(['dash', 'note'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitemradio"
                    aria-checked={kind === k}
                    disabled={k === 'note' && i === 0 && kind === 'dash'}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuAt(null);
                      setKind(i, k);
                    }}
                  >
                    <span className="vx-glyph">{LINE_META[k].glyph}</span>
                    {LINE_META[k].menu}
                  </button>
                ))}
                {onToTurn &&
                  LINE_TO_TURN.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      role="menuitem"
                      title={`이 줄을 대화 턴(${o.label})으로 — 줄 앞에 ${turnMarker({ ...o.turn, text: '' })} 를 쳐도 바뀝니다`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setMenuAt(null);
                        onToTurn(i, [{ ...o.turn, text: lineText(s) }]);
                      }}
                    >
                      <span className="vx-glyph">{turnMarker({ ...o.turn, text: '' })}</span>
                      {o.label}
                    </button>
                  ))}
                <hr />
                <MenuBtn label="줄 위로" disabled={i === 0} onPick={() => (setMenuAt(null), move(i, -1))}>
                  <ArrowUp size={12} /> 줄 위로
                </MenuBtn>
                <MenuBtn label="줄 아래로" disabled={i === rows.length - 1} onPick={() => (setMenuAt(null), move(i, 1))}>
                  <ArrowDown size={12} /> 줄 아래로
                </MenuBtn>
                <MenuBtn label="줄 삭제" disabled={rows.length === 1 && !s} onPick={() => (setMenuAt(null), remove(i))}>
                  <Trash2 size={12} /> 줄 삭제
                </MenuBtn>
                {extraMenu && (
                  <>
                    <hr />
                    {extraMenu}
                  </>
                )}
              </div>
            )}
            <textarea
              ref={(el) => {
                refs.current[i] = el;
              }}
              aria-label={`${ariaLabel} ${i + 1}번째 줄 (${meta.label})`}
              data-line={i}
              spellCheck={false}
              value={lineText(s)}
              rows={1}
              placeholder={i === 0 ? placeholder : kind === 'note' ? '위 줄의 보충 설명' : ''}
              onChange={(e) => {
                const value = e.target.value;
                // 목록 줄 앞에 대화 마커(`-> ` `<- ` `*<- ` …) → 이 줄을 대화 턴으로
                const typed = onToTurn ? typedTurnStart(value) : null;
                if (typed && onToTurn) {
                  const base: DialogTurn = { ...typed.turn, text: '' };
                  onToTurn(i, splitTypedTurn(base, typed.rest) ?? [{ ...typed.turn, text: typed.rest }]);
                  return;
                }
                const parts = splitTypedLines(kind, value);
                const next = [...rows.slice(0, i), ...parts, ...rows.slice(i + 1)];
                const last = i + parts.length - 1;
                // 표지를 쳐서 종류만 바뀌면 커서는 글 끝에, 붙여 넣어 줄이 늘면 마지막 줄 끝에
                commit(next, parts.length > 1 || typedLineMarker(value) ? { i: last, caret: 'end' } : undefined);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 조합 확정용
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                const el = e.currentTarget;
                const text = lineText(s);
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const at = el.selectionStart ?? text.length;
                  const next = [...rows];
                  next.splice(i, 1, toLine(kind, text.slice(0, at)), toLine(kind, text.slice(el.selectionEnd ?? at)));
                  commit(next, { i: i + 1, caret: 0 });
                } else if (e.key === 'Backspace' && text === '' && rows.length > 1) {
                  e.preventDefault();
                  remove(i);
                } else if (e.key === 'ArrowUp' && i > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
                  e.preventDefault();
                  setFocusAt({ i: i - 1, caret: 'end' });
                } else if (e.key === 'ArrowDown' && i < rows.length - 1 && el.selectionStart === el.value.length) {
                  e.preventDefault();
                  setFocusAt({ i: i + 1, caret: 0 });
                }
              }}
              className={variant === 'list' ? 'vx-text' : 'vx-text vx-text--sub'}
            />
          </div>
        );
      })}
    </div>
  );
}

function ContentBlockEditor({
  block,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
  onIndent,
  registerTurn,
  onFocusTurn,
  onAddTurn,
  onUpdateTurn,
  onReplaceTurn,
  onRemoveTurn,
  onMoveTurn,
  onToList,
  onToTurn,
}: {
  block: ContentBlock;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (b: ContentBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onIndent: (delta: -1 | 1) => void;
  registerTurn: (ti: number, el: HTMLTextAreaElement | null) => void;
  onFocusTurn: (ti: number) => void;
  onAddTurn: (turn: DialogTurn, at?: number) => void;
  onUpdateTurn: (ti: number, patch: Partial<DialogTurn>) => void;
  onReplaceTurn: (ti: number, turns: DialogTurn[]) => void;
  onRemoveTurn: (ti: number) => void;
  onMoveTurn: (ti: number, dir: -1 | 1) => void;
  /** 이 대화 블록의 턴 하나를 목록 줄로 (노트는 `> ` 접두) */
  onToList: (ti: number, lines: string[]) => void;
  /** 이 목록 블록의 줄 하나를 대화 턴으로 */
  onToTurn: (li: number, turns: DialogTurn[]) => void;
}) {
  const indent = block.indent ?? 0;
  // 표지 메뉴 — 한 번에 하나. 턴 번호, 번호 작업·목록은 'block'
  const [menuFor, setMenuFor] = useState<number | 'block' | null>(null);
  useDismiss(menuFor !== null, () => setMenuFor(null), 'data-mark-menu');
  const pick = (fn: () => void) => () => {
    setMenuFor(null);
    fn();
  };

  // 블록 단위 조작 — 본문 위에 떠 있는 도구 대신 표지 메뉴 안에 둔다 (글자를 가리지 않게)
  const blockItems = (
    <>
      <div className="vx-menu-h">{BLOCK_META[block.kind].label} 블록</div>
      <MenuBtn label="들여쓰기 (한 단계 하위로)" disabled={indent >= MAX_INDENT} onPick={pick(() => onIndent(1))}>
        <IndentIncrease size={12} /> 들여쓰기
      </MenuBtn>
      <MenuBtn label="내어쓰기 (들여쓰기 한 단계 줄이기)" disabled={indent <= 0} onPick={pick(() => onIndent(-1))}>
        <IndentDecrease size={12} /> 내어쓰기
      </MenuBtn>
      <MenuBtn label="블록 위로" disabled={!canMoveUp} onPick={pick(() => onMove(-1))}>
        <ArrowUp size={12} /> 블록 위로
      </MenuBtn>
      <MenuBtn label="블록 아래로" disabled={!canMoveDown} onPick={pick(() => onMove(1))}>
        <ArrowDown size={12} /> 블록 아래로
      </MenuBtn>
      <MenuBtn label="블록 삭제" onPick={pick(onRemove)}>
        <Trash2 size={12} /> 블록 삭제
      </MenuBtn>
    </>
  );
  // 번호 작업·목록의 표지 — 누르면 블록 메뉴
  const staticMark = (text: string) => (
    <>
      <button
        type="button"
        className="vx-mark vx-mark--static"
        aria-label="블록 메뉴"
        aria-haspopup="menu"
        aria-expanded={menuFor === 'block'}
        tabIndex={-1}
        title="들여쓰기·이동·삭제"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMenuFor(menuFor === 'block' ? null : 'block')}
      >
        {text}
      </button>
      {menuFor === 'block' && (
        <div className="vx-menu" role="menu" aria-label="블록">
          {blockItems}
        </div>
      )}
    </>
  );

  return (
    <>
      {block.kind === 'numbered' && (
        <div className="vx-line vx-line--num" data-mark-menu={menuFor === 'block' ? '' : undefined}>
          {staticMark(`${block.index})`)}
          <div className="min-w-0">
            <input
              type="text"
              aria-label="작업 제목"
              spellCheck={false}
              value={block.title}
              placeholder="작업 제목 — 예: 수집서버 프로세스 패치"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
              className="vx-text vx-text--strong"
            />
            <LineRows
              lines={block.details}
              onChange={(details) => onChange({ ...block, details })}
              variant="detail"
              ariaLabel="세부 내용"
              placeholder={'세부 — Enter로 다음 줄, 줄 앞에 "> "를 치면 노트'}
            />
          </div>
        </div>
      )}

      {block.kind === 'dialog' &&
        block.turns.map((turn, ti) => (
          <div
            key={ti}
            className="vx-line vx-turn"
            data-kind={turn.kind}
            data-pending={turn.pending ? 'true' : undefined}
            data-mark-menu={menuFor === ti ? '' : undefined}
          >
            {/* 표지 — 보고서에 찍히는 기호 + 짧은 이름. 누르면 종류·순서·삭제 메뉴 (키보드는 줄 앞 마커 입력) */}
            <button
              type="button"
              className="vx-mark"
              aria-label="턴 종류"
              aria-haspopup="menu"
              aria-expanded={menuFor === ti}
              tabIndex={-1}
              title="턴 종류 바꾸기 — 줄 앞에 *<- *==> > -> <- 를 쳐도 바뀝니다"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenuFor(menuFor === ti ? null : ti)}
            >
              <span className="vx-mark-glyph">{turnMarker(turn)}</span>
              <span className="vx-mark-label">{turnLabel(turn)}</span>
            </button>
            {menuFor === ti && (
              <div className="vx-menu" role="menu" aria-label="턴 종류">
                {TURN_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={turnValue(turn) === o.value}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onUpdateTurn(ti, {
                        kind: o.turn.kind,
                        pending: o.turn.pending,
                      });
                      setMenuFor(null);
                      onFocusTurn(ti);
                    }}
                  >
                    <span className="vx-glyph">
                      {turnMarker({
                        kind: o.turn.kind,
                        pending: o.turn.pending,
                        text: '',
                      })}
                    </span>
                    {o.label}
                  </button>
                ))}
                {/* 목록 줄 — 대화 블록 밖으로 나뉜다. 턴의 이어지는 줄은 노트(`>`)로 */}
                <button
                  type="button"
                  role="menuitem"
                  title="이 턴을 목록 줄(- 한 일)로 — 줄 앞에 - 를 쳐도 바뀝니다"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setMenuFor(null);
                    onToList(ti, linesFromTurn(turn));
                  }}
                >
                  <span className="vx-glyph">-</span>
                  목록 줄
                </button>
                <hr />
                <MenuBtn label="턴 위로" disabled={ti === 0} onPick={pick(() => onMoveTurn(ti, -1))}>
                  <ArrowUp size={12} /> 턴 위로
                </MenuBtn>
                <MenuBtn
                  label="턴 아래로"
                  disabled={ti === block.turns.length - 1}
                  onPick={pick(() => onMoveTurn(ti, 1))}
                >
                  <ArrowDown size={12} /> 턴 아래로
                </MenuBtn>
                <MenuBtn label="턴 삭제" onPick={pick(() => onRemoveTurn(ti))}>
                  <Trash2 size={12} /> 턴 삭제
                </MenuBtn>
                <hr />
                {blockItems}
              </div>
            )}
            <textarea
              ref={(el) => registerTurn(ti, el)}
              data-turn={ti}
              data-pending={turn.pending ? 'true' : undefined}
              value={turn.text}
              rows={Math.max(1, turn.text.split('\n').length)}
              placeholder={turnPlaceholder(turn, ti === 0)}
              onChange={(e) => {
                const value = e.target.value;
                // 줄 앞 `- ` → 이 턴을 목록 줄로 (대화 블록 밖으로 나뉜다)
                const listRest = typedListStart(value);
                if (listRest !== null) {
                  onToList(ti, splitTypedLines('dash', listRest));
                  return;
                }
                // 줄 앞 마커(`*<- ` `-> ` `> ` …) → 턴 종류 변경, 둘째 줄부터의 마커 줄 → 턴 분할
                const split = splitTypedTurn(turn, value);
                if (!split) {
                  onUpdateTurn(ti, { text: value });
                } else if (split.length === 1) {
                  onUpdateTurn(ti, {
                    kind: split[0].kind,
                    pending: split[0].pending,
                    text: split[0].text,
                  });
                } else {
                  onReplaceTurn(ti, split);
                }
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 조합 확정용
                // Ctrl·Alt 조합은 전역 단축키(Ctrl+Enter 임시보관함 등)에 양보 — 턴을 만들지 않는다
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                const el = e.currentTarget;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const next = block.turns[ti + 1];
                  // 다음 턴이 비어 있으면 그 칸으로 — 골격의 빈 턴을 두고 새 턴을 끼워 넣지 않는다
                  if (next && !next.text.trim()) onFocusTurn(ti + 1);
                  // 대화는 번갈아 오가므로 다음 턴은 반대 방향으로 시드
                  else onAddTurn({ kind: turn.kind === 'in' ? 'out' : 'in', text: '' }, ti + 1);
                } else if (e.key === 'Backspace' && turn.text === '' && block.turns.length > 1) {
                  e.preventDefault();
                  onRemoveTurn(ti);
                } else if (e.key === 'ArrowUp' && ti > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
                  e.preventDefault();
                  onFocusTurn(ti - 1);
                } else if (
                  e.key === 'ArrowDown' &&
                  ti < block.turns.length - 1 &&
                  el.selectionStart === el.value.length
                ) {
                  e.preventDefault();
                  onFocusTurn(ti + 1);
                }
              }}
              aria-label="턴 내용"
              spellCheck={false}
              title="줄 앞에 *<- (미결) *==> (결론) > (노트) -> <- 를 치면 턴 종류가, - 를 치면 목록 줄로 바뀝니다"
              className="vx-text"
            />
          </div>
        ))}

      {block.kind === 'bullets' && (
        <LineRows
          lines={block.items}
          onChange={(items) => onChange({ ...block, items })}
          variant="list"
          ariaLabel="목록"
          placeholder={'한 일 — Enter 다음 줄, 줄 앞 "> " 노트, "-> "·"<- " 대화'}
          extraMenu={blockItems}
          onToTurn={onToTurn}
        />
      )}
    </>
  );
}

/** 표지 메뉴의 한 줄 — 누를 때 입력칸의 포커스를 빼앗지 않는다 */
function MenuBtn({
  label,
  disabled,
  onPick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      {children}
    </button>
  );
}

/** 손댈 때만 보이는 아이콘 버튼 — 보이지 않을 때 Tab이 멈추지 않도록 Tab 순서에서 뺀다 */
function IconBtn({
  title,
  disabled,
  expanded,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-expanded={expanded}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="vx-icon"
    >
      {children}
    </button>
  );
}
