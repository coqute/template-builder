import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ClientItem, ContentBlock } from '@core/index';
import { KNOWN_CHANNELS } from '@core/index';

interface ItemEditorProps {
  item: ClientItem;
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

const inputCls =
  'rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-accent';

/** @SUM 항목 편집 — [고객사] (담당자/채널) 작업 + 본문 블록(번호/Q&A/불릿) */
export function ItemEditor({
  item,
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
    <div className="rounded-sharp border border-rule bg-bg p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold text-fg-muted">@SUM</span>
        <input
          type="text"
          value={item.client}
          placeholder="고객사 *"
          onChange={(e) => onField({ client: e.target.value })}
          className={`${inputCls} w-24 ${item.client.trim() ? '' : 'border-red-400'}`}
          title={item.client.trim() ? '고객사' : '고객사는 필수입니다'}
        />
        <input
          type="text"
          value={item.contact ?? ''}
          placeholder="담당자"
          onChange={(e) => onField({ contact: e.target.value })}
          className={`${inputCls} w-24`}
        />
        <input
          type="text"
          value={item.channel ?? ''}
          placeholder="채널"
          list="visual-channel-options"
          onChange={(e) => onField({ channel: e.target.value })}
          className={`${inputCls} w-24`}
          title="메일 / 유선 / 유선&메일 — 담당자가 있을 때만 표기됩니다"
        />
        <input
          type="text"
          value={item.workType}
          placeholder="작업 설명"
          onChange={(e) => onField({ workType: e.target.value })}
          className={`${inputCls} min-w-[160px] flex-1`}
        />
        <IconBtn title="위로" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp size={12} />
        </IconBtn>
        <IconBtn title="아래로" disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown size={12} />
        </IconBtn>
        <IconBtn title="작업 삭제" onClick={onRemove}>
          <Trash2 size={12} />
        </IconBtn>
      </div>

      <div className="mt-1.5 space-y-1.5">
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
        <div className="flex items-center gap-1">
          <AddBlockBtn label="1) 번호 작업" onClick={() => onAddBlock('numbered')} />
          <AddBlockBtn label="<- Q&A" onClick={() => onAddBlock('qa')} />
          <AddBlockBtn label="- 불릿" onClick={() => onAddBlock('bullets')} />
        </div>
      </div>
      <datalist id="visual-channel-options">
        {KNOWN_CHANNELS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
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
}: {
  block: ContentBlock;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (b: ContentBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const lines = (v: string) => v.split('\n');
  return (
    <div className="rounded-sharp border border-rule bg-bg-deep p-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-fg-muted">
          {block.kind === 'numbered' ? `${block.index})` : block.kind === 'qa' ? '<- / ->' : '- 불릿'}
        </span>
        {block.kind === 'numbered' && (
          <input
            type="text"
            value={block.title}
            placeholder="작업 제목"
            onChange={(e) => onChange({ ...block, title: e.target.value })}
            className={`${inputCls} min-w-0 flex-1`}
          />
        )}
        {block.kind === 'qa' && (
          <input
            type="text"
            value={block.question ?? ''}
            placeholder="<- 질문/문의"
            onChange={(e) => onChange({ ...block, question: e.target.value || undefined })}
            className={`${inputCls} min-w-0 flex-1`}
          />
        )}
        {block.kind === 'bullets' && <span className="flex-1" />}
        <IconBtn title="위로" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp size={11} />
        </IconBtn>
        <IconBtn title="아래로" disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown size={11} />
        </IconBtn>
        <IconBtn title="블록 삭제" onClick={onRemove}>
          <Trash2 size={11} />
        </IconBtn>
      </div>
      {block.kind === 'numbered' && (
        <LineArea
          value={block.details.join('\n')}
          placeholder={'세부 내용 (줄마다 하나, 노트는 "> "로 시작)'}
          onChange={(v) => onChange({ ...block, details: lines(v) })}
        />
      )}
      {block.kind === 'qa' && (
        <LineArea
          value={block.answers.join('\n')}
          placeholder={'답변 (줄마다 -> 하나, 노트는 "> "로 시작)'}
          onChange={(v) => onChange({ ...block, answers: lines(v) })}
        />
      )}
      {block.kind === 'bullets' && (
        <LineArea
          value={block.items.join('\n')}
          placeholder={'항목 (줄마다 하나, 노트는 "> "로 시작)'}
          onChange={(v) => onChange({ ...block, items: lines(v) })}
        />
      )}
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
      className="w-full resize-y rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs leading-relaxed text-fg outline-none focus:border-accent"
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

function AddBlockBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-sharp border border-dashed border-rule px-2 py-0.5 font-mono text-[10px] text-fg-muted transition hover:border-accent hover:text-fg"
    >
      <Plus size={10} />
      {label}
    </button>
  );
}
