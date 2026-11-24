// @vitest-environment node
/**
 * 공개 사본의 README는 원본의 README.public.md에서 만든다 — 공개 동기화가 `include: 이름` 줄을
 * README.md의 `public:이름` 구간으로 바꾸고 공개 규칙을 거쳐 공개 사본의 README.md로 쓴다.
 * 여기서는 그 원본이 어긋나지 않았는지만 본다. 공개 사본에는 README.public.md가 없으므로 건너뛴다.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'README.public.md');
const has = existsSync(SRC);
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe.skipIf(!has)('공개 사본 README 원본 (README.public.md)', () => {
  const src = has ? readFileSync(SRC, 'utf8') : '';
  const readme = has ? readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
  const includes = [...src.matchAll(/^<!-- include: ([\w-]+) -->[ \t]*$/gm)].map((m) => m[1]);
  const blocks = [...readme.matchAll(/^<!-- public:([\w-]+) -->[ \t]*$/gm)].map((m) => m[1]);

  it('끼워 넣을 구간이 README.md에 하나씩, 열고 닫는 순서로 있다', () => {
    expect(includes.length).toBeGreaterThan(0);
    for (const name of includes) {
      expect(count(readme, `<!-- public:${name} -->`), name).toBe(1);
      expect(count(readme, `<!-- /public:${name} -->`), name).toBe(1);
      expect(readme.indexOf(`<!-- public:${name} -->`), name).toBeLessThan(readme.indexOf(`<!-- /public:${name} -->`));
    }
  });

  it('README.md에 표시한 공개 구간은 모두 쓰인다 — 표시만 하고 끼워 넣지 않은 구간이 없다', () => {
    expect([...blocks].sort()).toEqual([...includes].sort());
  });

  it('지금 버전이 적혀 있다 — 변경 이력 표나 "빠진 버전" 문장에', () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const rx = new RegExp(`(?<![\\d.])${version.replace(/\./g, '\\.')}(?![\\d.])`);
    expect(rx.test(src), `README.public.md에 ${version}이 없습니다`).toBe(true);
  });

  it('맨 위 안내 주석은 하나이고, 본문은 제목으로 시작한다', () => {
    expect(src.startsWith('<!--')).toBe(true);
    expect(src.slice(src.indexOf('-->') + 3).trimStart().startsWith('# ')).toBe(true);
  });
});
