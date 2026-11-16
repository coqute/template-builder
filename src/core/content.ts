/**
 * 본문 줄 규칙 단일 소스 — `1)` · `->` · `<-` · `*<-` · `*==>` · `>` · `-` · 이어지는 줄.
 * parser(.md)와 importer(Gmail HTML/plain)가 같은 함수로 본문을 쌓아 왕복 해석이 어긋나지 않게 한다.
 * 형식 명세: 주간보고 형식 명세 §4.2~4.3
 */
import type { ClientItem, ContentBlock, DialogBlock, DialogTurn } from './types';
import { NOTE_PREFIX } from './types';
import { GRAMMAR } from './grammar';

/** 한 번에 표현할 수 있는 최대 들여쓰기 단계 */
export const MAX_INDENT = 6;

/** 줄 앞 공백 → 들여쓰기 단계. 2칸 = 1단계, 홀수 칸은 올림 (기준 보고서 3칸 → 2단계). 탭·전각 공백은 2칸 */
export function indentLevel(raw: string): number {
  const lead = /^[ \t 　]*/.exec(raw)?.[0] ?? '';
  let cols = 0;
  for (const ch of lead) cols += ch === '\t' || ch === '　' ? 2 : 1;
  return Math.min(MAX_INDENT, Math.ceil(cols / 2));
}

export type ContentLine =
  | { kind: 'num'; index: number; title: string }
  | { kind: 'turn'; turn: DialogTurn }
  | { kind: 'note'; text: string }
  | { kind: 'dash'; text: string };

/** 앞뒤 공백을 제거한 줄이 본문 마커 줄이면 해석 결과, 아니면 null (이어지는 줄·기타) */
export function matchContentLine(line: string): ContentLine | null {
  let m: RegExpMatchArray | null;
  if ((m = line.match(GRAMMAR.conclusion))) return { kind: 'turn', turn: { kind: 'conclusion', text: m[1] } };
  if ((m = line.match(GRAMMAR.pending))) {
    return { kind: 'turn', turn: { kind: m[1] === '<-' ? 'out' : 'in', text: m[2], pending: true } };
  }
  if ((m = line.match(GRAMMAR.num))) return { kind: 'num', index: Number.parseInt(m[1], 10), title: m[2] };
  if ((m = line.match(GRAMMAR.turnOut))) return { kind: 'turn', turn: { kind: 'out', text: m[1] } };
  if ((m = line.match(GRAMMAR.turnIn))) return { kind: 'turn', turn: { kind: 'in', text: m[1] } };
  if ((m = line.match(GRAMMAR.note))) return { kind: 'note', text: m[1] };
  if ((m = line.match(GRAMMAR.dash))) return { kind: 'dash', text: m[1] ?? '' };
  return null;
}

/** 빈 줄에서 리셋되는 "직전 블록" 포인터 — `-` 목록 연속·대화 턴 연속 판정에 쓴다 */
export interface ContentCursor {
  current?: ContentBlock;
}

function withIndent<T extends ContentBlock>(block: T, indent: number): T {
  return indent > 0 ? { ...block, indent } : block;
}

/**
 * 마커 줄을 항목 본문에 추가.
 * - `1)` → 새 번호 블록
 * - 턴(`->` `<-` `*<-` `*==>`) → 직전 블록이 같은 들여쓰기의 대화면 이어 붙이고, 아니면 새 대화 블록
 * - `>` → 항목의 마지막 블록에 부착 (번호: 세부 노트 / 대화: 노트 턴 / 목록: 노트 항목)
 * - `-` → 직전 블록이 번호면 세부, 아니면 목록 (직전 목록에 이어 붙이거나 새 목록)
 */
