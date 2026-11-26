// @vitest-environment jsdom
/**
 * 주간보고 형식 v2 (주간보고 형식 명세) 회귀 고정 — 팀 기준 보고서(기준 보고서) 형식의
 * 대화 이력·들여쓰기·미결/결론·항목 머리·일정 예정·합본·검증 규칙. 인명은 가명.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCombinedSubject,
  buildSubject,
  canonicalClient,
  formatDotDate,
  formatItemHeader,
  importFromHtml,
  importFromPlain,
  indentLevel,
  parseItemHeader,
  parseTolerant,
  renderCombined,
  renderHtml,
  renderPlain,
  serialize,
  validate,
  type WeekReport,
} from '../src/core/index';
import {
  addTurn,
  continueItem,
  fillMissingDays,
  missingDates,
  removeTurn,
  setContentIndent,
  toggleLeave,
  updateTurn,
} from '../src/core/edit';
import { DIRECTIVES } from '../src/codemirror/completion';
import { lossyLines } from '../src/doctypes/weekly';

const HEAD = '@PREV 2026-09-21 ~ 2026-09-27\n@CURRENT 2026-09-28 ~ 2026-10-04\n@AUTHOR 홍길동\n\n';

/** 기준 보고서 형태의 줄 (가명) */
const REF_STYLE = `${HEAD}# 2026-09-21(월)
@LOC 외부
@CUS 제조사문의
@SUM [제조사문의] (담당A/메일) 네트워크 포트 감시 화면 검토 요청
  <- 리마인드
  -> (담당B/메일) 다음 정기 릴리스 때 반영 예정
@SUM [제조사문의] (담당C/유선) 저장 장치 장애 대응 방안
  -> 장치 한 대 장애 시 동작 확인 요청.
  <- 아래와 같이 안내.
  1) 현재 구조에서는 새 저장소를 만든 뒤 백업 복구
  2) 저장 노드 추가 시 이중화 가능
  *==> 디스크 장애 대응 절차 문서화 필요
@SUM [제조사문의] (담당D/슬랙) 로그 조회 방법 안내
  *<- 제조사 문의 필요.

# 2026-09-22(화)
@LOC MX(누리사옥)
@CUS MX
@SUM [MX] (누리사옥) (담당E) 수집 서버 점검으로 방문
1) 상황 :
  > 야간 배치 이후 수집 불가
2) 조치 :
  > 수집 프로세스 재시작

@LOC 파트너사
@CUS 미팅
@SUM [미팅] 내부미팅
  1) 상태 확인 관련 논의
   <- 지연이 계속됨. 설정 확인 요청.
`;

/** 렌더 HTML의 내용 칸 줄 → "들여쓰기 칸 수 + 텍스트" (16px = 2칸) */
function contentLines(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<div(?: style="([^"]*)")?>(.*?)<\/div>/g)) {
    const ml = /margin-left:(\d+)px/.exec(m[1] ?? '');
    const text = m[2].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    if (text) out.push(`${' '.repeat(ml ? Math.floor(Number(ml[1]) / 8) : 0)}${text}`);
  }
  return out;
}

