// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseTolerant } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { validate } from '../src/core/validator';
import { renderHtml } from '../src/core/renderer';
import { importFromHtml } from '../src/core/importer';
import { toggleHalfday, updateHalfdayLabel } from '../src/core/edit';

const MD = `@PREV 2026-07-20 ~ 2026-07-26
@CURRENT 2026-07-27 ~ 2026-08-02
@AUTHOR 테스터

# 2026-07-23(목)
@HALFDAY 오후 반차(13:00~18:00)
@LOC 한강 제트플러스 4F
@CUS 한강 SRE
@SUM [ABZ+] 이벤트 점검
- 규칙 정리

# 2026-07-24(금)
@HALFDAY 오전 반차
`;

describe('@HALFDAY — 반차(부분 근태)', () => {
  it('파싱: partial 라벨 + blocks 공존, 라벨 생략 시 빈 문자열', () => {
    const { report, diagnostics } = parseTolerant(MD);
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(report.days[0].partial).toEqual({ label: '오후 반차(13:00~18:00)' });
    expect(report.days[0].blocks).toHaveLength(1);
    expect(report.days[1].partial).toEqual({ label: '오전 반차' });

    const bare = parseTolerant('@PREV 2026-07-20 ~ 2026-07-26\n@CURRENT 2026-07-27 ~ 2026-08-02\n\n# 2026-07-23(목)\n@HALFDAY\n').report;
    expect(bare.days[0].partial).toEqual({ label: '' });
  });

  it('검증: 반차만 있고 블록 없는 날은 경고 면제', () => {
    const { report } = parseTolerant(MD);
    const warnings = validate(report).issues.filter((i) => i.severity === 'warning');
    expect(warnings.filter((w) => w.message.includes('블록이 없습니다'))).toHaveLength(0);
  });

  it('직렬화 왕복: @HALFDAY 라인·라벨 보존', () => {
    const { report } = parseTolerant(MD);
    const md2 = serialize(report);
    expect(md2).toContain('@HALFDAY 오후 반차(13:00~18:00)');
    const rt = parseTolerant(md2).report;
    expect(rt.days[0].partial).toEqual(report.days[0].partial);
    expect(rt.days[1].partial).toEqual(report.days[1].partial);
  });

  it('렌더: 날짜 셀에 주황 라벨, 행 배경은 근무일 유지', () => {
    const { report } = parseTolerant(MD);
    const html = renderHtml(report);
    expect(html).toContain('#C2410C');
    expect(html).toContain('오후 반차(13:00~18:00)');
    // 반차 행이 휴무 배경(FFCCCC)으로 칠해지면 안 됨
    expect(html).not.toContain('FFCCCC');
  });

  it('HTML 임포트 왕복: 날짜 셀 라벨에서 partial 복원', () => {
    const { report } = parseTolerant(MD);
    const html = renderHtml(report);
    const { report: imported } = importFromHtml(html);
    expect(imported.days[0].partial?.label).toBe('오후 반차(13:00~18:00)');
    expect(imported.days[1].partial?.label).toBe('오전 반차');
  });

  it('에디터 리듀서: 토글 시드/제거, 라벨 갱신, blocks 보존', () => {
    const { report } = parseTolerant(MD);
    const base = { ...report, days: report.days.map((d) => ({ ...d })) };
    delete base.days[0].partial;

    const on = toggleHalfday(base, 0);
    expect(on.days[0].partial).toEqual({ label: '오후 반차' });
    expect(on.days[0].blocks).toHaveLength(1);

    const relabeled = updateHalfdayLabel(on, 0, '조퇴(15시)');
    expect(relabeled.days[0].partial).toEqual({ label: '조퇴(15시)' });

    const off = toggleHalfday(relabeled, 0);
    expect(off.days[0].partial).toBeUndefined();
    expect(off.days[0].blocks).toHaveLength(1);
  });
});