export function appendContentLine(item: ClientItem, cursor: ContentCursor, line: ContentLine, indent: number): void {
  switch (line.kind) {
    case 'num': {
      const block = withIndent<ContentBlock>(
        { kind: 'numbered', index: line.index, title: line.title, details: [] },
        indent,
      );
      item.content.push(block);
      cursor.current = block;
      return;
    }
    case 'turn': {
      const cur = cursor.current;
      if (cur && cur.kind === 'dialog' && (cur.indent ?? 0) === indent) {
        cur.turns.push(line.turn);
        return;
      }
      const block = withIndent<DialogBlock>({ kind: 'dialog', turns: [line.turn] }, indent);
      item.content.push(block);
      cursor.current = block;
      return;
    }
    case 'note': {
      const last = item.content[item.content.length - 1];
      if (last && last.kind === 'numbered') {
        last.details.push(`${NOTE_PREFIX}${line.text}`);
      } else if (last && last.kind === 'dialog') {
        last.turns.push({ kind: 'note', text: line.text });
      } else if (last && last.kind === 'bullets') {
        last.items.push(`${NOTE_PREFIX}${line.text}`);
      } else {
        const block = withIndent<ContentBlock>({ kind: 'bullets', items: [`${NOTE_PREFIX}${line.text}`] }, indent);
        item.content.push(block);
        cursor.current = block;
      }
      return;
    }
    case 'dash': {
      const cur = cursor.current;
      if (cur && cur.kind === 'numbered') {
        cur.details.push(line.text);
        return;
      }
      if (cur && cur.kind === 'bullets') {
        cur.items.push(line.text);
        return;
      }
      const block = withIndent<ContentBlock>({ kind: 'bullets', items: [line.text] }, indent);
      item.content.push(block);
      cursor.current = block;
      return;
    }
  }
}

/**
 * 마커 없는 줄 — 마지막 블록에 흡수.
 * 대화 이력은 직전 턴의 이어지는 줄(여러 줄 턴), 번호·목록은 기존처럼 세부·항목으로 추가.
 */
export function appendPlainText(item: ClientItem, cursor: ContentCursor, raw: string, indent: number): void {
  const text = unescapeContinuation(raw);
  const last = item.content[item.content.length - 1];
  if (last && last.kind === 'numbered') {
    last.details.push(text);
    return;
  }
  if (last && last.kind === 'dialog' && last.turns.length > 0) {
    const turn = last.turns[last.turns.length - 1];
    turn.text = turn.text ? `${turn.text}\n${text}` : text;
    return;
  }
  if (last && last.kind === 'bullets') {
    last.items.push(text);
    return;
  }
  const block = withIndent<ContentBlock>({ kind: 'bullets', items: [text] }, indent);
  item.content.push(block);
  cursor.current = block;
}

// ── 이어지는 줄 이스케이프 ────────────────────────────────────────────────────
// 여러 줄 턴의 둘째 줄부터는 마커 없이 저장한다. 그 줄이 `- ` `1)` `->` `>` `@SUM` `#` 처럼
// 문법 줄로 시작하면 다시 읽을 때 목록·턴·디렉티브로 바뀌므로, 줄 머리에 `\`를 붙여 글자로 고정한다.
// 빈 줄은 `\` 한 글자로 남겨 문단 구분을 보존한다.