describe('기준 보고서 형식 줄 — 파싱·렌더 보존', () => {
  it('인식 불가 줄 없이 파싱되고 미결·결론·채널 슬랙을 규격대로 해석한다', () => {
    const { report, diagnostics } = parseTolerant(REF_STYLE);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const items = report.days[0].blocks[0].items;
    expect(items[2].channel).toBe('슬랙');
    const dialog = items[2].content[0];
    expect(dialog).toEqual({ kind: 'dialog', indent: 1, turns: [{ kind: 'out', text: '제조사 문의 필요.', pending: true }] });
    expect(validate(report).stats.pending).toBe(1);
  });

  it('렌더: 들여쓰기 계층과 마커를 원문 그대로 — `- *<-` 같은 변질 없음', () => {
    const html = renderHtml(parseTolerant(REF_STYLE).report);
    const lines = contentLines(html);
    expect(lines).toContain('  <- 리마인드');
    expect(lines).toContain('  -> (담당B/메일) 다음 정기 릴리스 때 반영 예정');
    expect(lines).toContain('  1) 현재 구조에서는 새 저장소를 만든 뒤 백업 복구');
    expect(lines).toContain('  *==> 디스크 장애 대응 절차 문서화 필요');
    expect(lines).toContain('  *<- 제조사 문의 필요.');
    expect(lines).toContain('    <- 지연이 계속됨. 설정 확인 요청.'); // 3칸 → 2단계
    expect(html).not.toMatch(/- \*(?:&lt;-|==&gt;)/);
    expect(html).toMatch(/color:#B45309;">\*&lt;- 제조사 문의 필요/); // 미결 호박색
    expect(html).toMatch(/font-weight:700;">\*==&gt; 디스크/); // 결론 굵게
  });

  it('직렬화 고정점 + HTML 왕복에서 본문·들여쓰기가 그대로다', () => {
    const r = parseTolerant(REF_STYLE).report;
    const md = serialize(r);
    expect(serialize(parseTolerant(md).report)).toBe(md);
    const back = importFromHtml(renderHtml(r), '홍길동').report;
    const body = (x: WeekReport) =>
      x.days.map((d) => d.blocks.flatMap((b) => b.items.map((i) => [i.client, i.site, i.contact, i.channel, i.workType, i.content])));
    expect(body(back)).toEqual(body(r));
  });

  it('비주얼 모드 유실 가드 대상 없음 (모든 줄이 AST에 담긴다)', () => {
    expect(lossyLines(REF_STYLE)).toEqual([]);
  });
});

describe('항목 머리 [고객사] (괄호) 제목', () => {
  it('(건물) (담당자) — 현장 방문', () => {
    const { header } = parseItemHeader('[MX] (누리사옥) (담당E) 수집 서버 점검');
    expect(header).toEqual({ client: 'MX', site: '누리사옥', contact: '담당E', workType: '수집 서버 점검' });
  });

  it('괄호 하나가 지원장소의 건물명과 같으면 건물, 아니면 담당자', () => {
    expect(parseItemHeader('[MX] (누리사옥) 주간미팅', ['MX(누리사옥)']).header).toEqual({
      client: 'MX',
      site: '누리사옥',
      workType: '주간미팅',
    });
    expect(parseItemHeader('[제트플러스] (정보보안운영팀) NMS 구축', ['파트너사']).header).toEqual({
      client: '제트플러스',
      contact: '정보보안운영팀',
      workType: 'NMS 구축',
    });
  });

  it('(담당자/채널) — 표준 채널만 나누고, 아니면 원문 보존 + 경고', () => {
    expect(parseItemHeader('[MX] (담당C/문자) 요청').header).toMatchObject({ contact: '담당C', channel: '문자' });
    const odd = parseItemHeader('[미팅] (제트플러스/MX관련 내부미팅)');
    expect(odd.header).toEqual({ client: '미팅', contact: '제트플러스/MX관련 내부미팅', workType: '' });
    expect(odd.issues.map((i) => i.code)).toEqual(['unknown-channel']);
  });

  it('formatItemHeader는 parseItemHeader의 역함수다', () => {
    for (const h of [
      '[MX] (누리사옥) (담당E) 작업',
      '[MX] (담당C/유선) 문의',
      '[가나스토어] 정기점검',
      '[MX] (누리사옥/담당X) 비표준',
    ]) {
      expect(formatItemHeader(parseItemHeader(h).header)).toBe(h);
    }
  });
});

describe('대화 이력 규칙', () => {
  it('같은 들여쓰기의 연속 턴은 한 블록, 더 깊은 들여쓰기는 새 블록', () => {
    const md = `${HEAD}# 2026-09-21(월)\n@LOC 파트너사\n@CUS MX\n@SUM [MX] (담당A/메일) 문의\n  -> A\n  <- B\n    1) C\n      <- D\n  -> E\n`;
    const c = parseTolerant(md).report.days[0].blocks[0].items[0].content;
    expect(c).toEqual([
      { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: 'A' }, { kind: 'out', text: 'B' }] },
      { kind: 'numbered', indent: 2, index: 1, title: 'C', details: [] },
      { kind: 'dialog', indent: 3, turns: [{ kind: 'out', text: 'D' }] },
      { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: 'E' }] },
    ]);
  });

  it('마커 없는 줄은 직전 턴의 이어지는 줄 (여러 줄 턴) — 렌더는 <br/>, 직렬화 왕복 보존', () => {
    const md = `${HEAD}# 2026-09-21(월)\n@LOC 파트너사\n@CUS MX\n@SUM [MX] 문의\n  <- 첫 줄\n  이어지는 줄\n`;
    const r = parseTolerant(md).report;
    const turn = (r.days[0].blocks[0].items[0].content[0] as { turns: Array<{ text: string }> }).turns[0];
    expect(turn.text).toBe('첫 줄\n이어지는 줄');
    expect(renderHtml(r)).toContain('&lt;- 첫 줄<br/>이어지는 줄');
    expect(parseTolerant(serialize(r)).report.days[0].blocks[0].items[0].content).toEqual(r.days[0].blocks[0].items[0].content);
  });

  it('indentLevel: 2칸 = 1단계, 홀수는 올림, 탭·전각 공백은 2칸', () => {
    expect([indentLevel('x'), indentLevel('  x'), indentLevel('   x'), indentLevel('\tx'), indentLevel('　x')]).toEqual([0, 1, 2, 1, 1]);
  });
});

