import { ArrowDown, ArrowUp, ListOrdered, List, MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { ClientItem, ContentBlock } from '@core/index';
import { KNOWN_CHANNELS } from '@core/index';

interface ItemEditorProps {
  item: ClientItem;
  /** 카드 헤더 표기용 순번 (1-based) */
  order: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onField: (patch: Partial<Pick<ClientItem, 'client' | 'contact' | 'channel' | 'workType'>>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onAddBlock: (kind: ContentBlock['kind']) => void;
  onUpdateBlock: (ci: number, block: ContentBlock) => void;
  onMoveBlock: (ci: number, dir: -1 | 1) => void;
  onRemoveBlock: (ci: number) => void;
}

export const VISUAL_INPUT_CLS =
  'rounded-sharp border border-rule bg-bg-elevated px-2.5 py-1.5 text-[13px] text-fg outline-none transition focus:border-accent';

/** 상단 고정 라벨 + 입력 — 값을 채운 뒤에도 필드 의미가 보이도록 */
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
    <label
      className={['flex flex-col gap-1', grow ? 'min-w-[180px] flex-1' : '', width ?? ''].join(' ')}
    >
      <span className="text-[11px] font-medium text-fg-soft">
        {label}
        {required && <span style={{ color: 'var(--stamp-red, #DC2626)' }}> *</span>}
      </span>
      {children}
    </label>
  );
}

