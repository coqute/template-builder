/**
 * 작업일지 사안을 가리키는 닻 (설계 §4.5) — 일지에는 줄마다 번호표가 없어 `사안 키 + 몇 번째`로 가리킨다.
 * 루틴은 파일 끝에만 덧붙이므로 앞 줄은 밀리지 않는다. 줄이 밀리는 것은 사용자가 고칠 때뿐이라, 읽을 때마다 다시 찾는다.
 */
import { caseKey, type WlBlock, type WlDoc } from '../worklog/format';
import type { WorklogAnchor } from './types';

export interface AnchorFile {
  folder: string;
  name: string;
  date: string;
}

function cases(doc: WlDoc): WlBlock[] {
  return doc.blocks.filter((b) => b.kind === 'case');
}

export function anchorOf(file: AnchorFile, doc: WlDoc, block: WlBlock): WorklogAnchor {
  const key = caseKey(block);
  const same = cases(doc).filter((b) => caseKey(b) === key);
  return {
    folder: file.folder,
    name: file.name,
    date: file.date,
    caseKey: key,
    nth: Math.max(0, same.indexOf(block)),
    line: block.startLine,
    title: block.title,
    source: block.source?.raw ?? '',
  };
}

/** 닻이 가리키는 사안 — 키와 순번으로, 순번이 어긋나면 같은 키의 첫 사안, 키가 없어졌으면 줄 번호로 */
export function findAnchor(doc: WlDoc, a: Pick<WorklogAnchor, 'caseKey' | 'nth' | 'line'>): WlBlock | null {
  const all = cases(doc);
  const same = all.filter((b) => caseKey(b) === a.caseKey);
  return same[a.nth] ?? same[0] ?? all.find((b) => b.startLine === a.line) ?? null;
}

/** 그 줄이 속한 사안 — ■ 줄부터 다음 ■ 줄 앞까지(사이의 빈 줄 포함) */
export function caseAtLine(doc: WlDoc, line: number): WlBlock | null {
  let hit: WlBlock | null = null;
  for (const b of cases(doc)) {
    if (b.startLine <= line) hit = b;
    else break;
  }
  return hit;
}

/** 같은 사안 판정 — 폴더 + 사안 키 */
export function caseGroupKey(folder: string, key: string): string {
  return `${folder}\u0000${key}`;
}

export function anchorGroupKey(a: Pick<WorklogAnchor, 'folder' | 'caseKey'>): string {
  return caseGroupKey(a.folder, a.caseKey);
}

const FOLLOWUP_TAIL_RE = /\s*\((\d{1,2})\/(\d{1,2})\s*[^)]*후속\)\s*$/;

/**
 * 그 사안의 후속 블록 머리 — 루틴 형식 `■ (요청자/채널) 사안 (M/D 문의 후속)`, 같은 날이면 `(후속)`.
 * 가리킨 사안이 이미 후속 블록이면 처음 문의한 날짜를 그대로 쓴다(`(M/D 문의 후속)`이 두 번 붙지 않게).
 */
export function followupHead(a: Pick<WorklogAnchor, 'title' | 'source' | 'date'>, today: string): string {
  const m = FOLLOWUP_TAIL_RE.exec(a.title);
  const title = (m ? a.title.slice(0, m.index) : a.title).trim();
  const [, month, day] = a.date.split('-').map(Number);
  const mark = m ? ` (${Number(m[1])}/${Number(m[2])} 문의 후속)` : a.date === today ? ' (후속)' : ` (${month}/${day} 문의 후속)`;
  return `■ ${a.source ? `(${a.source}) ` : ''}${title}${mark}`;
}

/**
 * 사안 안에 일정 줄을 넣는다 — 마지막 ▶ 묶음의 끝(다음 ▶·※ 전달물 앞)에 `- 12/2 … 예정`, ▶가 없으면 ■ 아래 `※ …`.
 * 루틴이 쓰는 날짜 표기(`- M/D … 예정`)와 같아서 주간보고 가져오기에 그대로 실린다.
 */
export function insertScheduleLine(text: string, block: WlBlock, phrase: string): string {
  const lines = text.split('\n');
  const lastAct = block.acts[block.acts.length - 1];
  if (!lastAct) {
    const at = block.notes.length ? block.notes[block.notes.length - 1].line : block.startLine;
    lines.splice(at, 0, `※ ${phrase}`);
    return lines.join('\n');
  }
  let at = lastAct.line;
  for (const f of lastAct.facts) at = Math.max(at, f.line, ...f.details.map((d) => d.line));
  lines.splice(at, 0, `- ${phrase}`);
  return lines.join('\n');
}
