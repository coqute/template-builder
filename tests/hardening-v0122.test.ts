// @vitest-environment jsdom
/**
 * v0.12.2 회귀 고정 — 코드베이스 심층 분석(데이터 흐름·상태·계약)에서 검증된 결함의 재발 방지 (문서 형식 쪽).
 * 각 it 제목의 [C-n]은 분석 리포트의 발견 번호.
 */
import { describe, expect, it } from 'vitest';
import {
  importFromHtml,
  isRealIsoDate,
  parseTolerant,
  renderHtml,
  serialize,
  validate,
  type ContentBlock,
  type WeekReport,
} from '../src/core/index';
import { lossyLines } from '../src/doctypes/weekly';
import { validateTemplateData } from '../src/email/templates';
import { buildWeeklyMd, learnFromReports, type FolderMap } from '../src/worklog/toWeekly';
import type { WorklogFileText } from '../electron/worklog-types';

const HEADER = '@PREV 2026-11-02 ~ 2026-11-08\n@CURRENT 2026-11-09 ~ 2026-11-15\n@AUTHOR 김테스트\n\n';

describe('휴일로 표시한 날의 내용', () => {
  const md = `${HEADER}# 2026-11-07(토)\n@HOLIDAY\n\n# 2026-11-08(일)\n@HOLIDAY\n@LOC 회사\n@SUM [MX] 긴급 대응\n-> 장애 문의\n`;

  it('[C-1] @HOLIDAY 아래에 쓴 내용은 조용히 버리지 않고 알린다 (날마다 한 번)', () => {
    const { diagnostics } = parseTolerant(md);
    const hits = diagnostics.filter((d) => d.code === 'content-on-holiday');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'warning', line: 10 });
    expect(hits[0].message).toContain('2026-11-08');
    expect(hits[0].hint).toContain('@HOLIDAY');
  });

  it('[C-1] 그런 .md는 비주얼 모드 진입을 막는다 — 저장(serialize)이 그 줄들을 지우기 때문', () => {
    expect(serialize(parseTolerant(md).report)).not.toContain('긴급 대응'); // 저장은 휴일 날의 블록을 쓰지 않는다
    expect(lossyLines(md)).toEqual([10]);
  });

  it('[C-1] 내용을 쓴 뒤 @HOLIDAY를 붙여도 알린다', () => {
    const late = `${HEADER}# 2026-11-08(일)\n@LOC 회사\n@SUM [MX] 긴급 대응\n-> 장애 문의\n@HOLIDAY\n`;
    expect(parseTolerant(late).diagnostics.filter((d) => d.code === 'content-on-holiday')).toHaveLength(1);
  });

  it('내용 없는 휴일(새 주간보고의 토·일)은 알리지 않는다', () => {
    const plain = `${HEADER}# 2026-11-07(토)\n@HOLIDAY\n\n# 2026-11-08(일)\n@HOLIDAY 대체공휴일\n`;
    expect(parseTolerant(plain).diagnostics.filter((d) => d.code === 'content-on-holiday')).toHaveLength(0);
    expect(lossyLines(plain)).toEqual([]);
  });
});

describe('달력에 없는 날짜', () => {
  it('[C-8] isRealIsoDate — 넘치는 날짜를 유효하다고 보지 않는다', () => {
    expect(isRealIsoDate('2026-02-28')).toBe(true);
    expect(isRealIsoDate('2028-02-29')).toBe(true); // 윤년
    expect(isRealIsoDate('2026-02-29')).toBe(false);
    expect(isRealIsoDate('2026-02-30')).toBe(false);
    expect(isRealIsoDate('2026-04-31')).toBe(false);
    expect(isRealIsoDate('2026-13-01')).toBe(false);
    expect(isRealIsoDate('2026-4-1')).toBe(false);
  });

  it('[C-8] `# 2026-04-31` 일자 행은 유효하지 않은 날짜로 알리고, 검증은 오류로 막는다', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER}# 2026-04-31(금)\n@LOC 회사\n@CUS 사내\n@SUM [사내] 작업\n- 내용\n`);
    expect(diagnostics.some((d) => d.code === 'invalid-date')).toBe(true);
    expect(validate(report).issues.some((i) => i.severity === 'error' && i.message.includes('2026-04-31'))).toBe(true);
  });

  it('[C-8] `@PLAN 2026-02-30`은 건너뛴다', () => {
    const { report, diagnostics } = parseTolerant(`${HEADER.replace('\n\n', '\n@PLAN 2026-02-30 회의\n\n')}# 2026-11-02(월)\n`);
    expect(diagnostics.some((d) => d.code === 'plan-invalid-date')).toBe(true);
    expect(report.plans ?? []).toHaveLength(0);
  });
});

