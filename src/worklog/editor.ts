/**
 * 작업일지 편집기 확장 — 줄 종류 강조, 요청자·채널 자동완성, 형식 제안, 이어 쓰기 키.
 * 줄 종류는 블록 문맥(전달물 원문 등)이 필요해 문서 전체를 다시 읽는다 — 일지 한 개는 수 KB라 키 입력마다 1ms 미만.
 */
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate, keymap } from '@codemirror/view';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { parseWorklog, type WlLineKind } from './format';
import { lintWorklog, type WlFileContext, type WlFix } from './lint';
import type { Vocabulary } from './search';

const LINE_CLASS: Partial<Record<WlLineKind, string>> = {
  title: 'wl-title',
  case: 'wl-case',
  note: 'wl-note',
  act: 'wl-act',
  fact: 'wl-fact',
  detail: 'wl-detail',
  deliverable: 'wl-deliverable',
  raw: 'wl-raw',
  numbered: 'wl-numbered',
};

export function lineKinds(state: EditorState): WlLineKind[] {
  return parseWorklog(state.doc.toString()).lines.map((l) => l.kind);
}

function buildDecorations(view: EditorView, kinds: WlLineKind[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const cls = LINE_CLASS[kinds[line.number - 1]];
      if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const worklogHighlight = ViewPlugin.fromClass(
  class {
    kinds: WlLineKind[];
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.kinds = lineKinds(view.state);
      this.decorations = buildDecorations(view, this.kinds);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.kinds = lineKinds(u.state);
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view, this.kinds);
    }
  },
  { decorations: (v) => v.decorations },
);

/** ■ 줄 끝에 붙는 표지 — 그 사안에 달린 할 일·일정. 화면에만 그리고 파일에는 들어가지 않는다 */
export interface LinePin {
  /** 줄 번호 (1부터) */
  line: number;
  label: string;
  id: string;
}

export const setPins = StateEffect.define<LinePin[]>();

class PinWidget extends WidgetType {
  constructor(
    readonly pin: LinePin,
    readonly onClick: (id: string) => void,
  ) {
    super();
  }
  eq(other: PinWidget): boolean {
    return other.pin.id === this.pin.id && other.pin.label === this.pin.label;
  }
  toDOM(): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wl-pin';
    b.textContent = `${this.pin.label} ↗`;
    b.title = '홈의 그 항목으로 갑니다 — 이 표지는 화면에만 있고 파일에는 들어가지 않습니다';
    // mousedown에서 막아야 편집기 커서가 움직이지 않는다
    b.onmousedown = (e) => {
      e.preventDefault();
      this.onClick(this.pin.id);
    };
    return b;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export function worklogPins(onClick: (id: string) => void): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setPins)) continue;
        const b = new RangeSetBuilder<Decoration>();
        for (const p of [...e.value].sort((x, y) => x.line - y.line)) {
          if (p.line < 1 || p.line > tr.state.doc.lines) continue;
          const at = tr.state.doc.line(p.line).to;
          b.add(at, at, Decoration.widget({ widget: new PinWidget(p, onClick), side: 1 }));
        }
        next = b.finish();
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** `■ (` 뒤 요청자, `■ (이름/` 뒤 채널 */
export function worklogCompletions(getVocab: () => Vocabulary) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const vocab = getVocab();
    const ch = /^■\s*\(([^()]*)\/([^()/]*)$/.exec(before);
    if (ch) {
      const options: Completion[] = vocab.channels.map((c) => ({
        label: c.name,
        detail: c.count ? `${c.count}회` : undefined,
        type: 'keyword',
        apply: `${c.name}) `,
      }));
      return { from: ctx.pos - ch[2].length, options, validFor: /^[^()/]*$/ };
    }
    const who = /^■\s*\(([^()/]*)$/.exec(before);
    if (who) {
      const seg = who[1].split(/[,·]\s*/).pop() ?? '';
      if (!seg && !ctx.explicit && who[1].trim()) return null; // 쉼표 바로 뒤는 사람이 이어 쓴다
      const options: Completion[] = vocab.requesters.slice(0, 200).map((r) => ({
        label: r.name,
        detail: `${r.count}회`,
        type: 'variable',
      }));
      return { from: ctx.pos - seg.length, options, validFor: /^[^(),·/]*$/ };
    }
    return null;
  };
}

