// @vitest-environment jsdom
/**
 * v0.2.0 고도화 회귀 고정 — 코드베이스 심층 분석(데이터 흐름·상태·계약)에서 검증된 결함의 재발 방지.
 * 각 it 제목의 [A-n]/[B-n]/[C-n]은 분석 리포트의 발견 번호.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GRAMMAR,
  highlightClassFor,
  importFromHtml,
  importFromPlain,
  parseTolerant,
  renderHtml,
  renderPlain,
  serialize,
  splitLocations,
  type WeekReport,
} from '../src/core/index';
import { buildWeeklyTemplate } from '../src/hooks/useTemplate';
import { DIRECTIVES } from '../src/codemirror/completion';
import { encodeSubjectRfc2047 } from '../electron/gmail/mime';
import { lossyLines } from '../src/doctypes/weekly';
import { coerceDocState, normalizeFieldValues } from '../src/email/useEmailDoc';
import { safeSetItem } from '../src/lib/storage';
import { buildEmailSubject } from '../src/email/render';
import { getTemplate } from '../src/email/templates';

const HEADER = '@PREV 2026-05-11 ~ 2026-05-17\n@CURRENT 2026-05-18 ~ 2026-05-24\n@AUTHOR 김테스트\n\n';

describe('직렬화 ↔ 파서 왕복 정합성', () => {
  it('[A-3] 빈 세부항목은 `- `로 내보내지 않고, `-` 단독 라인은 빈 항목으로 파싱된다', () => {
    const md = `${HEADER}# 2026-05-11(월)\n@LOC 한강\n@CUS SRE\n@SUM [ABZ+] 작업\n1) 설치\n- 완료\n-\n`;
    const { report, diagnostics } = parseTolerant(md);
    expect(diagnostics.filter((d) => d.code === 'unknown-syntax')).toHaveLength(0);
    const numbered = report.days[0].blocks[0].items[0].content[0];
    expect(numbered.kind).toBe('numbered');
    if (numbered.kind === 'numbered') expect(numbered.details).toEqual(['완료', '']); // 빈 항목 수용, 리터럴 '-' 아님

    const out = serialize(report);
    expect(out).toContain('- 완료');
    expect(out).not.toMatch(/\n-\s*\n/); // 빈 항목 생략
    const again = parseTolerant(out).report.days[0].blocks[0].items[0].content[0];
    if (again.kind === 'numbered') expect(again.details).toEqual(['완료']);
    expect(renderHtml(report)).not.toContain('- -');
  });

  it('[A-5] 빈 고객사 `@SUM []`가 workType "[]"로 오염되지 않고 빈 client로 왕복된다', () => {
    const md = `${HEADER}# 2026-05-11(월)\n@LOC 한강\n@SUM []\n- 내용\n`;
    const item = parseTolerant(md).report.days[0].blocks[0].items[0];
    expect(item.client).toBe('');
    expect(item.workType).toBe('');
    const again = parseTolerant(serialize(parseTolerant(md).report)).report.days[0].blocks[0].items[0];
    expect(again.client).toBe('');
    expect(again.workType).toBe('');
  });

  it('[C-4] 장소 없는 두 번째 블록이 직전 @LOC를 상속하지 않는다 (빈 @LOC 마커)', () => {
    const base = parseTolerant(`${HEADER}# 2026-05-11(월)\n@LOC 한강\n@CUS A\n@SUM [ABZ+] 오전\n- 점검\n`).report;
    const day = base.days[0];
    const report: WeekReport = {
      ...base,
      days: [
        {
          ...day,
          blocks: [
            day.blocks[0],
            { locations: [], customer: 'B', items: [{ client: 'ABZ+', workType: '오후', content: [] }] },
          ],
        },
      ],
    };
    const md = serialize(report);
    expect(md).toMatch(/\n@LOC\n@CUS B\n/);
    const again = parseTolerant(md).report.days[0];
    expect(again.blocks).toHaveLength(2);
    expect(again.blocks[1].locations).toEqual([]);
    expect(again.blocks[1].inheritLocation).toBeFalsy();
    // 표에서 '한강'이 두 번째 행까지 rowspan으로 번지지 않음
    expect(renderHtml(again ? { ...report, days: [again] } : report).match(/>한강</g)).toHaveLength(1);
    expect(renderHtml({ ...report, days: [again] })).not.toMatch(/rowspan="2"[^>]*>한강</);
  });

  it('[A-4] Ctrl+T 빈 템플릿은 파서 경고 없이 파싱되고 쓰레기 항목을 만들지 않는다', () => {
    const { md } = buildWeeklyTemplate({ authorName: '홍길동', baseDate: new Date('2026-05-20T09:00:00') });
    const { report, diagnostics } = parseTolerant(md);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]); // 검증기 경고(비어 있음)는 별개
    expect(report.days).toHaveLength(7); // 월~일 — 토·일은 빈 행
    expect(report.days[0].date).toBe('2026-05-11');
    expect(report.days[6].date).toBe('2026-05-17');
    expect(renderHtml(report)).not.toContain('- -');
    expect(serialize(report)).not.toContain('[]');
  });

  it('[C-9] 장소 분해는 공백 둘러싼 슬래시만 구분자 (파서·비주얼 에디터 공용 규칙)', () => {
    expect(splitLocations('한강/서원')).toEqual(['한강/서원']);
    expect(splitLocations('8080/443 포트')).toEqual(['8080/443 포트']);
    expect(splitLocations('한강 / 서원 / 남산')).toEqual(['한강', '서원', '남산']);
  });
});

describe('임포터 계약', () => {
  it('[A-2/C-3] HTML에 표가 없으면 plain 폴백 — 경고와 작성자 주입이 보존된다', () => {
    const html = '<div>■ 주간 보고<br/>□ Date : 2026. 05. 11 ~ 2026. 05. 17<br/>2026-05-11(월)<br/>한강<br/>[ABZ+] 작업</div>';
    const { report, warnings } = importFromHtml(html, '김테스트');
    expect(warnings.some((w) => w.includes('plain text 경로로 폴백'))).toBe(true);
    expect(report.authorName).toBe('김테스트');
  });

  it('[C-2] renderPlain의 탭 구분 행을 importFromPlain이 컬럼으로 복원한다 (반차 라벨 오염 없음)', () => {
    const md = `${HEADER}# 2026-05-11(월)\n@LOC 한강\n@CUS 한강 SRE\n@SUM [ABZ+] (홍길동/메일) 설치\n1) 에이전트\n- 가이드\n\n# 2026-05-12(화)\n@HALFDAY 오후 반차\n@LOC 서원\n@CUS 서원 SRE\n@SUM [ABZ+] 점검\n- 내용\n`;
    const plain = renderPlain(parseTolerant(md).report);
    const { report } = importFromPlain(plain, '김테스트');
    expect(report.days).toHaveLength(2);
    const d0 = report.days[0];
    expect(d0.partial).toBeUndefined();
    expect(d0.blocks[0].locations).toEqual(['한강']);
    expect(d0.blocks[0].customer).toBe('한강 SRE');
    expect(d0.blocks[0].items[0]).toMatchObject({ client: 'ABZ+', contact: '홍길동', channel: '메일', workType: '설치' });
    expect(d0.blocks[0].items[0].content[0]).toEqual({ kind: 'numbered', index: 1, title: '에이전트', details: ['가이드'] });
    const d1 = report.days[1];
    expect(d1.partial).toEqual({ label: '오후 반차' });
    expect(d1.blocks[0].locations).toEqual(['서원']);
    expect(d1.blocks[0].items[0].client).toBe('ABZ+');
  });
});

describe('문법 단일 소스 동형성', () => {
  it.each([
    ['dash', '-', 'tok-dash'],
    ['loc', '@LOC', 'tok-loc'],
    ['cus', '@CUS', 'tok-loc'],
    ['client', '@SUM', 'tok-client'],
    ['num', '1)NMS 설치', 'tok-num'],
    ['turnOut', '<-안내', 'tok-out'],
    ['turnIn', '->문의', 'tok-in'],
    ['note', '>노트', 'tok-note'],
  ] as const)('[C-10] GRAMMAR.%s가 수용하는 "%s"는 하이라이트도 %s', (key, sample, cls) => {
    expect(GRAMMAR[key].test(sample)).toBe(true);
    expect(highlightClassFor(sample)).toBe(cls);
  });

  it('[C-11] 자동완성 디렉티브 목록이 현행 @토큰 전부를 포함한다 (@AUTHOR·@WEEK·@NEXT는 인식만 하고 제안하지 않음)', () => {
    const labels = new Set(DIRECTIVES.map((d) => d.label));
    expect(labels.has('@AUTHOR')).toBe(false);
    for (const tok of ['@PREV', '@CURRENT', '@PLAN', '@LOC', '@CUS', '@SUM', '@HOLIDAY', '@HALFDAY']) {
      expect(labels.has(tok), tok).toBe(true);
    }
  });
});

describe('비주얼 모드 유실 가드', () => {
  it('[B-2] 파서가 건너뛰는 줄이 있으면 라인 번호를 돌려주고, 정상 md는 빈 배열', () => {
    expect(lossyLines(`${HEADER}# 2026-05-11(월)\n@LOC 한강\n@SUM [ABZ+] 작업\n- 내용\n`)).toEqual([]);
    const lossy = `${HEADER}# 2026-05-11(월)\n손으로 쓴 메모 줄\n@LOC 한강\n`;
    expect(lossyLines(lossy)).toEqual([6]);
    expect(lossyLines('')).toEqual([]);
  });
});

describe('이메일 문서 상태 정규화', () => {
  it('[B-1/C-1] 오버레이 템플릿 id(아직 미로드)와 수동 제목을 그대로 보존한다', () => {
    const doc = coerceDocState({
      templateId: 'team-only',
      fieldValues: { a: '1', n: 2, bad: { x: 1 }, arr: ['x'] },
      bodyHtml: '<p>x</p>',
      subject: '수동 제목',
    });
    expect(doc).toEqual({
      templateId: 'team-only',
      fieldValues: { a: '1', n: '2' },
      bodyHtml: '<p>x</p>',
      subject: '수동 제목',
    });
  });

  it('[A-6/C-7] 빈 subject는 자동 모드(undefined), templateId 없으면 null', () => {
    expect(coerceDocState({ templateId: 'tech-inquiry', subject: '   ' })?.subject).toBeUndefined();
    expect(coerceDocState({ fieldValues: {} })).toBeNull();
    expect(coerceDocState('nope')).toBeNull();
    expect(normalizeFieldValues(null)).toEqual({});
  });

  it('[C-13] 제목 토큰도 field.default를 폴백한다 (표·검증과 동일 계약)', () => {
    const t = getTemplate('tech-inquiry', { name: '김테스트', email: 't@example.com', company: '예시IT' })!;
    expect(buildEmailSubject({ ...t, subjectPattern: '{serverSpec} 문의' }, {})).toBe('- 문의'); // serverSpec default '-'
    expect(buildEmailSubject({ ...t, subjectPattern: '{requestDate} 문의' }, {})).toBe('문의'); // 'today' 토큰 누출 없음
  });
});

describe('저장소·MIME 방어', () => {
  it('[A-8] safeSetItem은 quota 예외를 삼키고 false를 돌려준다', () => {
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    vi.stubGlobal('localStorage', { setItem, getItem: () => null, removeItem: () => undefined });
    expect(() => safeSetItem('k', 'v')).not.toThrow();
    expect(safeSetItem('k', 'v')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('[C-14] 긴 한글 제목은 75자 이하 encoded-word로 분할·접기(folding)되고 무손실 복원된다', () => {
    const subject = '[제트플러스] 알림 이름이 같을 때 규칙 활성화/비활성화 개선 요청';
    const encoded = encodeSubjectRfc2047(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const decoded = words
      .map((w) => Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
    expect(encodeSubjectRfc2047('ASCII only')).toBe('ASCII only');
  });
});