/** 작업(@SUM) 항목 편집 카드 — 명시적 한국어 라벨, 본문 블록은 좌측 라인 계층 */
export function ItemEditor({
  item,
  order,
  canMoveUp,
  canMoveDown,
  onField,
  onMove,
  onRemove,
  onAddBlock,
  onUpdateBlock,
  onMoveBlock,
  onRemoveBlock,
}: ItemEditorProps) {
  return (
    <div className="rounded-card border border-rule bg-bg-elevated p-3">
      {/* 카드 헤더 — 순번 + 이동/삭제 */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-fg">작업 {order}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
          {item.client ? `[${item.client}]` : ''} {item.workType}
        </span>
        <IconBtn title="위로 이동" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp size={13} />
        </IconBtn>
        <IconBtn title="아래로 이동" disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown size={13} />
        </IconBtn>
        <IconBtn title="작업 삭제" onClick={onRemove}>
          <Trash2 size={13} />
        </IconBtn>
      </div>

      {/* 헤더 필드 — 고정 라벨 */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <Field label="고객사" required width="w-28">
          <input
            type="text"
            value={item.client}
            placeholder="ABZ+"
            onChange={(e) => onField({ client: e.target.value })}
            className={`${VISUAL_INPUT_CLS} ${item.client.trim() ? '' : 'border-red-400'}`}
          />
        </Field>
        <Field label="담당자" width="w-28">
          <input
            type="text"
            value={item.contact ?? ''}
            placeholder="(생략 가능)"
            onChange={(e) => onField({ contact: e.target.value })}
            className={VISUAL_INPUT_CLS}
          />
        </Field>
        <Field label="채널" width="w-28">
          <input
            type="text"
            value={item.channel ?? ''}
            placeholder="메일 / 유선"
            list="visual-channel-options"
            onChange={(e) => onField({ channel: e.target.value })}
            className={VISUAL_INPUT_CLS}
          />
        </Field>
        <Field label="작업 설명" grow>
          <input
            type="text"
            value={item.workType}
            placeholder="예: 수집서버 방화벽 포트 통신 확인 요청"
            onChange={(e) => onField({ workType: e.target.value })}
            className={VISUAL_INPUT_CLS}
          />
        </Field>
      </div>

      {/* 본문 블록 — 좌측 라인으로 계층 표현 (박스 중첩 대신) */}
      {item.content.length > 0 && (
        <div className="mt-3 space-y-3 border-l-2 border-rule pl-3">
          {item.content.map((block, ci) => (
            <ContentBlockEditor
              key={ci}
              block={block}
              canMoveUp={ci > 0}
              canMoveDown={ci < item.content.length - 1}
              onChange={(b) => onUpdateBlock(ci, b)}
              onMove={(dir) => onMoveBlock(ci, dir)}
              onRemove={() => onRemoveBlock(ci)}
            />
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <AddBlockBtn icon={<ListOrdered size={12} />} label="번호 작업" onClick={() => onAddBlock('numbered')} />
        <AddBlockBtn icon={<MessageSquare size={12} />} label="문의 · 답변" onClick={() => onAddBlock('qa')} />
        <AddBlockBtn icon={<List size={12} />} label="불릿 목록" onClick={() => onAddBlock('bullets')} />
      </div>
      <datalist id="visual-channel-options">
        {KNOWN_CHANNELS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

const BLOCK_META: Record<ContentBlock['kind'], { label: string; hint: string }> = {
  numbered: { label: '번호 작업', hint: '표에서 "1) 제목 + 세부" 형태' },
  qa: { label: '문의 · 답변', hint: '표에서 "<- 문의 / -> 답변" 형태' },
  bullets: { label: '불릿 목록', hint: '표에서 "- 항목" 형태' },
};

function ContentBlockEditor({
  block,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
}: {
  block: ContentBlock;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (b: ContentBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const meta = BLOCK_META[block.kind];
  const lines = (v: string) => v.split('\n');
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold text-fg-soft" title={meta.hint}>
          {block.kind === 'numbered' ? `번호 작업 ${block.index})` : meta.label}
        </span>
        <span className="flex-1" />
        <IconBtn title="위로 이동" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp size={12} />
        </IconBtn>
        <IconBtn title="아래로 이동" disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown size={12} />
        </IconBtn>
        <IconBtn title="블록 삭제" onClick={onRemove}>
          <Trash2 size={12} />
        </IconBtn>
      </div>

      <div className="space-y-1.5">
        {block.kind === 'numbered' && (
          <>
            <input
              type="text"
              value={block.title}
              placeholder="작업 제목 — 예: 서버모니터링 에이전트 설치 지원"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
              className={`${VISUAL_INPUT_CLS} w-full`}
            />
            <LineArea
              value={block.details.join('\n')}
              placeholder={'세부 내용 — 한 줄에 하나씩\n보조 설명(회색 노트)은 "> "로 시작'}
              onChange={(v) => onChange({ ...block, details: lines(v) })}
            />
          </>
        )}
        {block.kind === 'qa' && (
          <>
            <input
              type="text"
              value={block.question ?? ''}
              placeholder="문의 내용 — 예: 임계치 초과 이벤트가 발생하지 않습니다"
              onChange={(e) => onChange({ ...block, question: e.target.value || undefined })}
              className={`${VISUAL_INPUT_CLS} w-full`}
            />
            <LineArea
              value={block.answers.join('\n')}
              placeholder={'답변 — 한 줄에 하나씩\n보조 설명(회색 노트)은 "> "로 시작'}
              onChange={(v) => onChange({ ...block, answers: lines(v) })}
            />
          </>
        )}
        {block.kind === 'bullets' && (
          <LineArea
            value={block.items.join('\n')}
            placeholder={'항목 — 한 줄에 하나씩\n보조 설명(회색 노트)은 "> "로 시작'}
            onChange={(v) => onChange({ ...block, items: lines(v) })}
          />
        )}
      </div>
    </div>
  );
}

function LineArea({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={Math.max(2, value.split('\n').length)}
      className="w-full resize-y rounded-sharp border border-rule bg-bg-elevated px-2.5 py-1.5 text-[13px] leading-relaxed text-fg outline-none transition focus:border-accent"
    />
  );
}

function IconBtn({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex shrink-0 items-center rounded-sharp p-1 text-fg-muted transition hover:bg-bg-sunken hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function AddBlockBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-sharp border border-rule px-2.5 py-1 text-[12px] text-fg-soft transition hover:border-accent hover:text-fg"
    >
      <Plus size={11} />
      {icon}
      {label}
    </button>
  );
}
