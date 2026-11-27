import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, scrollPastEnd } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import { acceptCompletion, autocompletion, completionStatus } from '@codemirror/autocomplete';
import {
  setLineMarker,
  setPins,
  worklogCompletions,
  worklogHighlight,
  worklogKeymap,
  worklogLinter,
  worklogPins,
  type LinePin,
  type MarkerKind,
} from '../worklog/editor';
import type { WlFileContext, WlFix } from '../worklog/lint';
import type { Vocabulary } from '../worklog/search';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** 열린 파일 — 1행 제목·파일명 제안용 (없으면 그 제안을 하지 않는다) */
  file: WlFileContext | null;
  vocab: Vocabulary;
  onFix: (fix: WlFix) => void;
  onBlur?: () => void;
  /** ■ 줄 끝에 붙일 표지 — 그 사안에 달린 할 일·일정 (파일에는 들어가지 않는다) */
  pins?: LinePin[];
  onPin?: (id: string) => void;
}

/** 맨 위로 올릴 때 그 줄 위에 두는 틈(px) */
export const JUMP_TOP_GAP = 8;

export interface WorklogEditorHandle {
  /**
   * 그 줄로 간다. `top`이면 그 줄을 편집 영역 **맨 위**에 놓는다 — 홈에서 할 일·일정의 사안을 열 때,
   * 사안이 화면 아래쪽에 걸리지 않고 처음부터 한눈에 읽히게(기본은 보이기만 하면 되는 최소 이동).
   */
  jumpToLine(line: number, opts?: { top?: boolean }): void;
  setMarker(kind: MarkerKind): void;
  /** 커서 자리에 끼워 넣는다 — 줄 중간이면 다음 줄에, 앞뒤 빈 줄 하나씩 */
  insertBlock(text: string): void;
  /** 파일 끝에 빈 줄 하나를 두고 붙인다 */
  appendBlock(text: string): void;
  selectedText(): string;
  cursorLine(): number;
  focus(): void;
}

export const WorklogEditor = forwardRef<WorklogEditorHandle, Props>(function WorklogEditor(
  { value, onChange, file, vocab, onFix, onBlur, pins, onPin },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const fileRef = useRef(file);
  fileRef.current = file;
  const vocabRef = useRef(vocab);
  vocabRef.current = vocab;
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;

  useImperativeHandle(
    ref,
    () => ({
      jumpToLine(line: number, opts?: { top?: boolean }) {
        const view = viewRef.current;
        if (!view) return;
        const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
        if (opts?.top) view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: JUMP_TOP_GAP }) });
        else view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
        view.focus();
      },
      setMarker(kind: MarkerKind) {
        if (viewRef.current) setLineMarker(viewRef.current, kind);
      },
      insertBlock(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const { state } = view;
        const line = state.doc.lineAt(state.selection.main.head);
        const at = line.text.trim() ? line.to : line.from;
        const before = state.doc.sliceString(0, at);
        const after = state.doc.sliceString(at);
        const lead = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const trail = !after.trim() ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
        const insert = `${lead}${text.replace(/\s+$/, '')}${trail}`;
        view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + lead.length + text.replace(/\s+$/, '').length }, scrollIntoView: true });
        view.focus();
      },
      appendBlock(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc.toString();
        const head = doc.replace(/\s+$/, '');
        const body = text.replace(/\s+$/, '');
        const next = head ? `${head}\n\n${body}` : body;
        view.dispatch({ changes: { from: 0, to: doc.length, insert: next }, selection: { anchor: next.length }, scrollIntoView: true });
        view.focus();
      },
      selectedText() {
        const view = viewRef.current;
        if (!view) return '';
        const s = view.state.selection.main;
        return view.state.sliceDoc(s.from, s.to);
      },
      cursorLine() {
        const view = viewRef.current;
        return view ? view.state.doc.lineAt(view.state.selection.main.head).number : 0;
      },
      focus() {
        viewRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        // Ctrl+Enter·Ctrl+숫자는 앱·작업일지 단축키 — CodeMirror 기본 동작과 겹치지 않게 뺀다
        keymap.of([...defaultKeymap.filter((b) => b.key !== 'Mod-Enter'), ...historyKeymap]),
        EditorView.lineWrapping,
        // 끝 줄도 맨 위까지 올라올 수 있게 아래에 여백을 둔다 — 그날의 마지막 사안도 맨 위에 놓을 수 있어야 한다
        scrollPastEnd(),
        worklogHighlight,
        lintGutter(),
        worklogLinter(
          () => fileRef.current,
          (fix) => onFixRef.current(fix),
        ),
        autocompletion({ override: [worklogCompletions(() => vocabRef.current)] }),
        worklogPins((id) => onPinRef.current?.(id)),
        Prec.highest(
          keymap.of([{ key: 'Tab', run: (v) => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : false) }]),
        ),
        Prec.high(worklogKeymap),
        keymap.of([indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.focusChanged && !u.view.hasFocus) onBlurRef.current?.();
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
          '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7' },
          '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
          '.cm-cursor, .cm-cursor-primary, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
          '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
          '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
          '.cm-activeLine': { backgroundColor: 'var(--bg-sunken)' },
          '.cm-activeLineGutter': { backgroundColor: 'var(--bg-sunken)', color: 'var(--fg-soft)' },
          '.cm-gutters': { backgroundColor: 'var(--bg-deep)', color: 'var(--fg-muted)', borderRight: '1px solid var(--rule)' },
          '.cm-lintRange-info': { backgroundImage: 'none', borderBottom: '1px dotted var(--fg-faint)' },
          '.cm-lintRange-warning': { backgroundImage: 'none', borderBottom: '1px dashed var(--stamp-amber)' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 편집기는 한 번 만들고 값은 아래 effect로 맞춘다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    // 바깥에서 바뀐 본문(파일 열기·루틴 덧붙이기 합침·AI 적용) — 커서는 가능한 한 그 자리에
    const head = Math.min(view.state.selection.main.head, value.length);
    view.dispatch({ changes: { from: 0, to: cur.length, insert: value }, selection: { anchor: head } });
  }, [value]);

  // 표지는 본문이 맞춰진 뒤에 다시 그린다 (줄 번호는 지금 본문 기준)
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setPins.of(pins ?? []) });
  }, [pins, value]);

  return (
    <div className="relative h-full overflow-hidden bg-bg-elevated">
      <div ref={hostRef} className="scrollbar-thin h-full" data-testid="worklog-editor" />
    </div>
  );
});
