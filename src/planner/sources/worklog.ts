/**
 * 작업일지 → 후보 (설계 §5.2). 규칙만 쓴다 — AI를 부르지 않는다.
 *
 * - 읽는 줄: ■ 아래 ※, ▶, `-`, `>`, 원문 없는 ※ 메모. 제목 줄과 전달물 원문은 읽지 않는다.
 * - 사안의 상태 = 사안 안에서 마지막으로 나온 상태 줄(status.ts — 줄 끝의 낱말만).
 * - 같은 사안(폴더 + 사안 키)이 뒤 날짜에 닫혔으면 후보가 아니다.
 * - `(캘린더 일정)` 블록(지난 회의 기록)과 옛 번호식 블록은 뺀다.
 */
import type { WorklogFileText } from '../../../electron/worklog-types';
import { caseKey, parseWorklog, type WlBlock } from '../../worklog/format';
import { anchorOf, caseGroupKey } from '../anchor';
import { addDays, diffDays, resolveMonthDay } from '../dates';
import { lineStatus, waitingOnOf, type LineStatus } from '../status';
import type { WorklogAnchor } from '../types';

export interface Candidate {
  /** 무시·중복 판정용 키 */
  key: string;
  source: 'worklog';
  cls: 'todo' | 'wait';
  title: string;
  client: string;
  who: string;
  /** 걸린 줄 */
  phrase: string;
  waitingOn: string;
  /** 기록된 날 YYYY-MM-DD */
  date: string;
  /** 같은 줄에 `M/D … 예정`이 있으면 그 날짜 */
  due: string | null;
  anchor?: WorklogAnchor;
}

export interface WorklogScan {
  /** 기간 안의 열린 사안 — 최근 것부터 */
  candidates: Candidate[];
  /** 기간보다 오래된 열린 사안 수 */
  older: number;
  /** 사안 묶음 키 → 닫힌 날 (마지막 상태가 닫힘인 사안) */
  closed: Map<string, string>;
  /** 읽은 파일 수 (기간 안) */
  files: number;
}

export interface ScanOptions {
  today: string;
  lookbackDays: number;
  /** 폴더의 고객사·구분 */
  clientOf(folder: string): string;
}

interface StatusLine {
  text: string;
  line: number;
}

/** 상태를 볼 줄 — 줄 번호순 */
export function statusLines(b: WlBlock): StatusLine[] {
  const out: StatusLine[] = b.notes.map((n) => ({ text: n.text, line: n.line }));
  const facts = (list: WlBlock['looseFacts']) => {
    for (const f of list) {
      out.push({ text: f.text, line: f.line });
      for (const d of f.details) out.push({ text: d.text, line: d.line });
    }
  };
  facts(b.looseFacts);
  for (const a of b.acts) {
    out.push({ text: a.text, line: a.line });
    facts(a.facts);
  }
  for (const d of b.deliverables) if (!d.raw.length) out.push({ text: d.name, line: d.line });
  return out.sort((x, y) => x.line - y.line);
}

/** 사안의 마지막 상태 줄 */
export function blockStatus(b: WlBlock): { status: LineStatus; text: string } | null {
  let last: { status: LineStatus; text: string } | null = null;
  for (const l of statusLines(b)) {
    const s = lineStatus(l.text);
    if (s) last = { status: s, text: l.text };
  }
  return last;
}

const MD_RE = /(?<![\d./~-])(\d{1,2})\/(\d{1,2})(?![\d/~-])/;

/** 상태 줄의 `M/D … 예정` → 일지 날짜 이후의 날짜 */
function dueOf(text: string, fileDate: string): string | null {
  if (!/예정/.test(text)) return null;
  const m = MD_RE.exec(text);
  return m ? resolveMonthDay(Number(m[1]), Number(m[2]), fileDate) : null;
}

export function candidateKey(folder: string, key: string, date: string): string {
  return `${caseGroupKey(folder, key)}@${date}`;
}

export function scanWorklogs(files: readonly WorklogFileText[], opts: ScanOptions): WorklogScan {
  const from = addDays(opts.today, -opts.lookbackDays);
  interface Rec {
    date: string;
    cls: 'todo' | 'wait' | 'done';
    candidate: Candidate;
  }
  const groups = new Map<string, Rec[]>();
  const sorted = [...files].filter((f) => f.date <= opts.today).sort((a, b) => a.date.localeCompare(b.date));
  for (const f of sorted) {
    const doc = parseWorklog(f.text);
    for (const b of doc.blocks) {
      if (b.kind !== 'case' || b.calendar || !b.title.trim()) continue;
      const hit = blockStatus(b);
      if (!hit) continue;
      const key = caseKey(b);
      const group = caseGroupKey(f.folder, key);
      const cls = hit.status.cls;
      const who = b.source?.names.join(', ') ?? '';
      const rec: Rec = {
        date: f.date,
        cls,
        candidate: {
          key: candidateKey(f.folder, key, f.date),
          source: 'worklog',
          cls: cls === 'wait' ? 'wait' : 'todo',
          title: b.title.trim(),
          client: opts.clientOf(f.folder),
          who,
          phrase: hit.text.trim(),
          waitingOn: waitingOnOf(hit.text, hit.status),
          date: f.date,
          due: dueOf(hit.text, f.date),
          anchor: anchorOf(f, doc, b),
        },
      };
      groups.set(group, [...(groups.get(group) ?? []), rec]);
    }
  }
  const candidates: Candidate[] = [];
  const closed = new Map<string, string>();
  let older = 0;
  for (const [group, recs] of groups) {
    const last = recs[recs.length - 1];
    if (last.cls === 'done') {
      closed.set(group, last.date);
      continue;
    }
    if (last.date >= from) candidates.push(last.candidate);
    else older++;
  }
  candidates.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return { candidates, older, closed, files: sorted.filter((f) => f.date >= from).length };
}

/** 후보가 기록된 뒤 며칠 */
export function candidateAge(c: Pick<Candidate, 'date'>, today: string): number {
  return Math.max(0, diffDays(c.date, today));
}
