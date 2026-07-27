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
  ['halfday', '@HALFDAY 오후 반차', 'tok-holiday'],
  ['client', '@SUM [ABZ+] (홍길동/메일) 수집서버 설치', 'tok-client'],
  ['client', '## [ABZ+] legacy 헤더', 'tok-client'],
  ['num', '1) 관리 콘솔 설치', 'tok-num'],
  ['dash', '- 세부 항목', 'tok-dash'],
  ['turnOut', '<- 안내 전달', 'tok-out'],
  ['turnIn', '-> 고객 문의', 'tok-in'],
  ['pending', '*<- 제조사 문의 예정', 'tok-pending'],
  ['pending', '*-> 회신 대기', 'tok-pending'],
  ['conclusion', '*==> 대응 절차 정리 필요', 'tok-conclusion'],
  ['plan', '@PLAN 2026-05-19 10:00 MX(주간미팅)', 'tok-next'],
  ['note', '> 보조 설명', 'tok-note'],
];

describe('grammar 동형성 — 파서 수용 ⊆ 하이라이트 매치', () => {
  for (const [rule, sample, cls] of CASES) {
    it(`${String(rule)}: "${sample}" → ${cls}`, () => {
      expect(GRAMMAR[rule].test(sample)).toBe(true); // 파서 수용
      expect(highlightClassFor(sample)).toBe(cls); // 하이라이트 동형
    });
  }

  it('들여쓴 본문 줄도 같은 클래스로 칠해진다 (들여쓰기 = 계층)', () => {
    expect(highlightClassFor('  -> 고객 문의')).toBe('tok-in');
    expect(highlightClassFor('   <- 안내')).toBe('tok-out');
    expect(highlightClassFor('    1) 세부 단계')).toBe('tok-num');
    expect(highlightClassFor('  *==> 결론')).toBe('tok-conclusion');
  });

  it('비문법 라인은 하이라이트되지 않는다', () => {
    expect(highlightClassFor('그냥 본문 텍스트')).toBeUndefined();
    expect(highlightClassFor('-붙은대시(공백없음)')).toBeUndefined();
    expect(highlightClassFor('#날짜아님')).toBeUndefined();
  });
});
