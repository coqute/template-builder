import { useEffect, useRef } from 'react';
import { Bold, Code, Image as ImageIcon, Italic, Link2, List, ListOrdered, Table, Underline } from 'lucide-react';
import { sanitizeBodyHtml } from '../sanitize';
import { normalizeUrl } from '../url';
import { escapeHtml } from '../../lib/html';

interface Props {
  /** 초기 HTML (비제어 — mount/리셋 시에만 주입). 외부 리셋은 부모가 key remount */
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onImageOversize?: () => void;
  /** 자주 쓰는 본문 문구 (템플릿 bodyPresets) — 드롭다운으로 커서 위치에 삽입 */
  presets?: string[];
}

const MAX_IMAGE_BYTES = 1_500_000; // 1.5MB — base64 가드

export function RichBodyEditor({ initialHtml, onChange, placeholder, onImageOversize, presets }: Props) {
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
              className="max-w-[160px] rounded-sharp border border-rule bg-bg-elevated px-1.5 py-0.5 text-[11px] text-fg-soft outline-none focus:border-accent"
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
