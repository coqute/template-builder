import { describe, expect, it } from 'vitest';
import { GRAMMAR, highlightClassFor } from '../src/core/grammar';

/**
 * Grammar Registry 동형성 게이트 (G3-1) —
 * 불변식: 파서(GRAMMAR)가 수용하는 라인은 반드시 하이라이트 규칙에도 매치되고,
 * 기대한 tok-* 클래스로 칠해진다. 문법 변경 시 이 테스트가 3곳 동기화를 강제한다.
 */

// [파서 규칙, 수용 샘플, 기대 하이라이트 클래스]
const CASES: Array<[keyof typeof GRAMMAR, string, string]> = [
  ['prev', '@PREV 2026-05-11 ~ 2026-05-17', 'tok-week'],
  ['prev', '@WEEK 2026.5.11 ~ 2026.5.17', 'tok-week'], // legacy 별칭 + 점 날짜
  ['current', '@CURRENT 2026-05-18 ~ 2026-05-24', 'tok-next'],
  ['author', '@AUTHOR 홍길동', 'tok-author'],
  ['day', '# 2026-05-11(월)', 'tok-day'],
  ['day', '#2026.5.1', 'tok-day'], // 공백·요일 생략 + 한 자리 월일
  ['loc', '@LOC 한강 제트플러스 4F', 'tok-loc'],
  ['cus', '@CUS 한강 SRE', 'tok-loc'],
  ['holiday', '@HOLIDAY 근로자의 날', 'tok-holiday'],
  ['client', '@SUM [ABZ+] (이영희/메일) 수집서버 설치', 'tok-client'],
  ['client', '## [ABZ+] legacy 헤더', 'tok-client'],
  ['num', '1) 관리 콘솔 설치', 'tok-num'],
  ['dash', '- 세부 항목', 'tok-dash'],
  ['qaQ', '<- 사용자 문의', 'tok-qaq'],
  ['qaA', '-> 답변', 'tok-qaa'],
  ['note', '> 보조 설명', 'tok-note'],
];

describe('grammar 동형성 — 파서 수용 ⊆ 하이라이트 매치', () => {
  for (const [rule, sample, cls] of CASES) {
    it(`${String(rule)}: "${sample}" → ${cls}`, () => {
      expect(GRAMMAR[rule].test(sample)).toBe(true); // 파서 수용
      expect(highlightClassFor(sample)).toBe(cls); // 하이라이트 동형
    });
  }

  it('@SUM 헤더 3종은 parser·importer가 같은 캡처를 공유한다', () => {
    const ch = '[ABZ+] (이영희/유선&메일) 문의'.match(GRAMMAR.clientChannel)!;
    expect([ch[1], ch[2], ch[3], ch[4]]).toEqual(['ABZ+', '이영희', '유선&메일', '문의']);
    const nw = '[ABZ+] (이영희) 작업'.match(GRAMMAR.clientNew)!;
    expect([nw[1], nw[2], nw[3]]).toEqual(['ABZ+', '이영희', '작업']);
    const bare = '[ABZ+] 일반 지원'.match(GRAMMAR.clientBare)!;
    expect([bare[1], bare[2]]).toEqual(['ABZ+', '일반 지원']);
  });

  it('비문법 라인은 하이라이트되지 않는다', () => {
    expect(highlightClassFor('그냥 본문 텍스트')).toBeUndefined();
    expect(highlightClassFor('-붙은대시(공백없음)')).toBeUndefined();
    expect(highlightClassFor('#날짜아님')).toBeUndefined();
  });
});
