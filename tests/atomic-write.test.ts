// @vitest-environment node
/**
 * 원자적 저장(electron/atomic.ts) — 쓰다 끊겨도 원본이 반쪽으로 남지 않고, 겹쳐 저장해도 내용이 섞이지 않는다.
 * 실제 임시 폴더에 쓰고 읽는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../electron/atomic';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tb-atomic-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('새 파일·기존 파일 모두 쓰고, 임시 파일을 남기지 않는다', async () => {
    const file = path.join(dir, 'a.md');
    await writeFileAtomic(file, '첫 내용');
    expect(await readFile(file, 'utf8')).toBe('첫 내용');
    await writeFileAtomic(file, Buffer.from('둘째 내용', 'utf8'));
    expect(await readFile(file, 'utf8')).toBe('둘째 내용');
    expect(await readdir(dir)).toEqual(['a.md']);
  });

  it('[A-5] 같은 파일에 길이가 다른 내용을 겹쳐 저장해도 섞이지 않는다 — 결과는 그중 하나 그대로', async () => {
    const file = path.join(dir, 'state.json');
    const states = Array.from({ length: 30 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat((30 - i) * 200) }));
    const results = await Promise.allSettled(states.map((s) => writeFileAtomic(file, s)));
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const got = await readFile(file, 'utf8');
    expect(states).toContain(got); // 긴 내용 꼬리가 짧은 내용 뒤에 남아 JSON이 깨지던 경로
    expect(() => JSON.parse(got)).not.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('[A-8] 바꿔치기가 실패해도 임시 파일을 남기지 않고, 원본은 그대로다', async () => {
    // 대상 자리에 폴더가 있으면 rename·바로 쓰기 모두 실패한다
    const target = path.join(dir, 'taken');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), '원본');
    await expect(writeFileAtomic(target, '새 내용', { prefix: '.tb-worklog-', fallbackDirect: true })).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('원본');
  });

  it('임시 파일 이름 머리를 바꿀 수 있다 (작업일지 폴더의 .tb-worklog-)', async () => {
    const file = path.join(dir, 'b.txt');
    await writeFileAtomic(file, 'x', { prefix: '.tb-worklog-' });
    expect(await readFile(file, 'utf8')).toBe('x');
  });
});
