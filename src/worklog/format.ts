/**
 * 작업일지 형식 — 수기와 작업일지 루틴이 함께 쓰는 순수 텍스트.
 *
 *   [YYYY-MM-DD] 제목                       ← 1행
 *   ■ (요청자/채널) 사안                     ← 사안(무엇을 해야 했는가). 회의는 `■ {회의} 회의 (캘린더 일정)`
 *   ※ 배경·참고·상태                         ← ■ 바로 아래 한 줄(ⓐ)
 *   ▶ 내가 한 일                            ← 시간순
 *   - 확정된 사실
 *     > 부연
 *   ※ 전달물 이름                            ← ▶ 뒤(ⓑ) — 다음 줄부터 원문 그대로(쿼리·스크립트)
 *
 * 4~6월의 옛 번호식(`1. 작업` / `- 세부`)도 읽는다. 원문 블록 안의 `- `·빈 줄은 원문으로 둔다.
 */

import { dowOf, isoOf } from '../lib/dates';

export type WlLineKind =
  | 'title'
  | 'case'
  | 'note'
  | 'act'
  | 'fact'
  | 'detail'
  | 'deliverable'
  | 'raw'
  | 'numbered'
  | 'blank'
  | 'text';

export interface WlLine {
  /** 1-based */
  no: number;
  kind: WlLineKind;
  text: string;
  /** 속한 블록 번호 (없으면 -1) */
  block: number;
}

export interface WlSource {
  names: string[];
  channel?: string;
  /** 괄호 안 원문 */
  raw: string;
}

export interface WlFact {
  text: string;
  line: number;
  details: Array<{ text: string; line: number }>;
}

export interface WlAct {
  text: string;
  line: number;
  facts: WlFact[];
}

export interface WlDeliverable {
  name: string;
  line: number;
  /** 원문 줄 (앞뒤 빈 줄 제외) */
  raw: string[];
}

export interface WlBlock {
  index: number;
  kind: 'case' | 'numbered';
  /** 1-based, 끝의 빈 줄 제외 */
  startLine: number;
  endLine: number;
  /** 마커 뒤 머리 원문 */
  header: string;
  source?: WlSource;
  /** 출처 괄호·끝 표시((캘린더 일정)·(후속)·(회의록 보강))를 뗀 사안 */
  title: string;
  calendar: boolean;
  followup: boolean;
  notes: Array<{ text: string; line: number }>;
  acts: WlAct[];
  /** 번호식·▶ 없이 쓴 `- ` 사실 */
  looseFacts: WlFact[];
  deliverables: WlDeliverable[];
  /** 알아보지 못한 줄 */
  extra: Array<{ text: string; line: number }>;
}

export interface WlTitleLine {
  date: string;
  title: string;
}

export interface WlDoc {
  titleLine: WlTitleLine | null;
  lines: WlLine[];
  blocks: WlBlock[];
}

export const TITLE_LINE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;
const CASE_RE = /^■(?!■)\s*/;
const ACT_RE = /^▶\s*/;
const FACT_RE = /^-(?:\s+|$)/;
const DETAIL_RE = /^\s*>\s?/;
const NOTE_RE = /^※\s*/;
const NUMBERED_RE = /^(\d{1,2})[.)]\s+/;
const FLAG_RE = /\s*\((캘린더 일정|후속|회의록 보강)\)\s*$/;

/** `■` 머리 → 출처·사안·표시 */
export function parseCaseHeader(header: string): Pick<WlBlock, 'source' | 'title' | 'calendar' | 'followup'> {
  let rest = header.trim();
  let source: WlSource | undefined;
  const m = /^\(([^()]*)\)\s*/.exec(rest);
  if (m && m[1].trim() && m[1].trim() !== '캘린더 일정') {
    const inner = m[1].trim();
    const parts = inner.split('/').map((s) => s.trim());
    const channel = parts.length > 1 ? parts[parts.length - 1] : undefined;
    const who = parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0];
    source = {
      raw: inner,
      names: who.split(/\s*[,·]\s*/).map((s) => s.trim()).filter(Boolean),
      channel: channel || undefined,
    };
    rest = rest.slice(m[0].length);
  }
  let calendar = false;
  let followup = false;
  for (let f = FLAG_RE.exec(rest); f; f = FLAG_RE.exec(rest)) {
    if (f[1] === '캘린더 일정') calendar = true;
    else followup = true;
    rest = rest.slice(0, f.index);
  }
  return { source, title: rest.trim(), calendar, followup };
}

function newBlock(index: number, kind: WlBlock['kind'], line: number, header: string): WlBlock {
  const parsed = kind === 'case' ? parseCaseHeader(header) : { title: header.trim(), calendar: false, followup: false };
  return {
    index,
    kind,
    startLine: line,
    endLine: line,
    header,
    ...parsed,
    notes: [],
    acts: [],
    looseFacts: [],
    deliverables: [],
    extra: [],
  };
}

