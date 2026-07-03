import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTolerant } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { renderHtml } from '../src/core/renderer';
import { validate } from '../src/core/validator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL = readFileSync(path.join(__dirname, 'fixtures/week-05-11.md'), 'utf8');

// 실사용 주간보고서(5/11~5/17, `>` 노트 다수 + 다중 @CUS + @HOLIDAY) 회귀 고정 —
// "기존 파일 무수정 로드"가 깨지면 이 테스트가 막는다.
describe('실사용 파일 회귀', () => {
  it('error 진단 0건으로 파싱된다', () => {
    const { diagnostics } = parseTolerant(REAL);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('validator error 0건 (발송 가능 상태)', () => {
    const { report } = parseTolerant(REAL);
    const v = validate(report);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('렌더가 성공하고 노트 이중 마커가 없다', () => {
    const { report } = parseTolerant(REAL);
    const html = renderHtml(report);
    expect(html).toContain('■ 주간 보고서');
    expect(html).not.toMatch(/- &gt; /);
    // `>` 노트가 보조 스타일로 출력됨
    expect(html).toContain('margin-left:16px;color:#6B7280;');
  });

  it('roundtrip: parse→serialize→parse AST 보존', () => {
    const { report: a } = parseTolerant(REAL);
    const { report: b, diagnostics } = parseTolerant(serialize(a));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(b.days.map((d) => d.date)).toEqual(a.days.map((d) => d.date));
    for (let i = 0; i < a.days.length; i++) {
      expect(b.days[i].blocks.length).toBe(a.days[i].blocks.length);
      for (let j = 0; j < a.days[i].blocks.length; j++) {
        expect(b.days[i].blocks[j].customer).toBe(a.days[i].blocks[j].customer);
        expect(b.days[i].blocks[j].items.map((it) => it.content)).toEqual(
          a.days[i].blocks[j].items.map((it) => it.content),
        );
      }
    }
  });
});
