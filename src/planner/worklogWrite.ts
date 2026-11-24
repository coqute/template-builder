/**
 * 홈에서 작업일지에 덧붙이기 (설계 §6.7 ②·§12 3단계) — 사용자가 단추를 누를 때만 쓴다.
 * 기존 줄은 건드리지 않고 **파일 끝에만** 붙인다(일일 루틴과 같은 규칙). 저장은 작업일지 탭과 같은 통로라
 * "마지막으로 읽은 내용이 디스크와 같을 때만" 쓰이고, 그 사이 바뀌었으면 바뀐 내용 뒤에 다시 붙인다.
 */
import { toFileTitle } from '../worklog/format';
import { caseKey, parseWorklog } from '../worklog/format';
import { followupHead } from './anchor';
import type { PlannerApi } from './api';
import type { HomeEvent } from './classify';
import type { Task } from './types';

/** 끝낸 할 일 → 일지 블록. 일지 사안에서 온 것은 그 사안의 후속으로 적는다 (`(M/D 문의 후속)` — 루틴 형식) */
export function doneBlock(task: Pick<Task, 'title' | 'origin'>, today: string): string {
  if (task.origin.kind === 'worklog') {
    const a = task.origin.anchor;
    const same = caseKey({ title: task.title }) === a.caseKey;
    return `${followupHead(a, today)}\n▶ ${same ? '처리' : task.title} 완료`;
  }
  return `■ ${task.title}\n▶ 처리 완료`;
}

/** 지난 달력 일정 → 일지의 회의 블록 초안. 회의는 `■ 제목 회의 (캘린더 일정)`, 그 밖은 `■ 제목 (캘린더 일정)` */
export function eventBlock(e: Pick<HomeEvent, 'title' | 'kind'>, note?: { db: string; title: string }): string {
  const title = e.kind === 'meeting' && !/회의$/.test(e.title) ? `${e.title} 회의` : e.title;
  const head = `■ ${title} (캘린더 일정)`;
  // 이어진 Notion 회의록이 있으면 일지 루틴이 쓰는 줄과 같은 모양으로 한 줄 — 주소는 넣지 않는다
  return note ? `${head}\n※ 회의록: Notion ${note.db ? `${note.db} > ` : ''}${note.title}` : head;
}

/** 그 일지에 같은 회의 블록이 이미 있는가 — 루틴과 같은 판정(캘린더 표시 + 같은 사안 키) */
export function hasEventBlock(text: string, block: string): boolean {
  const want = parseWorklog(block).blocks[0];
  if (!want) return false;
  return parseWorklog(text).blocks.some((b) => b.calendar && caseKey(b) === caseKey(want));
}

export type AppendResult = { ok: true; name: string; created: boolean } | { ok: false; error: string; duplicate?: boolean };

export interface AppendRequest {
  folder: string;
  date: string;
  /** 그날 일지가 없을 때 새 파일의 제목 */
  title: string;
  block: string;
  /** 같은 회의 블록이 이미 있으면 쓰지 않는다 */
  skipIfEventExists?: boolean;
}

/** 그날 일지 끝에 블록을 붙인다 — 일지가 없으면 그 블록으로 새로 만든다 */
export async function appendToWorklog(api: PlannerApi, req: AppendRequest): Promise<AppendResult> {
  const list = await api.worklogList();
  if (!list.ok) return { ok: false, error: list.error };
  const hit = list.files.find((f) => f.folder === req.folder && f.date === req.date);
  const block = req.block.replace(/\s+$/, '');
  if (!hit) {
    const title = toFileTitle(req.title).slice(0, 80) || '작업';
    const made = await api.worklogCreate({ folder: req.folder, date: req.date, title, text: `[${req.date}] ${title}\n\n${block}\n` });
    if (made.ok) return { ok: true, name: made.name, created: true };
    return { ok: false, error: made.code === 'exists' ? '그날 일지가 방금 생겼습니다 — 다시 눌러 주세요.' : made.error };
  }
  const read = await api.worklogRead(hit);
  if (!read.ok) return { ok: false, error: read.error };
  let base = read.text;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (req.skipIfEventExists && hasEventBlock(base, block)) return { ok: false, error: '그 일지에 같은 회의 블록이 이미 있습니다.', duplicate: true };
    const head = base.replace(/\s+$/, '');
    const text = head ? `${head}\n\n${block}\n` : `${block}\n`;
    const saved = await api.worklogSave({ folder: hit.folder, name: hit.name, text, base, bom: read.bom, crlf: read.crlf });
    if (saved.ok) return { ok: true, name: hit.name, created: false };
    if (saved.code !== 'changed') return { ok: false, error: saved.error };
    // 읽은 뒤 바뀌었다(루틴이 덧붙였거나 메모장에서 고침) — 바뀐 내용 뒤에 다시 붙인다
    base = saved.disk;
  }
  return { ok: false, error: '일지가 계속 바뀌고 있어 쓰지 못했습니다 — 잠시 뒤 다시 눌러 주세요.' };
}
