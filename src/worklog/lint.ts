/**
 * 작업일지 형식 제안 — 고치라고 강요하지 않는다(사용자 수기 파일은 그대로 존중). 편집기 밑줄과 상태바 목록에 쓴다.
 * 고칠 수 있는 것은 fix로 한 번에 고치게 한다: 파일명↔1행 제목 맞추기, 같은 사안 ■ 합치기.
 */
import { caseKey, parseWorklog, sameTitle, toFileTitle, type WlBlock, type WlDoc } from './format';

export type WlFix =
  | { kind: 'rename-file'; title: string }
  | { kind: 'set-title-line'; line: string }
  | { kind: 'merge-case'; keep: number; drop: number };

export interface WlIssue {
  line: number;
  severity: 'info' | 'warning';
  code: string;
  message: string;
  fixes?: Array<{ label: string; fix: WlFix }>;
}

export interface WlFileContext {
  date: string;
  /** 파일명 제목 */
  title: string;
}

const HONORIFIC = /(님|책임|부장|차장|과장|대리|선임|수석|사원|주임|전임|매니저|팀장|이사|대표|프로)$/;
/** 옛 루틴이 한 일을 알 수 없는 사안에 붙이던 자리 글 — 2026-11-24부터 루틴은 붙이지 않는다(■ 한 줄만 세운다) */
const NEEDS_ACT = /(확인 필요|대응 예정|보강)/;

export function lintWorklog(text: string, file: WlFileContext | null, doc: WlDoc = parseWorklog(text)): WlIssue[] {
  const out: WlIssue[] = [];
  if (!text.trim()) return out;

  if (file) {
    const t = doc.titleLine;
    if (!t) {
      out.push({
        line: 1,
        severity: 'info',
        code: 'title-missing',
        message: `1행에 [${file.date}] 제목을 쓰면 파일명과 함께 관리할 수 있습니다.`,
        fixes: [{ label: '1행에 파일명 제목 넣기', fix: { kind: 'set-title-line', line: `[${file.date}] ${file.title}` } }],
      });
    } else if (t.date !== file.date) {
      out.push({ line: 1, severity: 'warning', code: 'title-date', message: `1행 날짜(${t.date})가 파일명 날짜(${file.date})와 다릅니다.` });
    } else if (t.title && !sameTitle(toFileTitle(t.title), file.title)) {
      out.push({
        line: 1,
        severity: 'info',
        code: 'title-name',
        message: '1행 제목과 파일명이 다릅니다.',
        fixes: [
          { label: '파일명을 1행에 맞추기', fix: { kind: 'rename-file', title: toFileTitle(t.title) } },
          { label: '1행을 파일명에 맞추기', fix: { kind: 'set-title-line', line: `[${file.date}] ${file.title}` } },
        ],
      });
    }
  }

  const cases = doc.blocks.filter((b) => b.kind === 'case');
  for (const b of cases) {
    const names = b.source?.names.filter((n) => HONORIFIC.test(n.replace(/\s+/g, ''))) ?? [];
    if (names.length) {
      out.push({
        line: b.startLine,
        severity: 'info',
        code: 'source-honorific',
        message: `출처 괄호는 이름만 씁니다(${names.join(', ')}) — 호칭은 ▶·- 문장 안에서만 씁니다.`,
      });
    }
    // 한 일이 적히지 않은 사안 — ■ 한 줄뿐이거나(루틴이 메일로 사안만 세운 것), 옛 자리 글만 있는 것
    const bare = b.notes.length === 0 && b.looseFacts.length === 0 && b.deliverables.length === 0 && b.extra.length === 0;
    if (!b.calendar && b.acts.length === 0 && b.title.trim() && (bare || b.notes.some((n) => NEEDS_ACT.test(n.text)))) {
      out.push({ line: b.startLine, severity: 'info', code: 'needs-act', message: '▶로 실제 수행한 내용을 보강하세요.' });
    }
  }

  // 같은 사안이 ■ 두 개로 갈림 (원 블록 + '(후속)' 블록 등)
  const seen = new Map<string, WlBlock>();
  for (const b of cases) {
    const key = caseKey(b);
    if (!key || b.calendar) continue;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, b);
      continue;
    }
    const sameSource = !b.source || !first.source || b.source.raw.replace(/\s+/g, '') === first.source.raw.replace(/\s+/g, '');
    out.push({
      line: b.startLine,
      severity: 'info',
      code: 'dup-case',
      message: `같은 사안이 ${first.startLine}행에도 있습니다.`,
      fixes: sameSource ? [{ label: `${first.startLine}행 ■에 합치기`, fix: { kind: 'merge-case', keep: first.index, drop: b.index } }] : undefined,
    });
  }

  if (cases.length > 0) {
    const orphan = doc.lines.find((l) => l.block === -1 && (l.kind === 'act' || l.kind === 'fact' || l.kind === 'detail'));
    if (orphan) {
      out.push({ line: orphan.no, severity: 'info', code: 'orphan', message: '■ 사안 위에 쓴 줄입니다 — 해당 ■ 아래로 옮기면 주간보고·KB로 함께 넘어갑니다.' });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 1행 바꾸기 — 제목 줄이 없으면 맨 위에 넣고 빈 줄 하나를 둔다 */
export function setTitleLine(text: string, line: string, doc: WlDoc = parseWorklog(text)): string {
  const lines = text.split('\n');
  if (doc.titleLine) {
    lines[0] = line;
    return lines.join('\n');
  }
  return `${line}\n\n${text.replace(/^\n+/, '')}`;
}

/** 같은 사안 두 블록을 하나로 — 뒤 블록의 머리는 빼고 본문을 앞 블록 끝에 옮긴다 */
export function mergeCaseBlocks(text: string, keepIndex: number, dropIndex: number, doc: WlDoc = parseWorklog(text)): string {
  const keep = doc.blocks[keepIndex];
  const drop = doc.blocks[dropIndex];
  if (!keep || !drop || keep === drop) return text;
  const lines = text.split('\n');
  const body = lines.slice(drop.startLine, drop.endLine); // 머리 다음 줄 ~ 끝 (0-based slice = 1-based startLine+1..endLine)
  while (body.length && !body[0].trim()) body.shift();
  // 뒤 블록과 그 앞 빈 줄을 걷어낸다
  let from = drop.startLine - 1;
  while (from > 0 && !lines[from - 1].trim()) from--;
  const removed = [...lines.slice(0, from), ...lines.slice(drop.endLine)];
  if (drop.index < keep.index) return text; // 앞으로 합치는 경우만 (앞 블록이 원본)
  const insertAt = keep.endLine; // keep 끝 줄 다음 (0-based)
  // 앞 블록 끝 줄 → 빈 줄 → 옮긴 본문 → (원래 있던 빈 줄) → 다음 블록. 원문 블록 안의 빈 줄은 건드리지 않는다
  return [...removed.slice(0, insertAt), '', ...body, ...removed.slice(insertAt)].join('\n');
}
