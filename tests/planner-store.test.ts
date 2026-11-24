// @vitest-environment node
/**
 * 플래너 저장소(electron/planner-store.ts) — 읽기·동작 적용·백업·기록·잠금·깨진 파일 되살리기.
 * 실제 임시 폴더에 쓰고 읽는다. 값은 모두 합성 값이다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyToStore,
  BACKUP_DIR_NAME,
  BACKUP_KEEP,
  LOCK_NAME,
  LOG_KEEP,
  LOG_NAME,
  plannerDir,
  readStore,
  statStore,
  STATE_NAME,
} from '../electron/planner-store';
import { emptyState } from '../src/planner/ops';
import type { PlannerLogEntry, PlannerOp, PlannerState } from '../src/planner/types';

let tmp = '';
let dir = '';
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'tb-planner-'));
  dir = path.join(tmp, 'store'); // 아직 없는 폴더 — 첫 저장 때 만들어진다
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const add = (title: string, id?: string): PlannerOp => ({ type: 'task.add', draft: { title }, ...(id ? { id } : {}) });

async function apply(op: PlannerOp, by: 'app' | 'claude' = 'app'): Promise<PlannerState> {
  const r = await applyToStore(dir, op, by);
  if (!r.ok) throw new Error(`적용 실패: ${r.error}`);
  return r.state;
}

async function read(): Promise<{ state: PlannerState; warning?: string }> {
  const r = await readStore(dir);
  if (!r.ok) throw new Error(`읽기 실패: ${r.error}`);
  return { state: r.state, warning: r.warning };
}

const stateText = () => readFile(path.join(dir, STATE_NAME), 'utf8');
const backups = async () => (await readdir(path.join(dir, BACKUP_DIR_NAME))).sort();
async function logLines(): Promise<PlannerLogEntry[]> {
  const text = await readFile(path.join(dir, LOG_NAME), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PlannerLogEntry);
}
/** 잠금·임시 파일이 남지 않았는가 — 폴더에 있어도 되는 것만 있는지 본다 */
async function strays(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n !== STATE_NAME && n !== LOG_NAME && n !== BACKUP_DIR_NAME && !n.startsWith(`${STATE_NAME}.bad-`));
}
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe('plannerDir — 저장 폴더', () => {
  it('TB_PLANNER_DIR이 있으면 그것, 없으면 사용자 폴더 아래 점 폴더 — 부를 때마다 읽는다', () => {
    const before = process.env.TB_PLANNER_DIR;
    try {
      process.env.TB_PLANNER_DIR = dir;
      expect(plannerDir()).toBe(dir);
      delete process.env.TB_PLANNER_DIR;
      expect(plannerDir()).toBe(path.join(os.homedir(), '.template-builder'));
    } finally {
      if (before === undefined) delete process.env.TB_PLANNER_DIR;
      else process.env.TB_PLANNER_DIR = before;
    }
  });
});

describe('readStore · statStore — 읽기', () => {
  it('파일이 없으면 빈 상태를 돌려주고 파일도 폴더도 만들지 않는다', async () => {
    const r = await readStore(dir);
    expect(r).toEqual({ ok: true, state: emptyState(), path: path.join(dir, STATE_NAME) });
    expect(await statStore(dir)).toEqual({ ok: true, mtimeMs: 0, size: 0 });
    expect(await readdir(tmp)).toEqual([]);
  });

  it('적용한 뒤 다시 읽으면 같은 상태다', async () => {
    const s1 = await apply(add('패치 적용 전 백업 절차 확인', 't_a'));
    const s2 = await apply({ type: 'task.update', id: 't_a', patch: { client: 'AB Z+', who: '홍길동', due: '2026-11-25' } });
    expect(s1.rev).toBe(1);
    expect(s2.rev).toBe(2);
    expect((await read()).state).toEqual(s2);
    expect(s2.tasks[0]).toMatchObject({ id: 't_a', client: 'AB Z+', who: '홍길동', due: '2026-11-25', by: 'app' });
    expect(Number.isNaN(Date.parse(s2.tasks[0].createdAt))).toBe(false);

    const st = await statStore(dir);
    const disk = await stat(path.join(dir, STATE_NAME));
    expect(st).toEqual({ ok: true, mtimeMs: disk.mtimeMs, size: disk.size });
    expect(disk.size).toBeGreaterThan(0);
  });

  it('사람이 읽을 수 있게 들여쓰기 1칸으로 쓴다', async () => {
    const s = await apply(add('MX 주간 미팅 준비', 't_a'));
    const text = await stateText();
    expect(text).toBe(JSON.stringify(s, null, 1));
    expect(text.startsWith('{\n "version": 1,\n "rev": 1,')).toBe(true);
  });

  it('오늘은 이 컴퓨터의 날짜다 — 기다리기 시작한 날로 확인', async () => {
    const s = await apply({ type: 'task.add', id: 't_w', draft: { title: '로그 회수 요청', state: 'waiting', waitingOn: '담당A' } });
    expect(s.tasks[0].waitingSince).toBe(localToday());
  });

  it('고친 쪽(by)이 할 일과 기록에 남는다', async () => {
    await apply(add('용량 산정', 't_a'));
    const s = await apply({ type: 'task.update', id: 't_a', patch: { due: '2026-12-04' } }, 'claude');
    expect(s.tasks[0].by).toBe('claude');
    expect((await logLines()).map((l) => l.by)).toEqual(['app', 'claude']);
  });

  it('BOM이 붙은 파일도 그대로 읽는다(메모장으로 고친 파일)', async () => {
    const s = await apply(add('백업 절차 확인', 't_a'));
    await writeFile(path.join(dir, STATE_NAME), `﻿${JSON.stringify(s, null, 1)}`, 'utf8');
    expect(await read()).toEqual({ state: s, warning: undefined });
  });
});