/** 이어지는 줄을 저장 형태로 — 문법으로 오인될 줄·빈 줄·`\`로 시작하는 줄에 `\` 접두 */
export function escapeContinuation(text: string): string {
  const t = text.trim();
  if (!t) return '\\';
  if (/^[\\@#]/.test(t) || matchContentLine(t)) return `\\${t}`;
  return t;
}

/** 저장 형태의 이어지는 줄을 원문으로 — escapeContinuation의 역 */
export function unescapeContinuation(text: string): string {
  if (text === '\\') return '';
  return text.startsWith('\\') ? text.slice(1) : text;
}

// ── 비주얼 입력칸의 마커 인식 ─────────────────────────────────────────────────

/** 턴 입력칸 줄 머리에서 인식하는 마커 — 마커 뒤 공백까지 쳐야 바뀐다 (타이핑 중 `-`·`<`만으로는 바뀌지 않게) */
const TYPED_MARKERS: ReadonlyArray<{ re: RegExp; turn: Pick<DialogTurn, 'kind' | 'pending'> }> = [
  { re: /^\*==>\s/, turn: { kind: 'conclusion' } },
  { re: /^\*<-\s/, turn: { kind: 'out', pending: true } },
  { re: /^\*->\s/, turn: { kind: 'in', pending: true } },
  { re: /^<-\s/, turn: { kind: 'out' } },
  { re: /^->\s/, turn: { kind: 'in' } },
  { re: /^>\s/, turn: { kind: 'note' } },
  // 메일에서 붙여넣은 화살표 문자 — 합자로 그려진 `->`를 보고 따라 친 경우
  { re: /^⇒\s/, turn: { kind: 'conclusion' } },
  { re: /^←\s/, turn: { kind: 'out' } },
  { re: /^→\s/, turn: { kind: 'in' } },
];

function typedMarker(line: string): { turn: Pick<DialogTurn, 'kind' | 'pending'>; rest: string } | null {
  const s = line.replace(/^[ \t　]+/, '');
  for (const m of TYPED_MARKERS) {
    const hit = m.re.exec(s);
    if (hit) return { turn: m.turn, rest: s.slice(hit[0].length) };
  }
  return null;
}

/**
 * 목록 줄 입력칸의 값이 대화 마커(`->`·`<-`·`*<-`·`*->`·`*==>`)로 시작하면 그 턴 종류와 나머지 글.
 * `> `는 목록 안에서도 노트라 여기서 고르지 않는다. 마커 뒤 공백까지 쳐야 한다.
 */
export function typedTurnStart(value: string): { turn: Pick<DialogTurn, 'kind' | 'pending'>; rest: string } | null {
  const [first, ...more] = value.split('\n');
  const hit = typedMarker(first);
  if (!hit || hit.turn.kind === 'note') return null;
  return { turn: hit.turn, rest: [hit.rest, ...more].join('\n') };
}

/** 턴 입력칸 줄 머리의 `- ` — 그 턴을 목록 줄로 바꾼다 (`->`는 대화 마커라 해당 없음). 나머지 글을 돌려준다 */
export function typedListStart(value: string): string | null {
  const m = /^[ \t　]*-[ \t]+/.exec(value);
  return m ? value.slice(m[0].length) : null;
}

/**
 * 턴 입력칸의 새 값 → 턴 목록.
 * - 첫 줄이 마커로 시작하면 그 턴의 종류를 바꾸고 마커를 뗀다 (`*<- 문의 예정` → 미결 대응)
 * - 둘째 줄부터 마커로 시작하는 줄은 새 턴으로 나눈다 (메일 스레드 붙여넣기, Shift+Enter 뒤 마커 입력)
 * - 마커 없는 줄은 직전 턴의 이어지는 줄
 * 바뀐 것이 없으면 null.
 */
export function splitTypedTurn(base: DialogTurn, value: string): DialogTurn[] | null {
  const lines = value.split('\n');
  const out: DialogTurn[] = [];
  let cur: DialogTurn = { kind: base.kind, text: '', ...(base.pending ? { pending: true } : {}) };
  let body: string[] = [];
  let changed = false;
  lines.forEach((line, idx) => {
    const hit = typedMarker(line);
    if (!hit) {
      body.push(line);
      return;
    }
    changed = true;
    if (idx > 0) {
      out.push({ ...cur, text: body.join('\n') });
      body = [];
    }
    cur = { kind: hit.turn.kind, text: '', ...(hit.turn.pending ? { pending: true } : {}) };
    body.push(hit.rest);
  });
  if (!changed) return null;
  out.push({ ...cur, text: body.join('\n') });
  return out;
}

/** 턴의 줄 머리 마커 (직렬화·렌더 공용) */
export function turnMarker(turn: DialogTurn): string {
  switch (turn.kind) {
    case 'conclusion':
      return '*==>';
    case 'note':
      return '>';
    case 'in':
      return turn.pending ? '*->' : '->';
    case 'out':
      return turn.pending ? '*<-' : '<-';
  }
}
