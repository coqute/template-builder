import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
  completionStatus,
} from '@codemirror/autocomplete';
import { reportSyntaxHighlight } from '../codemirror/grammar';
import { reportLinter } from '../codemirror/lint';
import { reportCompletions } from '../codemirror/completion';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export interface MarkdownEditorHandle {
  /** 1-based 라인으로 커서 이동 + 스크롤 + 포커스 (StatusBar 진단 클릭 점프용) */
  jumpToLine(line: number): void;
  /** 커서가 있는 1-based 라인 (모드 전환 시 같은 위치를 비주얼에서 열기 위해) */
  cursorLine(): number;
}

/**
 * Tab 키 자동완성 핸들러:
 * ① 자동완성 팝업이 떠 있으면 → Tab으로 선택 항목 확정 (acceptCompletion)
 * ② 라인 시작 트리거(@디렉티브 / `# `일자) 위치면 → Tab으로 팝업 오픈 (startCompletion)
 * ③ 그 외 위치면 → false 반환하여 기본 동작에 양보
 * reportCompletions의 트리거 조건과 동일하게 맞춰 예측 가능하게 동작.
 */
function tabComplete(view: EditorView): boolean {
  if (completionStatus(view.state) === 'active') {
    return acceptCompletion(view);
  }
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (/^\s*@\w*$/.test(before) || /^#\s*$/.test(before)) {
    return startCompletion(view);
  }
  return false;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { value, onChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(
    ref,
    () => ({
      jumpToLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const n = Math.min(Math.max(line, 1), view.state.doc.lines);
        const l = view.state.doc.line(n);
        view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
        view.focus();
      },
      cursorLine() {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.doc.lineAt(view.state.selection.main.head).number;
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
        // Ctrl+Enter는 앱 전역 단축키(임시보관함) — CodeMirror 기본의 "빈 줄 삽입"과 겹치지 않게 뺀다
        keymap.of([...defaultKeymap.filter((b) => b.key !== 'Mod-Enter'), ...historyKeymap]),
        EditorView.lineWrapping,
        reportSyntaxHighlight,
        lintGutter(),
        reportLinter(),
        autocompletion({ override: [reportCompletions] }),
        // Tab으로 자동완성 확정/오픈 (defaultKeymap·completionKeymap보다 우선).
        // 자동완성 대상이 아니면 Tab/Shift+Tab = 2칸 들여쓰기/내어쓰기 (대화 이력 계층)
        Prec.highest(keymap.of([{ key: 'Tab', run: tabComplete }])),
        keymap.of([indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString();
            onChangeRef.current(next);
          }
        }),
        EditorView.theme(
          {
            '&': {
              height: '100%',
              backgroundColor: 'transparent',
              color: 'var(--fg)',
            },
            '.cm-scroller': { fontFamily: 'inherit' },
            '.cm-content': {
              padding: '12px 0',
              caretColor: 'var(--accent)',
            },
            '.cm-cursor, .cm-cursor-primary, .cm-dropCursor': {
              borderLeft: '2px solid var(--accent)',
            },
            '&.cm-focused .cm-cursor, &.cm-focused .cm-cursor-primary': {
              borderLeft: '2px solid var(--accent)',
            },
            '.cm-selectionBackground, ::selection': {
              backgroundColor: 'var(--selection)',
            },
            '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground':
              {
                backgroundColor: 'var(--selection)',
              },
            '.cm-activeLine': {
              backgroundColor: 'var(--bg-sunken)',
            },
            '.cm-activeLineGutter': {
              backgroundColor: 'var(--bg-sunken)',
              color: 'var(--fg-soft)',
            },
            '.cm-gutters': {
              backgroundColor: 'var(--bg-deep)',
              color: 'var(--fg-muted)',
              borderRight: '1px solid var(--rule)',
            },
            '.cm-lintRange-info': {
              backgroundImage: 'none',
              borderBottom: '1px dotted var(--fg-faint)',
            },
          },
          { dark: false },
        ),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    const prevSelection = view.state.selection;
    const docLen = value.length;
    const anchor = Math.min(prevSelection.main.anchor, docLen);
    const head = Math.min(prevSelection.main.head, docLen);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor, head },
    });
  }, [value]);

  return (
    <div className="relative h-full overflow-hidden bg-bg-elevated">
      <div ref={hostRef} className="scrollbar-thin h-full" />
    </div>
  );
});