describe('직렬화 ↔ 파서 왕복 — 이웃한 본문 블록', () => {
  const withContent = (content: ContentBlock[]): WeekReport => {
    const base = parseTolerant(`${HEADER}# 2026-11-02(월)\n@LOC 회사\n@CUS 사내\n@SUM [사내] 작업\n- 자리\n`).report;
    base.days[0].blocks[0].items[0].content = content;
    return base;
  };
  const contentOf = (r: WeekReport) => r.days[0].blocks[0].items[0].content;

  it('[C-4] 번호 블록 뒤의 목록 블록이 번호의 세부로 흡수되지 않는다', () => {
    const report = withContent([
      { kind: 'numbered', index: 1, title: '점검', details: ['로그 확인'] },
      { kind: 'bullets', items: ['재기동 완료'] },
    ]);
    const again = contentOf(parseTolerant(serialize(report)).report);
    expect(again.map((c) => c.kind)).toEqual(['numbered', 'bullets']);
    expect(again[0]).toMatchObject({ details: ['로그 확인'] });
    expect(again[1]).toMatchObject({ items: ['재기동 완료'] });
  });

  it('[C-4] 이웃한 목록 블록 둘, 같은 들여쓰기의 대화 블록 둘이 하나로 합쳐지지 않는다', () => {
    const bullets = contentOf(parseTolerant(serialize(withContent([{ kind: 'bullets', items: ['가'] }, { kind: 'bullets', items: ['나'] }]))).report);
    expect(bullets).toHaveLength(2);
    const dialogs = contentOf(
      parseTolerant(
        serialize(
          withContent([
            { kind: 'dialog', turns: [{ kind: 'in', text: '문의' }] },
            { kind: 'dialog', turns: [{ kind: 'out', text: '회신' }] },
          ]),
        ),
      ).report,
    );
    expect(dialogs).toHaveLength(2);
  });

  it('흡수되지 않는 조합에는 빈 줄을 넣지 않는다 (기존 .md 모양 유지)', () => {
    const md = serialize(
      withContent([
        { kind: 'bullets', items: ['가'] },
        { kind: 'numbered', index: 1, title: '점검', details: [] },
        { kind: 'dialog', turns: [{ kind: 'in', text: '문의' }] },
      ]),
    );
    expect(md).toContain('- 가\n1) 점검\n-> 문의');
  });
});

describe('보낸 메일 다시 가져오기', () => {
  it('[C-3] 같은 지원장소 아래 둘째 고객사 행이 장소를 잃지 않는다', () => {
    const src = parseTolerant(
      `${HEADER}# 2026-11-02(월)\n@LOC 한강 4F\n@CUS 운영팀\n@SUM [AB Z+] 점검\n- 완료\n\n@CUS 개발팀\n@SUM [AB Z+] 문의\n- 회신\n`,
    ).report;
    expect(src.days[0].blocks[1].inheritLocation).toBe(true);
    const { report } = importFromHtml(renderHtml(src), '김테스트');
    const second = report.days[0].blocks[1];
    expect(second.locations).toEqual(['한강 4F']);
    expect(second.inheritLocation).toBe(true);
    expect(second.customer).toBe('개발팀');
    // 다시 저장해도 빈 @LOC가 생기지 않는다
    expect(serialize(report)).not.toMatch(/^@LOC$/m);
    expect(validate(report).issues.filter((i) => i.message.includes('지원장소'))).toEqual([]);
  });
});