describe('출력 규격 — 제목·머리말·일정 예정', () => {
  it('제목은 작성자 없이 `[YYYY. MM. DD ~ YYYY. MM. DD] 주간보고`', () => {
    expect(formatDotDate('2026-09-07')).toBe('2026. 09. 07');
    expect(buildSubject({ start: '2026-09-21', end: '2026-09-27' })).toBe('[2026. 09. 21 ~ 2026. 09. 27] 주간보고');
    expect(
      buildCombinedSubject([
        { start: '2026-09-21', end: '2026-09-27' },
        { start: '2026-09-14', end: '2026-09-20' },
      ]),
    ).toBe('[2026. 09. 14 ~ 2026. 09. 27] 주간보고');
  });

  it('@PLAN → □ 일정 예정 표 (날짜별 묶음), 없으면 생략', () => {
    const md = `${HEAD.replace('\n\n', '\n@PLAN 2026-09-29 10:00 MX(주간미팅)\n@PLAN 2026-09-29 14:00 제트플러스(원격)\n@PLAN 2026-10-02 휴가\n\n')}# 2026-09-21(월)\n`;
    const r = parseTolerant(md).report;
    expect(r.plans).toHaveLength(3);
    const html = renderHtml(r);
    expect(html).toContain('□ 일정 예정 (2026. 09. 28 ~ 2026. 10. 04)');
    expect(html).toContain('2026-09-29(화)</td><td');
    expect(html).toContain('10:00 MX(주간미팅)<br/>14:00 제트플러스(원격)');
    expect(renderPlain(r)).toContain('2026-10-02(금)\t휴가');
    expect(renderHtml({ ...r, plans: undefined })).not.toContain('일정 예정');
    expect(serialize(r)).toContain('@PLAN 2026-10-02 휴가');
  });

  it('빈 칸은 전각 공백, 열 머리는 고객사|작업구분', () => {
    const html = renderHtml(parseTolerant(`${HEAD}# 2026-09-26(토)\n`).report);
    expect(html).toContain('고객사|작업구분');
    expect(html).toMatch(/2026-09-26\(토\)<\/td><td[^>]*>　<\/td><td[^>]*>　<\/td><td[^>]*>　<\/td><td[^>]*>　<\/td>/);
  });
});

describe('합본 (다주)', () => {
  const week = (start: string, end: string, plan = false) =>
    parseTolerant(
      `@PREV ${start} ~ ${end}\n${plan ? '@PLAN 2026-09-29 10:00 MX(주간미팅)\n' : ''}\n# ${start}(월)\n@LOC 파트너사\n@CUS MX\n@SUM [MX] 주 ${start}\n`,
    ).report;

  it('최근 주가 위, 일정 예정은 최근 주에만, 같은 주는 한 번, 제목은 전체 범위', () => {
    const older = week('2026-09-14', '2026-09-20', true);
    const latest = week('2026-09-21', '2026-09-27', true);
    const out = renderCombined([older, latest, latest]);
    expect(out.weeks).toBe(2);
    expect(out.subject).toBe('[2026. 09. 14 ~ 2026. 09. 27] 주간보고');
    expect(out.html.indexOf('2026. 09. 21 ~ 2026. 09. 27')).toBeLessThan(out.html.indexOf('2026. 09. 14 ~ 2026. 09. 20'));
    expect(out.html.match(/일정 예정/g)).toHaveLength(1);
  });

  it('합본 HTML을 가져오면 최근 주(첫 섹션)만 복원한다', () => {
    const out = renderCombined([week('2026-09-14', '2026-09-20'), week('2026-09-21', '2026-09-27')]);
    const r = importFromHtml(out.html, '홍길동').report;
    expect(r.prevWeekRange).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(r.days.map((d) => d.date)).toEqual(['2026-09-21']);
  });
});

