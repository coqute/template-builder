import { describe, expect, it } from 'vitest';
import { parse } from '../src/core/parser';
import { validate } from '../src/core/validator';

const VALID = `@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-08

# 2026-04-27(월)
@LOC 남산
@CUS 남산 IDC
@SUM [ABZ+] (이영희) 작업 진행
1) 시연
- 가이드
`;

describe('validator', () => {
  it('정상 입력은 ok=true', () => {
    const r = validate(parse(VALID));
    expect(r.ok).toBe(true);
    expect(r.stats.days).toBe(1);
    expect(r.stats.locations).toBe(1);
    expect(r.stats.clientItems).toBe(1);
  });

  it('잘못된 요일은 warning', () => {
    const md = VALID.replace('# 2026-04-27(월)', '# 2026-04-27(화)');
    const r = validate(parse(md));
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.severity === 'warning' && i.message.includes('요일'))).toBe(true);
  });

  it('## 없는 일자는 warning', () => {
    const md = `@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-08

# 2026-04-27(월)
`;
    const r = validate(parse(md));
    expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});
