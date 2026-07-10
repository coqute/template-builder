import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ClientItem, ContentBlock } from '@core/index';
import { KNOWN_CHANNELS } from '@core/index';

interface ItemEditorProps {
  item: ClientItem;
  /** 날짜 내 전역 순번 (1-based) — 고스트 넘버럴 */
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

/** 캡션 + 밑줄 필드 — 원고지 조판의 기본 입력 단위 */
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
      <span className="ms-caption">
        {label}
        {required && <span style={{ color: 'var(--stamp-red, #DC2626)' }}> *</span>}
      </span>
      {children}
    </label>
  );
}

/** 작업 항목 — 고스트 넘버럴 + 밑줄 필드. 박스 없음 */
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
    <div className="work-entry group">
      {/* 고스트 넘버럴 — 편집 중 잉크가 차오름 (tokens.css) */}
      <div className="work-numeral" aria-hidden="true">
        {String(order).padStart(2, '0')}
      </div>

      <div className="min-w-0">
        {/* 헤더 필드 행 — 액션은 우측에 옅게 (hover·편집 시 선명) */}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <Field label="고객사" required width="w-28">
            <input
              type="text"
              value={item.client}
              placeholder="ABZ+"
              onChange={(e) => onField({ client: e.target.value })}
              className="ms-input"
              style={item.client.trim() ? undefined : { borderBottomColor: 'var(--stamp-red, #DC2626)' }}
            />
          </Field>
          <Field label="담당자" width="w-28">
            <input
              type="text"
              value={item.contact ?? ''}
              placeholder="(생략 가능)"
              onChange={(e) => onField({ contact: e.target.value })}
              className="ms-input"
            />
          </Field>
          <Field label="채널" width="w-28">
            <input
              type="text"
              value={item.channel ?? ''}
              placeholder="메일 / 유선"
              list="visual-channel-options"
              onChange={(e) => onField({ channel: e.target.value })}
              className="ms-input"
            />
          </Field>
          <Field label="작업 설명" grow>
            <input
              type="text"
              value={item.workType}
              placeholder="예: 수집서버 방화벽 포트 통신 확인 요청"
              onChange={(e) => onField({ workType: e.target.value })}
              className="ms-input"
            />
          </Field>
          <span className="mb-1 flex items-center gap-0.5 opacity-35 transition group-focus-within:opacity-100 group-hover:opacity-100">
            <IconBtn title="위로 이동" disabled={!canMoveUp} onClick={() => onMove(-1)}>
              <ArrowUp size={13} />
            </IconBtn>
            <IconBtn title="아래로 이동" disabled={!canMoveDown} onClick={() => onMove(1)}>
              <ArrowDown size={13} />
            </IconBtn>
            <IconBtn title="작업 삭제" onClick={onRemove}>
              <Trash2 size={13} />
            </IconBtn>
          </span>
        </div>

        {/* 본문 블록 — 캡션과 여백만으로 구분 (박스·계층선 없음) */}
        {item.content.length > 0 && (
          <div className="mt-4 space-y-4">
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
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <button type="button" className="ms-add" onClick={() => onAddBlock('numbered')}>
            <Plus size={11} /> 번호 작업
          </button>
          <button type="button" className="ms-add" onClick={() => onAddBlock('qa')}>
            <Plus size={11} /> 문의 · 답변
          </button>
          <button type="button" className="ms-add" onClick={() => onAddBlock('bullets')}>
            <Plus size={11} /> 불릿 목록
          </button>
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
    <div className="group/block">
      <div className="mb-1 flex items-center gap-2">
        <span className="ms-caption" title={meta.hint}>
          {block.kind === 'numbered' ? `번호 작업 ${block.index})` : meta.label}
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-0.5 opacity-0 transition group-focus-within/block:opacity-100 group-hover/block:opacity-100">
          <IconBtn title="위로 이동" disabled={!canMoveUp} onClick={() => onMove(-1)}>
            <ArrowUp size={12} />
          </IconBtn>
          <IconBtn title="아래로 이동" disabled={!canMoveDown} onClick={() => onMove(1)}>
            <ArrowDown size={12} />
          </IconBtn>
          <IconBtn title="블록 삭제" onClick={onRemove}>
            <Trash2 size={12} />
          </IconBtn>
        </span>
      </div>

      <div className="space-y-1.5">
        {block.kind === 'numbered' && (
          <>
            <input
              type="text"
              value={block.title}
              placeholder="작업 제목 — 예: 서버모니터링 에이전트 설치 지원"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
              className="ms-input w-full"
            />
            <textarea
              value={block.details.join('\n')}
              placeholder={'세부 내용 — 한 줄에 하나씩, 노트는 "> "로 시작'}
              onChange={(e) => onChange({ ...block, details: lines(e.target.value) })}
              rows={Math.max(2, block.details.length)}
              className="ms-area"
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
              className="ms-input w-full"
            />
            <textarea
              value={block.answers.join('\n')}
              placeholder={'답변 — 한 줄에 하나씩, 노트는 "> "로 시작'}
              onChange={(e) => onChange({ ...block, answers: lines(e.target.value) })}
              rows={Math.max(2, block.answers.length)}
              className="ms-area"
            />
          </>
        )}
        {block.kind === 'bullets' && (
          <textarea
            value={block.items.join('\n')}
            placeholder={'항목 — 한 줄에 하나씩, 노트는 "> "로 시작'}
            onChange={(e) => onChange({ ...block, items: lines(e.target.value) })}
            rows={Math.max(2, block.items.length)}
            className="ms-area"
          />
        )}
      </div>
    </div>
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