describe('검증 규칙 v2', () => {
  const issues = (md: string) => validate(parseTolerant(md).report).issues;

  it('보고 주 범위 밖 일자 → 경고 (기준 보고서 예시)', () => {
    expect(issues(`${HEAD}# 2026-09-28(월)\n@LOC 파트너사\n@CUS MX\n@SUM [MX] 작업\n- x\n`).some((i) => i.message.includes('범위 밖'))).toBe(true);
  });

  it('빠진 일자 → info 1건, 토·일 빈 행·휴가 행은 경고 없음', () => {
    const md = `${HEAD}# 2026-09-21(월)\n@LOC 휴가\n\n# 2026-09-26(토)\n\n# 2026-09-27(일)\n`;
    const list = issues(md);
    expect(list.filter((i) => i.severity === 'warning')).toEqual([]);
    const info = list.filter((i) => i.message.includes('빠진 일자'));
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain('09-22(화)');
  });

  it('행 고객사|작업구분 ≠ 항목 [고객사] → 행당 1건 (오타·다른 고객)', () => {
    const md = `${HEAD}# 2026-09-21(월)\n@LOC 외부\n@CUS 제조사분의\n@SUM [제조사문의] (제조사지원/메일) A\n- x\n@SUM [제조사문의] (제조사지원/메일) B\n- y\n`;
    const w = issues(md).filter((i) => i.message.includes('다릅니다'));
    expect(w).toHaveLength(1);
    expect(issues(md.replace('제조사분의', '제조사문의')).some((i) => i.message.includes('다릅니다'))).toBe(false);
    expect(issues(md.replace('@CUS 제조사분의', '@CUS 다솜라이프').replace(/제조사문의\] \(제조사지원\/메일\)/g, '다솜/라이프]')).some((i) => i.message.includes('다릅니다'))).toBe(false);
  });

  it('고객사|작업구분에 팀·부서명을 쓰면 항목 [고객사]와 비교하지 않는다 (보고서 예시의 오경고)', () => {
    const md =
      `${HEAD}# 2026-09-21(월)\n@LOC 한강 제트플러스 4F\n@CUS 한강 SRE\n@SUM [AB Z+] 패치\n- x\n\n` +
      `@CUS 한강 관제 개발팀 / (네트워크 부문)\n@SUM [ABZ+] (담당A/메신저) 문의\n<- y\n\n` +
      `# 2026-09-22(화)\n@LOC 한강 제트플러스 4F\n@CUS IT 인프라\n@SUM [AB Z+] 점검\n- z\n\n` +
      `@CUS 사내 (예시IT)\n@SUM [사내] 자료 공유\n- w\n\n` +
      `@CUS AB Z+ 북악\n@SUM [AB Z+] 회의 참석\n- v\n`;
    expect(issues(md).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('고객사 이름을 쓴 칸은 비교한다 — 다른 고객사면 경고, 같은 고객사의 다른 표기는 같다', () => {
    const md = (cus: string, client: string) =>
      `${HEAD}# 2026-09-21(월)\n@LOC 외부\n@CUS ${cus}\n@SUM [${client}] 문의\n- x\n\n# 2026-09-22(화)\n@LOC 외부\n@CUS MX\n@SUM [MX] 점검\n- y\n`;
    const warned = (cus: string, client: string) => issues(md(cus, client)).some((i) => i.message.includes('다릅니다'));
    expect(warned('MX', 'AB Z+')).toBe(true); // MX는 이 보고서에서 고객사로 쓰였다
    expect(warned('AB Z+', 'ABZ+')).toBe(false);
    expect(warned('제트플러스', 'AB Z+')).toBe(false);
    expect(warned('AB제트플러스', 'AB Z+')).toBe(false);
    expect(warned('한강 SRE', 'AB Z+')).toBe(false);
  });

  it('고객사 표준 표기 — ABZ+·제트플러스·AB제트플러스는 AB Z+, 팀명·다른 고객사는 그대로', () => {
    expect(['ABZ+', 'abz+', 'AB Z+', '제트플러스', 'AB제트플러스', ' AB  Z+ '].map(canonicalClient)).toEqual(Array(6).fill('AB Z+'));
    expect(['AB Z+ 북악', '한강 SRE', 'MX', '사내'].map(canonicalClient)).toEqual(['AB Z+ 북악', '한강 SRE', 'MX', '사내']);
  });

  it('(담당자/메신저)·(담당자/현장)은 표준 채널 — 작업일지 탭의 채널 어휘와 같다', () => {
    for (const ch of ['메신저', '현장']) {
      const { header, issues: hi } = parseItemHeader(`[AB Z+] (담당A/${ch}) 문의`);
      expect(header).toMatchObject({ contact: '담당A', channel: ch });
      expect(hi).toEqual([]);
    }
  });

  it('@PLAN 일자가 다음 주 범위 밖이면 경고', () => {
    const md = `${HEAD.replace('\n\n', '\n@PLAN 2026-10-10 휴가\n\n')}# 2026-09-21(월)\n@LOC 휴가\n`;
    expect(issues(md).some((i) => i.message.includes('일정 예정 범위'))).toBe(true);
  });
});

describe('임포터 — 외부 메일 형식', () => {
  it('Outlook식 NBSP 들여쓰기 셀에서 대화 이력·들여쓰기를 복원한다', () => {
    const html =
      '<p>■ 주간 보고</p><p>□ Date : 2026. 09. 21 ~ 2026. 09. 27</p>' +
      '<table><tr><td>일자</td><td>지원장소</td><td>고객사|작업구분</td><td>내용</td><td>기타</td></tr>' +
      '<tr><td>2026-09-21(월)</td><td>외부</td><td>MX</td>' +
      '<td>[MX] (담당B/유선) ZFS 대응방안<br>&nbsp;&nbsp;-&gt; 확인요청<br>&nbsp;&nbsp;&lt;- 안내<br>&nbsp;&nbsp;*==&gt; 절차 정리 필요</td><td>&nbsp;</td></tr></table>';
    const { report, warnings } = importFromHtml(html, '홍길동');
    expect(warnings).toEqual([]);
    expect(report.prevWeekRange).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(report.days[0].blocks[0].items[0].content).toEqual([
      {
        kind: 'dialog',
        indent: 1,
        turns: [
          { kind: 'in', text: '확인요청' },
          { kind: 'out', text: '안내' },
          { kind: 'conclusion', text: '절차 정리 필요' },
        ],
      },
    ]);
  });

  it('plain(탭 구분) 본문의 들여쓴 대화 이력과 □ 일정 예정을 복원한다', () => {
    const r = parseTolerant(`${HEAD.replace('\n\n', '\n@PLAN 2026-09-29 10:00 MX(주간미팅)\n\n')}${REF_STYLE.slice(HEAD.length)}`).report;
    const back = importFromPlain(renderPlain(r), '홍길동').report;
    expect(back.plans).toEqual([{ date: '2026-09-29', text: '10:00 MX(주간미팅)' }]);
    expect(back.currentWeekRange).toEqual(r.currentWeekRange);
    expect(back.days[0].blocks[0].items[1].content).toEqual(r.days[0].blocks[0].items[1].content);
  });
});

describe('비주얼 편집 리듀서 — 히스토리', () => {
  const base = () => parseTolerant(REF_STYLE).report;

  it('continueItem: 같은 행이 없으면 대상 일자에 새 행 + 머리 복사 + 빈 대화 이력', () => {
    const { report, at } = continueItem(base(), 0, 0, 1, '2026-09-24');
    expect(at).toEqual({ di: 2, bi: 0, ii: 0 });
    const day = report.days[2];
    expect(day.date).toBe('2026-09-24');
    expect(day.blocks[0]).toMatchObject({ locations: ['외부'], customer: '제조사문의' });
    expect(day.blocks[0].items[0]).toEqual({
      client: '제조사문의',
      contact: '담당C',
      channel: '유선',
      workType: '저장 장치 장애 대응 방안',
      // 빈 대화 이력 — 상대 발화·내 대응 한 쌍 (Enter로 다음 빈 턴에 이어 쓴다)
      content: [{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }, { kind: 'out', text: '' }] }],
    });
  });

  it('continueItem: 같은 지원장소·고객사 행이 있으면 그 행 끝에 추가', () => {
    const { report, at } = continueItem(base(), 0, 0, 0, '2026-09-21');
    expect(at).toEqual({ di: 0, bi: 0, ii: 3 });
    expect(report.days[0].blocks[0].items).toHaveLength(4);
  });

  it('턴 추가·수정·삭제 — 미결은 결론으로 바뀌면 해제', () => {
    let r = addTurn(base(), 0, 0, 2, 0, { kind: 'in', text: '회신' }, 0);
    let turns = (r.days[0].blocks[0].items[2].content[0] as { turns: unknown[] }).turns;
    expect(turns[0]).toEqual({ kind: 'in', text: '회신' });
    r = updateTurn(r, 0, 0, 2, 0, 1, { kind: 'conclusion' });
    turns = (r.days[0].blocks[0].items[2].content[0] as { turns: unknown[] }).turns;
    expect(turns[1]).toEqual({ kind: 'conclusion', text: '제조사 문의 필요.' });
    r = removeTurn(r, 0, 0, 2, 0, 0);
    expect((r.days[0].blocks[0].items[2].content[0] as { turns: unknown[] }).turns).toHaveLength(1);
  });

  it('setContentIndent는 0이면 indent 필드를 제거한다', () => {
    const r = setContentIndent(base(), 0, 0, 0, 0, 0);
    expect('indent' in r.days[0].blocks[0].items[0].content[0]).toBe(false);
    expect(setContentIndent(r, 0, 0, 0, 0, 2).days[0].blocks[0].items[0].content[0].indent).toBe(2);
  });

  it('toggleLeave on/off, fillMissingDays', () => {
    let r = toggleLeave(base(), 1);
    expect(r.days[1].blocks[0].locations).toEqual(['휴가']);
    r = toggleLeave(r, 1);
    expect(r.days[1].blocks.some((b) => b.locations[0] === '휴가')).toBe(false);

    expect(missingDates(r)).toHaveLength(5);
    expect(fillMissingDays(r).days.map((d) => d.weekday)).toEqual(['월', '화', '수', '목', '금', '토', '일']);
  });
});

