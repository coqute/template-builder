import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTolerant, parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { renderHtml } from '../src/core/renderer';

/**
 * G2-1 특성 고정(characterization) 스냅샷 — G2(셸 모듈화)/G3(Grammar Registry) 리팩토링의
 * 전후 무변화 게이트. 스냅샷이 변하면 의도된 동작 변경인지 diff로 반드시 리뷰할 것.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES: Array<{ name: string; md: string }> = [
  { name: 'sample-week-04-27', md: readFileSync(path.join(__dirname, 'fixtures/sample-week-04-27.md'), 'utf8') },
  { name: 'week-05-11', md: readFileSync(path.join(__dirname, 'fixtures/week-05-11.md'), 'utf8') },
  { name: 'assets-sample-week', md: readFileSync(path.join(__dirname, '../assets/sample-week.md'), 'utf8') },
];

describe.each(FIXTURES)('특성 고정: $name', ({ md }) => {
  it('parseTolerant AST + 진단 고정', () => {
    const { report, diagnostics } = parseTolerant(md);
    expect({ report, diagnostics }).toMatchSnapshot();
  });

  it('renderHtml 출력 고정', () => {
    expect(renderHtml(parse(md))).toMatchSnapshot();
  });

  it('serialize∘parse 고정점', () => {
    expect(serialize(parse(md))).toMatchSnapshot();
  });
});
