import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// 본문 트레일링은 모두 선택(`(?:\s.*)?`) — 타이핑 중(디렉티브만 입력된 상태)에도 즉시 하이라이트.
// 관용 파서(parser.ts)가 수용하는 라인은 여기서도 칠해지도록 동형 유지.
const TOKEN_RULES: Array<{ re: RegExp; cls: string }> = [
  { re: /^@(?:PREV|WEEK)(?:\s.*)?$/, cls: 'tok-week' },
  { re: /^@(?:CURRENT|NEXT)(?:\s.*)?$/, cls: 'tok-next' },
  { re: /^@AUTHOR(?:\s.*)?$/, cls: 'tok-author' },
  // 유연 날짜 표기 허용 — 파서 RE_DAY_FLEX와 동형 (점/슬래시 구분자, 한 자리 월일, 요일 생략)
  { re: /^#\s*\d{4}[-./]\d{1,2}[-./]\d{1,2}\s*(?:\([^)]*\))?\s*$/, cls: 'tok-day' },
  { re: /^@LOC(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@CUS(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@SUM(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^##(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^@HOLIDAY(?:\s.*)?$/, cls: 'tok-holiday' },
  { re: /^\d+\)(?:\s.*)?$/, cls: 'tok-num' },
  { re: /^-(?:\s.*)?$/, cls: 'tok-dash' },
  { re: /^<-(?:\s.*)?$/, cls: 'tok-qaq' },
  { re: /^->(?:\s.*)?$/, cls: 'tok-qaa' },
  { re: /^>(?:\s.*)?$/, cls: 'tok-note' },
];

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      for (const rule of TOKEN_RULES) {
        if (rule.re.test(text)) {
          builder.add(line.from, line.from, Decoration.line({ class: rule.cls }));
          break;
        }
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
