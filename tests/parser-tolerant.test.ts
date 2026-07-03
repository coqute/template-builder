import { describe, expect, it } from 'vitest';
import { parse, parseTolerant, ParseError } from '../src/core/parser';

const HEADER = `@PREV 2026-05-11 ~ 2026-05-17
@CURRENT 2026-05-18 ~ 2026-05-24
`;

describe('parseTolerant — 복구 정책', () => {
  it('정상 입력은 진단 0건', () => {
    const { diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(diagnostics).toEqual([]);
  });

  it('@SUM 브래킷 없는 자유 텍스트 → client="" + workType=전체 + warning', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM 브래킷 없는 작업 설명
- 내용
`);
    const item = report.days[0].blocks[0].items[0];
    expect(item.client).toBe('');
    expect(item.workType).toBe('브래킷 없는 작업 설명');
    expect(diagnostics.some((d) => d.code === 'sum-no-bracket' && d.severity === 'warning')).toBe(
      true,
    );
  });

  it('@SUM [고객사]만 (workType 없음) → 빈 workType 수용, 파서 진단 없음', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+]
- 내용
`);
    const item = report.days[0].blocks[0].items[0];
    expect(item.client).toBe('ABZ+');
    expect(item.workType).toBe('');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('채널 공백 변주(유선 & 메일) → 표준 값으로 정규화 + info', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] (강하늘/유선 & 메일) 작업
- 내용
`);
    expect(report.days[0].blocks[0].items[0].channel).toBe('유선&메일');
    expect(diagnostics.some((d) => d.code === 'channel-normalized' && d.severity === 'info')).toBe(
      true,
    );
  });

  it('미등록 채널 → raw 보존 + warning (throw 없음)', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] (강하늘/화상회의) 작업
- 내용
`);
    expect(report.days[0].blocks[0].items[0].channel).toBe('화상회의');
    expect(diagnostics.some((d) => d.code === 'unknown-channel' && d.severity === 'warning')).toBe(
      true,
    );
    // strict parse도 throw하지 않음 (warning)
    expect(() =>
      parse(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] (강하늘/화상회의) 작업
- 내용
`),
    ).not.toThrow();
  });

  it('요일 생략 → getWeekday 자동 보충 + info', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(report.days[0].weekday).toBe('월');
    expect(diagnostics.some((d) => d.code === 'day-no-weekday' && d.severity === 'info')).toBe(
      true,
    );
  });

  it('점 표기·한 자리 월일·# 뒤 공백 없음 → ISO 정규화 + info', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
#2026.5.11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(report.days[0].date).toBe('2026-05-11');
    expect(diagnostics.some((d) => d.code === 'day-normalized')).toBe(true);
  });

  it('잘못된 요일 문자 → 자동 교정 + warning', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(엉)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(report.days[0].weekday).toBe('월');
    expect(diagnostics.some((d) => d.code === 'day-bad-weekday' && d.severity === 'warning')).toBe(
      true,
    );
  });

  it('요일 불일치(유효 요일)는 파서가 손대지 않음 — 기재값 유지', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(화)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(report.days[0].weekday).toBe('화');
    expect(diagnostics).toEqual([]);
  });

  it('본문이 @SUM 없이 시작 → 암묵 항목 생성 + warning', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
1) 작업 항목
- 내용
`);
    const item = report.days[0].blocks[0].items[0];
    expect(item.client).toBe('');
    expect(item.content[0]).toMatchObject({ kind: 'numbered', index: 1 });
    expect(diagnostics.some((d) => d.code === 'content-no-sum' && d.severity === 'warning')).toBe(
      true,
    );
  });

  it('@LOC가 # 일자 앞 → warning + 스킵', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}@LOC 한강
# 2026-05-11(월)
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(diagnostics.some((d) => d.code === 'loc-before-day' && d.severity === 'warning')).toBe(
      true,
    );
    expect(report.days[0].blocks[0].locations).toEqual([]);
  });

  it('인식 불가 라인 (currentItem 없음) → warning + 스킵', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}
# 2026-05-11(월)
완전히 이상한 라인
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(diagnostics.some((d) => d.code === 'unknown-syntax' && d.severity === 'warning')).toBe(
      true,
    );
    expect(report.days[0].blocks[0].items[0].client).toBe('ABZ+');
  });

  it('@PREV 누락 → error 진단 + 첫 일자 기준 주(월~일) 추정', () => {
    const { report, diagnostics } = parseTolerant(`# 2026-05-13(수)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(diagnostics.some((d) => d.code === 'prev-missing' && d.severity === 'error')).toBe(true);
    expect(report.prevWeekRange).toEqual({ start: '2026-05-11', end: '2026-05-17' });
  });

  it('@PREV 점 표기 → ISO 정규화 + info', () => {
    const { report, diagnostics } = parseTolerant(`@PREV 2026.05.11 ~ 2026.05.17

# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    expect(report.prevWeekRange).toEqual({ start: '2026-05-11', end: '2026-05-17' });
    expect(diagnostics.some((d) => d.code === 'range-normalized' && d.severity === 'info')).toBe(
      true,
    );
  });

  it('srcLine이 day/block/item에 기록된다', () => {
    const { report } = parseTolerant(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM [ABZ+] 작업
- 내용
`);
    const day = report.days[0];
    expect(day.srcLine).toBe(4);
    expect(day.blocks[0].srcLine).toBe(5);
    expect(day.blocks[0].items[0].srcLine).toBe(7);
  });
});

describe('parse (strict 래퍼) — 하위 호환', () => {
  it('@PREV 누락은 여전히 ParseError throw', () => {
    expect(() => parse('# 2026-04-27(월)\n@LOC X\n@CUS Y\n@SUM [Z] w')).toThrow(ParseError);
  });

  it('warning만 있는 입력은 throw하지 않는다', () => {
    expect(() =>
      parse(`${HEADER}
# 2026-05-11(월)
@LOC 한강
@CUS SRE
@SUM 브래킷 없는 작업
- 내용
`),
    ).not.toThrow();
  });
});