describe('applyToStore — 백업과 기록', () => {
  it('첫 저장에는 백업이 없고, 그 뒤로는 바꾸기 전 내용을 백업한다', async () => {
    await apply(add('하나', 't_a'));
    await expect(backups()).rejects.toThrow(); // 백업 폴더가 아직 없다
    const before = await stateText();
    await apply(add('둘', 't_b'));
    const names = await backups();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^planner-\d{8}-\d{9}-r000001\.json$/); // 이름에 시각과 그때의 rev
    expect(await readFile(path.join(dir, BACKUP_DIR_NAME, names[0]), 'utf8')).toBe(before);
  });

  it('기록은 한 줄에 한 건 — 언제·누가·무엇을·전·후', async () => {
    await apply(add('하나', 't_a'));
    await apply({ type: 'task.done', id: 't_a', done: true });
    await apply({ type: 'task.remove', id: 't_a' });
    const lines = await logLines();
    expect(lines.map((l) => [l.rev, l.op, l.id, l.by])).toEqual([
      [1, 'task.add', 't_a', 'app'],
      [2, 'task.done', 't_a', 'app'],
      [3, 'task.remove', 't_a', 'app'],
    ]);
    expect(lines[0].after).toMatchObject({ title: '하나' });
    expect(lines[2].before).toMatchObject({ title: '하나' });
    expect(lines.every((l) => !Number.isNaN(Date.parse(l.at)))).toBe(true);
    expect((await readFile(path.join(dir, LOG_NAME), 'utf8')).endsWith('\n')).toBe(true);
  });

  it(`백업은 최근 ${BACKUP_KEEP}개만 남긴다`, async () => {
    const total = BACKUP_KEEP + 5;
    for (let i = 1; i <= total; i++) await apply(add(`할 일 ${i}`));
    const names = await backups();
    expect(names).toHaveLength(BACKUP_KEEP);
    // 남은 것은 가장 최근 것들이다 — 마지막 백업은 마지막 저장 직전(rev total-1)의 내용
    const revs = await Promise.all(
      names.map(async (n) => (JSON.parse(await readFile(path.join(dir, BACKUP_DIR_NAME, n), 'utf8')) as PlannerState).rev),
    );
    expect(revs).toEqual(Array.from({ length: BACKUP_KEEP }, (_, i) => total - BACKUP_KEEP + i));
  });

  it(`기록이 ${LOG_KEEP}줄을 넘으면 최근 ${LOG_KEEP}줄만 남긴다`, async () => {
    await mkdir(dir, { recursive: true });
    const old = Array.from({ length: LOG_KEEP }, (_, i) => JSON.stringify({ at: '2026-11-01T00:00:00.000Z', by: 'app', rev: i + 1, op: 'title.hide' }));
    await writeFile(path.join(dir, LOG_NAME), `${old.join('\n')}\n`, 'utf8');
    await apply(add('새 할 일', 't_new'));
    await apply(add('또 새 할 일', 't_new2'));
    const lines = await logLines();
    expect(lines).toHaveLength(LOG_KEEP);
    expect(lines[0].rev).toBe(3); // 옛 기록 앞의 두 줄이 밀려났다
    expect(lines.slice(-2).map((l) => l.id)).toEqual(['t_new', 't_new2']);
    expect(await strays()).toEqual([]);
  });
});