/** 본문 → 줄 종류 + 블록 */
export function parseWorklog(text: string): WlDoc {
  const src = text.replace(/\r\n/g, '\n').split('\n');
  const lines: WlLine[] = [];
  const blocks: WlBlock[] = [];
  let titleLine: WlTitleLine | null = null;
  let cur: WlBlock | null = null;
  let inRaw = false;
  let prevBlank = false;
  let lastFact: WlFact | null = null;

  const push = (no: number, kind: WlLineKind, t: string) => {
    lines.push({ no, kind, text: t, block: cur ? cur.index : -1 });
    if (cur && kind !== 'blank') cur.endLine = no;
  };

  src.forEach((raw, i) => {
    const no = i + 1;
    const t = raw.replace(/\s+$/, '');
    if (i === 0) {
      const m = TITLE_LINE_RE.exec(t.trim());
      if (m) {
        titleLine = { date: m[1], title: m[2].trim() };
        push(no, 'title', raw);
        prevBlank = false;
        return;
      }
    }
    if (CASE_RE.test(t)) {
      cur = newBlock(blocks.length, 'case', no, t.replace(CASE_RE, ''));
      blocks.push(cur);
      inRaw = false;
      lastFact = null;
      push(no, 'case', raw);
      prevBlank = false;
      return;
    }
    if (inRaw && cur) {
      const d = cur.deliverables[cur.deliverables.length - 1];
      if (ACT_RE.test(t) || NOTE_RE.test(t) || (prevBlank && FACT_RE.test(t))) {
        inRaw = false; // 아래에서 다시 판정
      } else {
        if (t) d.raw.push(raw);
        else if (d.raw.length) d.raw.push('');
        push(no, t ? 'raw' : 'blank', raw);
        prevBlank = !t;
        return;
      }
    }
    if (!t) {
      push(no, 'blank', raw);
      prevBlank = true;
      return;
    }
    prevBlank = false;
    if (ACT_RE.test(t)) {
      if (cur) cur.acts.push({ text: t.replace(ACT_RE, '').trim(), line: no, facts: [] });
      lastFact = null;
      push(no, 'act', raw);
      return;
    }
    if (DETAIL_RE.test(raw)) {
      const detail = { text: raw.replace(DETAIL_RE, '').trim(), line: no };
      if (lastFact) lastFact.details.push(detail);
      else cur?.extra.push(detail);
      push(no, 'detail', raw);
      return;
    }
    if (FACT_RE.test(t)) {
      const fact: WlFact = { text: t.replace(FACT_RE, '').trim(), line: no, details: [] };
      if (cur) {
        const act = cur.acts[cur.acts.length - 1];
        if (act) act.facts.push(fact);
        else cur.looseFacts.push(fact);
      }
      lastFact = fact;
      push(no, 'fact', raw);
      return;
    }
    if (NOTE_RE.test(t)) {
      const body = t.replace(NOTE_RE, '').trim();
      if (cur && cur.acts.length > 0) {
        cur.deliverables.push({ name: body, line: no, raw: [] });
        inRaw = true;
        lastFact = null;
        push(no, 'deliverable', raw);
      } else {
        cur?.notes.push({ text: body, line: no });
        push(no, 'note', raw);
      }
      return;
    }
    const num = NUMBERED_RE.exec(t);
    if (num && (!cur || cur.kind === 'numbered')) {
      cur = newBlock(blocks.length, 'numbered', no, t.replace(NUMBERED_RE, ''));
      blocks.push(cur);
      lastFact = null;
      push(no, 'numbered', raw);
      return;
    }
    cur?.extra.push({ text: t.trim(), line: no });
    push(no, 'text', raw);
  });

  // 전달물 원문 끝의 빈 줄은 원문이 아니다
  for (const b of blocks) for (const d of b.deliverables) while (d.raw.length && !d.raw[d.raw.length - 1].trim()) d.raw.pop();
  return { titleLine, lines, blocks };
}

/** 같은 사안 판정용 — 공백·끝 표시·`(M/D 문의 후속)`을 뺀 사안 */
export function caseKey(b: Pick<WlBlock, 'title'>): string {
  return b.title
    .replace(/\(\d{1,2}\/\d{1,2}\s*[^)]*후속\)/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 파일명 제목에 쓸 수 있게 — 금지 문자는 가운뎃점, 공백 정리 */
export function toFileTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameTitle(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

/** 로컬 날짜 YYYY-MM-DD */
export function isoToday(d = new Date()): string {
  return isoOf(d);
}

export function weekdayOf(iso: string): string {
  return dowOf(iso);
}

/** 일지 끝에 블록을 덧붙인 본문 — 끝의 빈 줄을 정리하고 블록 앞에 빈 줄 하나를 둔다 (앱과 플래너 도구가 같은 모양으로 쓴다) */
export function appendBlockText(text: string, block: string): string {
  const head = text.replace(/\s+$/, '');
  return head ? `${head}\n\n${block}\n` : `${block}\n`;
}

/** 새 일지의 본문 — 1행 `[YYYY-MM-DD] 제목`, 빈 줄, 블록 */
export function newWorklogText(date: string, title: string, block: string): string {
  return `[${date}] ${title}\n\n${block}\n`;
}
