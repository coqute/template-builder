import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { highlightClassFor } from '@core/grammar';

// 하이라이트 규칙의 단일 소스는 core/grammar.ts (HIGHLIGHT_RULES) —
// 파서 수용 라인 ⊆ 하이라이트 매치 동형성은 tests/grammar-iso.test.ts가 고정한다.

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const cls = highlightClassFor(line.text);
      if (cls) {
        builder.add(line.from, line.from, Decoration.line({ class: cls }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const reportSyntaxHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
