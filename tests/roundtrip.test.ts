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

  // P1-3: parser↔importer가 normalizeChannelValue를 공유 — 변주도 HTML 재임포트에서 소실되지 않는다
  it('채널 공백 변주(유선 & 메일)는 HTML 재임포트 후에도 표준값으로 보존된다', () => {
    const md = [
      '@PREV 2026-05-11 ~ 2026-05-17',
      '@CURRENT 2026-05-18 ~ 2026-05-24',
      '',
      '# 2026-05-11(월)',
      '@LOC 한강',
      '@CUS 한강 SRE',
      '@SUM [ABZ+] (이영희/유선 & 메일) 채널 변주 문의',
      '- 내용',
      '',
    ].join('\n');
    const a = parse(md);
    expect(a.days[0].blocks[0].items[0].channel).toBe('유선&메일'); // parser 수렴

    const { report: imported, warnings } = importFromHtml(renderHtml(a));
    expect(imported.days[0].blocks[0].items[0].channel).toBe('유선&메일'); // importer 공유 규칙
    expect(warnings.filter((w) => w.includes('알 수 없는 채널'))).toHaveLength(0);
  });

  it('미등록 채널은 재임포트에서도 괄호 원문 그대로 보존된다 (소실 금지) + 경고', () => {
    const md = [
      '@PREV 2026-05-11 ~ 2026-05-17',
      '@CURRENT 2026-05-18 ~ 2026-05-24',
      '',
      '# 2026-05-11(월)',
      '@SUM [ABZ+] (홍길동/화상회의) 비표준 채널 문의',
      '- 내용',
      '',
    ].join('\n');
    const a = parse(md);
    expect(a.days[0].blocks[0].items[0].contact).toBe('홍길동/화상회의');

    const { report: imported, warnings } = importFromHtml(renderHtml(a));
    expect(imported.days[0].blocks[0].items[0].contact).toBe('홍길동/화상회의');
    expect(warnings.some((w) => w.includes('표준 채널'))).toBe(true);
  });

  it('v2 표준 채널(슬랙·문자·카톡)은 경고 없이 담당자/채널로 나뉜다', () => {
    const md = [
      '@PREV 2026-05-11 ~ 2026-05-17',
      '',
      '# 2026-05-11(월)',
      '@SUM [가나스토어] (홍길동/슬랙) 로그 조회 방법 안내',
      '@SUM [XYZ] (담당A/카톡) 에이전트 전달',
      '@SUM [제트플러스] (담당B/문자) 장비 등록 요청',
      '',
    ].join('\n');
    const items = parse(md).days[0].blocks[0].items;
    expect(items.map((i) => [i.contact, i.channel])).toEqual([
      ['홍길동', '슬랙'],
      ['담당A', '카톡'],
      ['담당B', '문자'],
    ]);
    expect(importFromHtml(renderHtml(parse(md))).warnings).toEqual([]);
  });
});