describe('편집기 보조', () => {
  it('자동완성에 @PLAN이 있다', () => {
    expect(DIRECTIVES.map((d) => d.label)).toContain('@PLAN');
  });

  it('잘못된 @PLAN 날짜 줄은 비주얼 유실 가드 대상', () => {
    expect(lossyLines(`${HEAD.replace('\n\n', '\n@PLAN 2026-13-40 휴가\n\n')}# 2026-09-21(월)\n`)).toEqual([4]);
  });
});

describe('주말 = 휴일 (업무 없음 — 사용자 분류)', () => {
  it('Ctrl+T 템플릿의 토·일은 @HOLIDAY — 빨간 휴일 행, 경고 없음', async () => {
    const { buildWeeklyTemplate } = await import('../src/hooks/useTemplate');
    const { md } = buildWeeklyTemplate({ baseDate: new Date('2026-09-30T09:00:00') });
    const r = parseTolerant(md).report;
    expect(r.days.map((d) => [d.weekday, !!d.holiday])).toEqual([
      ['월', false], ['화', false], ['수', false], ['목', false], ['금', false], ['토', true], ['일', true],
    ]);
    expect(renderHtml(r).match(/background:#FFCCCC;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('빠진 일자 채우기·일자 추가(weekendHoliday)는 토·일을 휴일로, 평일은 빈 행으로', async () => {
    const { addDay } = await import('../src/core/edit');
    const r = fillMissingDays(parseTolerant(`${HEAD}# 2026-09-21(월)\n`).report);
    expect(r.days.filter((d) => d.holiday).map((d) => d.weekday)).toEqual(['토', '일']);
    const base = parseTolerant(`${HEAD}# 2026-09-21(월)\n`).report;
    expect(addDay(base, '2026-09-26', { weekendHoliday: true }).days[1].holiday).toEqual({ reason: '' });
    expect(addDay(base, '2026-09-26').days[1].holiday).toBeUndefined(); // 이어쓰기 등 내부 호출은 그대로
  });
});
