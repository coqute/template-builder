import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { renderHtml } from '../src/core/renderer';
import { importFromHtml } from '../src/core/importer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(__dirname, 'fixtures/sample-week-04-27.md'), 'utf8');

describe('roundtrip', () => {
  it('parse → serialize → parse 결과가 동일 AST를 만든다', () => {
    const a = parse(SAMPLE);
    const md = serialize(a);
    const b = parse(md);

    expect(b.prevWeekRange).toEqual(a.prevWeekRange);
    expect(b.currentWeekRange).toEqual(a.currentWeekRange);
    expect(b.days.length).toBe(a.days.length);
    expect(b.days[0].blocks[0].items[0].client).toBe(a.days[0].blocks[0].items[0].client);
    expect(b.days[0].blocks[0].customer).toBe(a.days[0].blocks[0].customer);
    expect(b.days[1].blocks[1].items[0].workType).toBe(a.days[1].blocks[1].items[0].workType);
  });

  it('@HOLIDAY는 roundtrip 후에도 보존된다', () => {
    const a = parse(SAMPLE);
    const md = serialize(a);
    const b = parse(md);
    const aH = a.days.find((d) => d.date === '2026-05-01');
    const bH = b.days.find((d) => d.date === '2026-05-01');
    expect(aH?.holiday).toEqual({ reason: '근로자의 날' });
    expect(bH?.holiday).toEqual({ reason: '근로자의 날' });
  });

  it('parse → renderHtml → importFromHtml → serialize → parse 도 살아남는다', () => {
    const a = parse(SAMPLE);
    const html = renderHtml(a);
    const { report: imported } = importFromHtml(html);

    // 본문 □ Date는 PREV만 명시 → CURRENT는 importer가 PREV+7일로 추정. 시작일만 동일.
    expect(imported.currentWeekRange.start).toEqual(a.currentWeekRange.start);
    expect(imported.days.map((d) => d.date)).toEqual(a.days.map((d) => d.date));

    const md = serialize(imported);
    const b = parse(md);
    expect(b.days.length).toBe(a.days.length);
    expect(b.days[1].blocks[0].items[0].channel).toBe('유선&메일');
  });
});