describe('깨진 파일', () => {
  it('옆으로 옮기고 가장 최근 백업으로 연다 — 알림을 돌려주고, 다음에는 조용히 읽힌다', async () => {
    const s1 = await apply(add('하나', 't_a'));
    await apply(add('둘', 't_b')); // 백업 = s1
    const broken = '{ "version": 1, "tasks": [';
    await writeFile(path.join(dir, STATE_NAME), broken, 'utf8');

    const first = await read();
    expect(first.state).toEqual(s1);
    const bad = (await readdir(dir)).filter((n) => n.startsWith(`${STATE_NAME}.bad-`));
    expect(bad).toHaveLength(1);
    expect(await readFile(path.join(dir, bad[0]), 'utf8')).toBe(broken); // 깨진 파일은 지우지 않는다
    expect(first.warning).toContain(bad[0]);
    expect(first.warning).toContain((await backups())[0]);

    expect(JSON.parse(await stateText())).toEqual(s1); // 되살린 내용을 다시 써 둔다
    expect(await read()).toEqual({ state: s1, warning: undefined });
    expect(await strays()).toEqual([]);
  });

  it('맨 뒤 백업도 깨졌으면 그 앞 백업으로 연다', async () => {
    const s1 = await apply(add('하나', 't_a'));
    await apply(add('둘', 't_b'));
    await apply(add('셋', 't_c')); // 백업 = [s1, s2]
    const names = await backups();
    expect(names).toHaveLength(2);
    await writeFile(path.join(dir, BACKUP_DIR_NAME, names[1]), '반쪽', 'utf8');
    await writeFile(path.join(dir, STATE_NAME), '', 'utf8'); // 0바이트 — 쓰다 끊긴 파일
    const r = await read();
    expect(r.state).toEqual(s1);
    expect(r.warning).toContain(names[0]);
  });

  it('백업이 없으면 빈 상태로 열고 알린다. 깨진 파일은 옆에 남는다', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, STATE_NAME), '[]', 'utf8'); // JSON이지만 모양이 다르다
    const r = await read();
    expect(r.state).toEqual(emptyState());
    expect(r.warning).toContain('빈 상태');
    expect((await readdir(dir)).map((n) => n.replace(/bad-.*$/, 'bad-'))).toEqual([`${STATE_NAME}.bad-`]);
  });

  it('깨진 파일 위에 적용하면 백업에서 되살린 상태에 동작을 얹고 알림을 함께 돌려준다', async () => {
    await apply(add('하나', 't_a'));
    await apply(add('둘', 't_b')); // 백업 = '하나'만 있던 때
    await writeFile(path.join(dir, STATE_NAME), '깨짐', 'utf8');
    const r = await applyToStore(dir, add('셋', 't_c'), 'app');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.tasks.map((t) => t.id)).toEqual(['t_a', 't_c']);
    expect(r.warning).toContain('백업');
    expect((await read()).state).toEqual(r.state);
    expect(await strays()).toEqual([]);
  });
});