/** 형식 제안 — 밑줄은 정보 수준, 고칠 수 있는 것은 동작 버튼 */
export function worklogLinter(getFile: () => WlFileContext | null, onFix: (fix: WlFix) => void): Extension {
  return linter(
    (view) => {
      const doc = view.state.doc;
      const out: Diagnostic[] = [];
      try {
        for (const i of lintWorklog(doc.toString(), getFile())) {
          const l = doc.line(Math.min(Math.max(i.line, 1), doc.lines));
          out.push({
            from: l.from,
            to: l.to,
            severity: i.severity,
            message: i.message,
            actions: i.fixes?.map((f) => ({ name: f.label, apply: () => onFix(f.fix) })),
          });
        }
      } catch {
        // 제안이 편집기를 멈추게 하면 안 된다
      }
      return out;
    },
    { delay: 400 },
  );
}

export type MarkerKind = 'case' | 'act' | 'fact' | 'detail' | 'note';

export const MARKERS: Record<MarkerKind, string> = {
  case: '■ ',
  act: '▶ ',
  fact: '- ',
  detail: '  > ',
  note: '※ ',
};

const ANY_MARKER = /^(?:[■▶※]\s*|-\s+|-$|\s*>\s?)/;

/** 지금 줄의 머리 기호를 바꾼다 — 같은 기호면 뗀다 */
export function setLineMarker(view: EditorView, kind: MarkerKind): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const marker = MARKERS[kind];
  const has = line.text.startsWith(marker) || (kind === 'detail' && /^\s*>\s?/.test(line.text));
  const body = line.text.replace(ANY_MARKER, '');
  const next = has ? body : marker + body;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    selection: { anchor: line.from + next.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** 줄 끝에서 Enter — `▶`·`-` 다음은 `- `, `  >` 다음은 `  > `. 기호만 있는 줄에서 Enter는 기호를 지운다 */
export function continueMarker(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const kind = lineKinds(state)[line.number - 1];
  if (kind === 'raw' || kind === 'deliverable' || kind === 'title' || kind === 'case') return false;
  const t = line.text;
  if (/^(?:▶|-)\s*$/.test(t) || /^\s*>\s*$/.test(t)) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
    return true;
  }
  let insert: string | null = null;
  if (/^▶\s*\S/.test(t) || /^-\s+\S/.test(t)) insert = '\n- ';
  else {
    const d = /^(\s*)>\s*\S/.exec(t);
    if (d) insert = `\n${d[1] || '  '}> `;
  }
  if (!insert) return false;
  view.dispatch({ changes: { from: sel.head, insert }, selection: { anchor: sel.head + insert.length }, scrollIntoView: true });
  return true;
}

/** Tab: `- 사실` → `  > 부연`, Shift+Tab: 되돌림 */
function demote(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^-(?:\s+|$)/.exec(line.text);
  if (!m) return false;
  const next = `  > ${line.text.slice(m[0].length)}`;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, selection: { anchor: line.from + next.length } });
  return true;
}

function promote(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^\s*>\s?/.exec(line.text);
  if (!m) return false;
  const next = `- ${line.text.slice(m[0].length)}`;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, selection: { anchor: line.from + next.length } });
  return true;
}

export const worklogKeymap = keymap.of([
  { key: 'Enter', run: continueMarker },
  { key: 'Tab', run: demote },
  { key: 'Shift-Tab', run: promote },
  { key: 'Mod-1', run: (v) => setLineMarker(v, 'case'), preventDefault: true },
  { key: 'Mod-2', run: (v) => setLineMarker(v, 'act'), preventDefault: true },
  { key: 'Mod-3', run: (v) => setLineMarker(v, 'fact'), preventDefault: true },
  { key: 'Mod-4', run: (v) => setLineMarker(v, 'detail'), preventDefault: true },
  { key: 'Mod-5', run: (v) => setLineMarker(v, 'note'), preventDefault: true },
]);
