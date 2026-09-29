import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from '../src/core/parser';
import { renderHtml, renderPlain } from '../src/core/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(__dirname, 'fixtures/sample-week-04-27.md'), 'utf8');

describe('renderer', () => {
  it('헤더에 ■ 주간 보고와 □ Date(PREV 주차, `YYYY. MM. DD`)를 포함한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('■ 주간 보고');
    expect(html).not.toContain('주간 보고서');
    expect(html).toContain('□ Date : 2026. 04. 27 ~ 2026. 05. 03');
  });

  it('표 컬럼 헤더 5개를 포함한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('일자');
    expect(html).toContain('지원장소');
    expect(html).toContain('고객사|작업구분');
    expect(html).toContain('내용');
    expect(html).toContain('기타');
  });

  it('@CUS 텍스트가 고객사/작업구분 셀에 들어간다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('남산 IDC');
    expect(html).toContain('ABZ+ SRE');
  });

  it('@SUM 라인이 내용 셀 굵은 헤더로 표시된다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('font-weight:700');
    expect(html).toContain('[ABZ+] (이영희) 신규 수집 서버 설치');
  });

  it('같은 @LOC + 다중 @CUS는 장소 셀 rowspan으로 병합한다', () => {
    const html = renderHtml(parse(SAMPLE));
    // 04-29: 같은 @LOC(한강 제트플러스 4F) 아래 두 @CUS → 장소 셀 rowspan=2
    expect(html).toMatch(/rowspan="2"[^>]*>한강 제트플러스 4F/);
  });

  it('일자별로 rowspan을 적절히 설정한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('rowspan="2"');
  });

  it('표 폭 960px 캔버스를 기본값으로 적용한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('width:960px');
  });

  it('width 옵션으로 표 폭을 변경할 수 있다', () => {
    const html = renderHtml(parse(SAMPLE), { width: 720 });
    expect(html).toContain('width:720px');
  });

  it('Pretendard fallback chain이 폰트로 적용된다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('Pretendard Variable');
    expect(html).toContain('Malgun Gothic');
  });

  it('한글 가독성 위해 word-break:keep-all 적용', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('word-break:keep-all');
  });

  it('@HOLIDAY 일자는 빨간 배경 행 + 내용 셀에 사유를 출력한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('background:#FFCCCC');
    expect(html).toContain('color:#B91C1C');
    expect(html).toContain('근로자의 날'); // 휴무 사유는 내용 셀에 표기
    // 기타 셀에 (휴무) 텍스트는 표시하지 않음
    expect(html).not.toContain('(휴무)');
  });

  it('Q&A를 화살표 텍스트로 출력한다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('&lt;- 재시작 전/후');
    expect(html).toContain('-&gt; 재시작 이전)');
  });

  it('plain 출력은 탭 구분 표 형식이다', () => {
    const plain = renderPlain(parse(SAMPLE));
    const lines = plain.split('\n');
    expect(lines[0]).toBe('■ 주간 보고');
    expect(plain).toContain('일자\t지원장소\t고객사|작업구분\t내용\t기타');
    expect(plain).toContain('2026-04-27(월)');
  });

  it('기타 셀에 전각 공백을 채운다', () => {
    const html = renderHtml(parse(SAMPLE));
    expect(html).toContain('　');
  });
});