describe('동시에 고치기 · 잠금', () => {
  it('여러 동작을 한꺼번에 걸어도 모두 반영된다 — 잃는 것이 없고 임시·잠금 파일이 남지 않는다', async () => {
    const n = 30;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => applyToStore(dir, add(`할 일 ${i + 1}`), 'app')));
    expect(results.every((r) => r.ok)).toBe(true);

    const { state } = await read();
    expect(state.rev).toBe(n);
    expect(state.tasks.map((t) => t.title).sort()).toEqual(Array.from({ length: n }, (_, i) => `할 일 ${i + 1}`).sort());
    expect(new Set(state.tasks.map((t) => t.id)).size).toBe(n);
    expect((await logLines()).map((l) => l.rev)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(await backups()).toHaveLength(Math.min(BACKUP_KEEP, n - 1));
    expect(await strays()).toEqual([]);
  });

  it('읽기와 쓰기가 섞여도 읽은 값은 늘 온전한 상태다', async () => {
    await apply(add('처음', 't_0'));
    const jobs = Array.from({ length: 20 }, (_, i) => (i % 2 ? readStore(dir) : applyToStore(dir, add(`할 일 ${i}`), 'app')));
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.ok && r.warning === undefined)).toBe(true);
    expect((await read()).state.tasks).toHaveLength(11);
  });

  it('남이 쥔 잠금이 풀리면 이어서 저장한다', async () => {
    await apply(add('처음', 't_0'));
    const lock = path.join(dir, LOCK_NAME);
    await writeFile(lock, 'other', 'utf8');
    setTimeout(() => void rm(lock, { force: true }), 250);
    const s = await apply(add('기다렸다 저장', 't_1'));
    expect(s.tasks.map((t) => t.id)).toEqual(['t_0', 't_1']);
    expect(await strays()).toEqual([]);
  });

  it('남이 쓰는 중인 반쪽 파일을 읽어도 깨진 파일로 치지 않는다 — 잠금이 풀린 뒤 다시 읽는다', async () => {
    const s = await apply(add('처음', 't_0'));
    const full = await stateText();
    const file = path.join(dir, STATE_NAME);
    const lock = path.join(dir, LOCK_NAME);
    await writeFile(lock, 'other', 'utf8'); // 다른 프로세스가 잠금을 쥐고
    await writeFile(file, full.slice(0, 20), 'utf8'); // 바로 쓰는 중이라 반쪽만 보인다
    setTimeout(() => void writeFile(file, full, 'utf8').then(() => rm(lock, { force: true })), 250);
    expect(await read()).toEqual({ state: s, warning: undefined });
    expect((await readdir(dir)).sort()).toEqual([STATE_NAME, LOG_NAME].sort()); // .bad- 로 옮긴 것이 없다
  });

  it('5초 넘은 잠금은 오래된 것으로 보고 치운 뒤 저장한다', async () => {
    await apply(add('처음', 't_0'));
    const lock = path.join(dir, LOCK_NAME);
    await writeFile(lock, 'dead', 'utf8');
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    const started = Date.now();
    const s = await apply(add('바로 저장', 't_1'));
    expect(Date.now() - started).toBeLessThan(1500); // 2초를 다 기다리지 않는다
    expect(s.rev).toBe(2);
    expect(await strays()).toEqual([]);
  });

  it('남이 잠금을 계속 쥐고 있으면 2초쯤 뒤 실패로 돌려주고, 파일도 남의 잠금도 건드리지 않는다', async () => {
    await apply(add('처음', 't_0'));
    const before = await stateText();
    const lock = path.join(dir, LOCK_NAME);
    await writeFile(lock, 'other', 'utf8');
    const started = Date.now();
    const r = await applyToStore(dir, add('못 들어감', 't_1'), 'app');
    const waited = Date.now() - started;
    expect(r).toEqual({ ok: false, error: expect.stringContaining('저장하는 중') });
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThan(4000);
    expect(await stateText()).toBe(before);
    expect(await readFile(lock, 'utf8')).toBe('other');
    await rm(lock);
    expect((await apply(add('이제 들어감', 't_2'))).rev).toBe(2); // 실패한 뒤에도 줄이 막히지 않는다
  });
});

describe('실패한 동작', () => {
  it('입력이 틀리면(PlannerError) 파일·백업·기록을 바꾸지 않는다', async () => {
    await apply(add('하나', 't_a'));
    await apply(add('둘', 't_b'));
    const before = { text: await stateText(), mtimeMs: (await stat(path.join(dir, STATE_NAME))).mtimeMs, log: await logLines(), backups: await backups() };

    const bad: PlannerOp[] = [
      { type: 'task.add', draft: { title: '   ' } },
      { type: 'task.add', draft: { title: '가짜 날짜', due: '2026-02-30' } },
      { type: 'task.update', id: 't_none', patch: { title: '없는 할 일' } },
      { type: 'task.add', id: 't_a', draft: { title: '같은 ID' } },
      null as unknown as PlannerOp,
    ];
    for (const op of bad) {
      const r = await applyToStore(dir, op, 'app');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toBe('');
    }

    expect(await stateText()).toBe(before.text);
    expect((await stat(path.join(dir, STATE_NAME))).mtimeMs).toBe(before.mtimeMs);
    expect(await logLines()).toEqual(before.log);
    expect(await backups()).toEqual(before.backups);
    expect(await strays()).toEqual([]);
    expect((await read()).state.rev).toBe(2);
  });

  it('백업을 만들지 못하면 덮어쓰지 않는다 — 잠금·임시 파일도 남기지 않는다', async () => {
    await apply(add('하나', 't_a'));
    const before = await stateText();
    await writeFile(path.join(dir, BACKUP_DIR_NAME), '폴더 자리에 놓인 파일', 'utf8');
    const r = await applyToStore(dir, add('둘', 't_b'), 'app');
    expect(r.ok).toBe(false);
    expect(await stateText()).toBe(before);
    expect(await strays()).toEqual([]);
  });

  it('저장 파일을 읽을 수 없으면(깨진 것이 아니라) 옮기지 않고 오류로 돌려준다', async () => {
    await mkdir(path.join(dir, STATE_NAME), { recursive: true }); // 파일 자리에 폴더
    expect((await readStore(dir)).ok).toBe(false);
    expect((await applyToStore(dir, add('하나'), 'app')).ok).toBe(false);
    expect(await readdir(dir)).toEqual([STATE_NAME]);
  });
});
