import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, ParseError } from '../src/core/parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(__dirname, 'fixtures/sample-week-04-27.md'), 'utf8');

describe('parser', () => {
  it('@PREV / @CURRENT / @AUTHOR를 파싱한다', () => {
    const r = parse(SAMPLE);
    expect(r.prevWeekRange).toEqual({ start: '2026-04-27', end: '2026-05-03' });
    expect(r.currentWeekRange).toEqual({ start: '2026-05-04', end: '2026-05-08' });
    expect(r.authorName).toBe('박민수');
  });

  it('일자 행을 순서대로 만든다', () => {
    const r = parse(SAMPLE);
    expect(r.days.map((d) => d.date)).toEqual(['2026-04-27', '2026-04-29', '2026-05-01']);
    expect(r.days[0].weekday).toBe('월');
    expect(r.days[1].weekday).toBe('수');
    expect(r.days[2].weekday).toBe('금');
  });

  it('@HOLIDAY 디렉티브를 holiday로 흡수한다', () => {
    const r = parse(SAMPLE);
    const holiday = r.days.find((d) => d.date === '2026-05-01');
    expect(holiday?.holiday).toEqual({ reason: '근로자의 날' });
    expect(holiday?.blocks).toEqual([]);
  });

  it('@HOLIDAY 사유 없이도 파싱한다', () => {
    const r = parse(`@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-08

# 2026-05-01(금)
@HOLIDAY
`);
    expect(r.days[0].holiday).toEqual({ reason: '' });
  });

  it('@LOC 지원장소를 배열로 만든다', () => {
    const r = parse(SAMPLE);
    expect(r.days[0].blocks[0].locations).toEqual(['남산 데이터센터']);
  });

  it('@CUS 고객사/작업구분 컬럼을 추출한다', () => {
    const r = parse(SAMPLE);
    expect(r.days[0].blocks[0].customer).toBe('남산 IDC');
  });

  it('@SUM [고객사] (담당자) 패턴을 파싱한다', () => {
    const r = parse(SAMPLE);
    const item = r.days[0].blocks[0].items[0];
    expect(item.client).toBe('ABZ+');
    expect(item.contact).toBe('이영희');
    expect(item.channel).toBeUndefined();
    expect(item.workType).toContain('PoC');
  });

  it('@SUM [고객사] (담당자/채널) 패턴을 파싱한다', () => {
    const r = parse(SAMPLE);
    const item = r.days[1].blocks[0].items[0];
    expect(item.client).toBe('ABZ+');
    expect(item.contact).toBe('이영희');
    expect(item.channel).toBe('유선&메일');
  });

  it('1) numbered + - 항목을 details로 흡수한다', () => {
    const r = parse(SAMPLE);
    const item = r.days[0].blocks[0].items[0];
    expect(item.content[0]).toMatchObject({ kind: 'numbered', index: 1 });
    if (item.content[0].kind === 'numbered') {
      expect(item.content[0].details[0]).toContain('Rocky 9');
    }
  });

  it('<- / -> 대화 이력을 시간순 턴으로 파싱한다', () => {
    const r = parse(SAMPLE);
    const item = r.days[1].blocks[0].items[0];
    const dialog = item.content.find((c) => c.kind === 'dialog');
    expect(dialog).toBeDefined();
    if (dialog && dialog.kind === 'dialog') {
      expect(dialog.turns.map((t) => t.kind)).toEqual(['out', 'in', 'in']);
      expect(dialog.turns[0].text).toContain('재시작 전/후');
    }
  });

  it('한 일자에 @LOC를 다시 선언하면 새 LocationBlock이 생긴다', () => {
    const r = parse(SAMPLE);
    expect(r.days[1].blocks).toHaveLength(3);
    expect(r.days[1].blocks[2].locations).toEqual(['한강SRE', '서원SRE']);
    expect(r.days[1].blocks[2].customer).toBe('ABZ+ SRE');
    expect(r.days[1].blocks[2].inheritLocation).toBeFalsy();
  });

  it('같은 @LOC 아래 @CUS가 여러 개면 sub-row block + inheritLocation=true', () => {
    const r = parse(SAMPLE);
    // 04-29 두 번째 block = 같은 @LOC(한강 제트플러스 4F) 두번째 @CUS
    const sub = r.days[1].blocks[1];
    expect(sub.inheritLocation).toBe(true);
    expect(sub.locations).toEqual(['한강 제트플러스 4F']);
    expect(sub.customer).toBe('한강 관제 개발팀 / (네트워크 부문)');
    expect(sub.items[0].client).toBe('ABZ+');
    expect(sub.items[0].contact).toBe('정다은');
  });

  it('@PREV가 없으면 ParseError를 던진다', () => {
    expect(() => parse('# 2026-04-27(월)\n@LOC X\n@CUS Y\n@SUM [Z] w')).toThrow(ParseError);
  });
});
