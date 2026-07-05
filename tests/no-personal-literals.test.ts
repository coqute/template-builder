import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// G1 게이트 — 개인 식별자가 배포 코드(src/, electron/, assets/)에 재유입되는 것을 차단.
// tests/의 fixture·명시적 테스트 데이터는 허용.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED = /박민수|user01/;
const EXTS = new Set(['.ts', '.tsx', '.json', '.md', '.html', '.css']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(p))) out.push(p);
  }
  return out;
}

describe('개인 식별자 게이트', () => {
  it('src/·electron/·assets/에 박민수|user01 리터럴이 없다', () => {
    const files = [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'electron')),
      ...walk(path.join(ROOT, 'assets')),
    ];
    const offenders = files.filter((f) => BANNED.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
