import { useEffect, useRef } from 'react';
import { Bold, Code, Image as ImageIcon, Italic, Link2, List, ListOrdered, Table, Underline } from 'lucide-react';
import { sanitizeBodyHtml } from '../sanitize';

interface Props {
  /** 초기 HTML (비제어 — mount/리셋 시에만 주입). 외부 리셋은 부모가 key remount */
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onImageOversize?: () => void;
}

const MAX_IMAGE_BYTES = 1_500_000; // 1.5MB — base64 가드

export function RichBodyEditor({ initialHtml, onChange, placeholder, onImageOversize }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // mount 시 1회 주입 (비제어 — value 재주입 안 함 → 커서 보존)
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    if (ref.current) onChangeRef.current(sanitizeBodyHtml(ref.current.innerHTML));
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
      const dataUrl = String(reader.result);
      ref.current?.focus();
      document.execCommand(
        'insertHTML',
        false,
        `<img src="${dataUrl}" style="max-width:100%;" alt="" />`,
      );
      emit();
    };
    reader.readAsDataURL(file);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
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
    // 2) HTML → sanitize 후 삽입
    const html = dt.getData('text/html');
    if (html) {
      document.execCommand('insertHTML', false, sanitizeBodyHtml(html));
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
    const url = window.prompt('링크 URL을 입력하세요 (https:// 또는 mailto:)');
    if (url) exec('createLink', url);
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
    const sel = window.getSelection()?.toString() ?? '';
    insertHtmlAtCursor(`<pre>${sel || '명령어 / 코드'}</pre><p><br/></p>`);
  };

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
          className="flex cursor-pointer items-center rounded-sharp p-1 text-fg-soft hover:bg-bg-sunken hover:text-fg"
          title="이미지 삽입"
        >
          <ImageIcon size={13} />
          <input type="file" accept="image/*" className="hidden" onChange={onImagePick} />
        </label>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onPaste={onPaste}
        data-placeholder={placeholder}
        className="email-body-editor scrollbar-thin h-full flex-1 overflow-auto px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none"
      />
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