describe('작업일지 → 주간보고', () => {
  const file = (date: string, folder: string, text: string): WorklogFileText => ({ folder, name: `[${date}] 제목.txt`, date, title: '제목', size: text.length, mtimeMs: 0, text });
  const learn = learnFromReports([]);
  const maps: FolderMap[] = [
    { folder: '고객', client: 'AB Z+', cus: '한강 SRE', loc: '한강 4F' },
    { folder: '사내', client: '사내', cus: '사내 (예시IT)', loc: '본사' },
  ];

  it('[C-6] 같은 날 폴더마다 지원장소가 다르면 @LOC를 따로 쓴다 (사내 작업이 고객사 장소로 나가지 않게)', () => {
    const { md } = buildWeeklyMd({
      prevStart: '2026-11-02',
      author: '김테스트',
      files: [file('2026-11-03', '고객', '[2026-11-03] 제목\n\n■ 설정 문의\n▶ 안내\n- 완료'), file('2026-11-03', '사내', '[2026-11-03] 제목\n\n■ 자료 작성\n▶ 초안\n- 12쪽')],
      maps,
      learn,
    });
    expect(md).toContain('@LOC 한강 4F\n@CUS 한강 SRE');
    expect(md).toContain('@LOC 본사\n@CUS 사내 (예시IT)');
    const day = parseTolerant(md).report.days.find((d) => d.date === '2026-11-03')!;
    expect(day.blocks.map((b) => [b.locations.join('/'), !!b.inheritLocation])).toEqual([
      ['한강 4F', false],
      ['본사', false],
    ]);
  });

  it('지원장소가 같으면 전처럼 @LOC 한 번, 다음 묶음은 @CUS로 이어받는다', () => {
    const same: FolderMap[] = [maps[0], { ...maps[1], loc: '한강 4F' }];
    const { md } = buildWeeklyMd({
      prevStart: '2026-11-02',
      author: '김테스트',
      files: [file('2026-11-03', '고객', '[2026-11-03] 제목\n\n■ 설정 문의\n▶ 안내\n- 완료'), file('2026-11-03', '사내', '[2026-11-03] 제목\n\n■ 자료 작성\n▶ 초안\n- 12쪽')],
      maps: same,
      learn,
    });
    expect(md.match(/^@LOC /gm)).toHaveLength(1);
    expect(parseTolerant(md).report.days.find((d) => d.date === '2026-11-03')!.blocks[1].inheritLocation).toBe(true);
  });
});

describe('이메일 템플릿 파일 검증', () => {
  const base = {
    id: 'team-x',
    name: '팀 서식',
    subjectPattern: '[{company}] {topic}',
    hasBody: true,
    sections: [{ title: '기본', fields: [{ key: 'topic', label: '주제', type: 'text' }] }],
  };
  const withField = (extra: Record<string, unknown>) => ({ ...base, sections: [{ title: '기본', fields: [{ ...base.sections[0].fields[0], ...extra }] }] });

  it('[C-2] 해석 단계가 글자·배열로 믿는 칸의 형식이 다르면 파일을 걸러 낸다 (앱이 흰 화면이 되지 않게)', () => {
    expect(validateTemplateData(base).ok).toBe(true);
    expect(validateTemplateData({ ...base, greeting: 7 }).ok).toBe(false);
    expect(validateTemplateData({ ...base, note: 1 }).ok).toBe(false);
    expect(validateTemplateData({ ...base, renderStyle: 'grid' }).ok).toBe(false);
    expect(validateTemplateData({ ...base, tableHeader: ['구분'] }).ok).toBe(false);
    expect(validateTemplateData(withField({ default: 7 })).ok).toBe(false);
    expect(validateTemplateData(withField({ placeholder: {} })).ok).toBe(false);
    expect(validateTemplateData(withField({ type: 'select', options: 'A,B' })).ok).toBe(false);
  });

  it('생략·null·올바른 값은 그대로 통과한다', () => {
    expect(validateTemplateData({ ...base, greeting: null, note: '안내', renderStyle: 'bullets', tableHeader: ['구분', '상세내용'] }).ok).toBe(true);
    expect(validateTemplateData(withField({ default: 'today', placeholder: '예: BMS', type: 'select', options: ['A', 'B'] })).ok).toBe(true);
  });
});
