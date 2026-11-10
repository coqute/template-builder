/**
 * 작성 흐름 개선 회귀 (v0.4.0) — 골격·저장 정합성·마커 입력·자동 채움·이어쓰기·지난주 미결
 */
import { describe, expect, it } from 'vitest';
import {
  collectOpenItems,
  escapeContinuation,
  isBlankItem,
  parse,
  parseTolerant,
  pickPreviousReport,
  pruneBlank,
  render,
  serialize,
  splitTypedTurn,
  unescapeContinuation,
  validate,
  type DialogBlock,
  type WeekReport,
} from '../src/core/index';
import {
  addItem,
  addLocationBlock,
  continueItem,
  fillItemClientsFromRow,
  fillItemSitesFromRow,
  fillRowCustomerFromItem,
  replaceTurn,
  updateBlockFields,
  updateItemFields,
  updateTurn,
} from '../src/core/edit';
import { buildWeeklyTemplate } from '../src/hooks/useTemplate';
import { lineOfKey, locateLine } from '../src/lib/locate';

const tpl = () => buildWeeklyTemplate({ authorName: '홍길동', baseDate: new Date('2026-09-29T09:00:00') });

describe('새 주간보고 골격 — 값이 아니라 빈 자리', () => {
  it('자리 문구를 값으로 넣지 않고, 직렬화 왕복에서 바뀌지 않는다', () => {
    const { md } = tpl();
    expect(md).not.toContain('[고객사]');
    expect(md).toMatch(/^@SUM$/m);
    expect(serialize(parse(md))).toBe(md);
  });

  it('골격만 있는 문서는 경고 0건 (평일 5일은 정보로 안내)', () => {
    const v = validate(parse(tpl().md));
    expect(v.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(v.issues.filter((i) => /아직 작성하지 않은 날/.test(i.message))).toHaveLength(5);
    expect(v.stats.clientItems).toBe(0);
  });

  it('골격은 출력에 나가지 않는다 — 빈 화살표·자리 문구 없이 빈 행', () => {
    const { html, plain } = render(parse(tpl().md));
    expect(html).not.toMatch(/&gt;|&lt;-/);
    expect(plain).not.toMatch(/->|<-|\[\]/);
  });

  it('월요일을 편집해도 다른 요일의 빈 턴(->, <-)이 사라지지 않는다', () => {
    const r = parse(tpl().md);
    const edited = updateTurn(r, 0, 0, 0, 0, 0, { text: '에이전트 이름 변경 미반영 문의' });
    const again = parse(serialize(edited));
    const tue = again.days[1].blocks[0].items[0].content[0] as DialogBlock;
    expect(tue.turns.map((t) => t.kind)).toEqual(['in', 'out']);
  });

  it('v0.3.x 초안의 자리 문구 항목은 빈 골격으로 읽혀 메일에 나가지 않는다', () => {
    const legacy = `@PREV 2026-09-21 ~ 2026-09-27

# 2026-09-21(월)
@LOC
@CUS
@SUM [고객사] (담당자/메일) 제목
  ->
  <-
`;
    const r = parse(legacy);
    expect(isBlankItem(r.days[0].blocks[0].items[0])).toBe(true);
    expect(render(r).plain).not.toContain('[고객사]');
    expect(serialize(r)).toContain('@LOC\n@CUS\n@SUM\n  ->\n  <-');
  });

  it('쓰다 만 항목의 빈 턴은 출력에서만 빠진다', () => {
    const md = `@PREV 2026-09-21 ~ 2026-09-27

# 2026-09-21(월)
@LOC 원격
@CUS MX
@SUM [MX] (담당A/메일) 제목
  -> 문의
  <-
`;
    const r = parse(md);
    expect(serialize(r)).toContain('  <-\n');
    const pruned = pruneBlank(r);
    expect((pruned.days[0].blocks[0].items[0].content[0] as DialogBlock).turns).toHaveLength(1);
  });
});

describe('저장 정합성 — 화면과 다시 연 문서가 같다', () => {
  const withTurn = (text: string): WeekReport => {
    const r = parse(`@PREV 2026-09-21 ~ 2026-09-27

# 2026-09-21(월)
@LOC 원격
@CUS MX
@SUM [MX] 제목
  -> x
`);
    return updateTurn(r, 0, 0, 0, 0, 0, { text });
  };

  it('여러 줄 턴의 이어지는 줄이 문법 줄처럼 보여도 한 턴으로 남는다', () => {
    const text = '고객 회신 원문\n- 재시작 후 동일\n1) 로그 수집\n-> 인용된 이전 메일\n@SUM 서명\n# 2026-09-22\n\\\\server\\share';
    const again = parse(serialize(withTurn(text)));
    const block = again.days[0].blocks[0].items[0].content;
    expect(block).toHaveLength(1);
    expect((block[0] as DialogBlock).turns[0].text).toBe(text);
  });

  it('문단 사이 빈 줄은 보존, 끝의 빈 줄은 버린다', () => {
    const again = parse(serialize(withTurn('첫 문단\n\n둘째 문단\n\n')));
    expect((again.days[0].blocks[0].items[0].content[0] as DialogBlock).turns[0].text).toBe('첫 문단\n\n둘째 문단');
  });

  it('이스케이프는 서로 역함수', () => {
    for (const line of ['평문', '- 목록처럼', '1) 번호처럼', '*<- 미결처럼', '> 인용', '@LOC', '# 2026', '\\경로', '']) {
      expect(unescapeContinuation(escapeContinuation(line))).toBe(line.trim());
    }
  });

  it('괄호로 시작하는 제목은 담당자·건물로 바뀌지 않는다', () => {
    const cases = [
      { client: 'MX', workType: '(긴급) 수집 안 됨' },
      { client: 'MX', contact: '담당A', workType: '(긴급) 수집 안 됨' },
      { client: 'MX', contact: '담당A', channel: '메일', workType: '(긴급) 수집 안 됨' },
      { client: 'MX', site: '누리사옥', workType: '(긴급) 수집 안 됨' },
      { client: 'MX', site: '누리사옥', contact: '담당A', workType: '(긴급) 수집 안 됨' },
    ];
    for (const header of cases) {
      const r = updateItemFields(withTurn('x'), 0, 0, 0, { site: '', contact: '', channel: '', ...header });
      const r2 = updateBlockFields(r, 0, 0, { locations: ['MX(누리사옥)'] });
      const again = parse(serialize(r2)).days[0].blocks[0].items[0];
      expect(again).toMatchObject(header);
      expect(render(parse(serialize(r2))).plain).toContain('(긴급) 수집 안 됨');
      expect(render(parse(serialize(r2))).plain).not.toContain('\\(');
    }
  });
});

describe('턴 입력칸의 마커 인식', () => {
  const out = { kind: 'out' as const, text: '' };
  it('줄 앞 마커 + 공백 → 턴 종류 변경', () => {
    expect(splitTypedTurn(out, '*<- 로그 확인 후 문의 예정')).toEqual([
      { kind: 'out', pending: true, text: '로그 확인 후 문의 예정' },
    ]);
    expect(splitTypedTurn(out, '*==> 후속 과제')).toEqual([{ kind: 'conclusion', text: '후속 과제' }]);
    expect(splitTypedTurn(out, '> 참고')).toEqual([{ kind: 'note', text: '참고' }]);
    expect(splitTypedTurn(out, '→ 붙여넣은 화살표')).toEqual([{ kind: 'in', text: '붙여넣은 화살표' }]);
  });

  it('마커 뒤 공백 전에는 바꾸지 않고, 마커 없는 글은 그대로', () => {
    expect(splitTypedTurn(out, '->')).toBeNull();
    expect(splitTypedTurn(out, '*<')).toBeNull();
    expect(splitTypedTurn(out, '안내 드림 -> 회신 대기')).toBeNull();
  });

  it('붙여넣은 메일 스레드 — 마커 줄마다 턴으로 나누고 마커 없는 줄은 이어 붙인다', () => {
    const turns = splitTypedTurn({ kind: 'in', text: '' }, '-> 재시작해도 동일\n  상세는 첨부 참조\n<- 로그 요청\n*-> 로그 회신 대기');
    expect(turns).toEqual([
      { kind: 'in', text: '재시작해도 동일\n  상세는 첨부 참조' },
      { kind: 'out', text: '로그 요청' },
      { kind: 'in', pending: true, text: '로그 회신 대기' },
    ]);
  });

  it('첫 줄에 마커가 없으면 기존 종류를 유지하고 뒤의 마커 줄만 나눈다', () => {
    expect(splitTypedTurn({ kind: 'in', text: '' }, '문의 내용\n<- 안내')).toEqual([
      { kind: 'in', text: '문의 내용' },
      { kind: 'out', text: '안내' },
    ]);
  });

  it('replaceTurn — 한 턴을 여러 턴으로', () => {
    const r = parse(tpl().md);
    const next = replaceTurn(r, 0, 0, 0, 0, 0, [
      { kind: 'in', text: 'a' },
      { kind: 'out', text: 'b' },
    ]);
    expect((next.days[0].blocks[0].items[0].content[0] as DialogBlock).turns.map((t) => t.text)).toEqual(['a', 'b', '']);
  });
});

describe('추가·자동 채움 — 같은 값을 두 번 쓰지 않게', () => {
  const base = () =>
    updateBlockFields(parse(tpl().md), 0, 0, { locations: ['MX(누리사옥)'], customer: 'MX' });

  it('항목 추가는 행의 고객사·건물을 물려받고 빈 대화 이력을 갖는다', () => {
    const r = addItem(base(), 0, 0);
    const it = r.days[0].blocks[0].items[1];
    expect(it).toMatchObject({ client: 'MX', site: '누리사옥', workType: '' });
    expect((it.content[0] as DialogBlock).turns.map((t) => t.kind)).toEqual(['in', 'out']);
  });

  it('제조사문의·미팅·테스트 같은 작업구분은 고객사로 물려주지 않는다', () => {
    const r = addItem(updateBlockFields(parse(tpl().md), 0, 0, { customer: '제조사문의' }), 0, 0);
    expect(r.days[0].blocks[0].items[1].client).toBe('');
  });

  it('행 추가는 빈 항목을 품은 빈 행', () => {
    const r = addLocationBlock(parse(tpl().md), 0);
    expect(r.days[0].blocks[1].items).toHaveLength(1);
    expect(isBlankItem(r.days[0].blocks[1].items[0])).toBe(true);
  });

  it('행 → 항목: 빈 고객사·건물 칸만 채운다', () => {
    let r = base();
    r = updateItemFields(r, 0, 0, 0, { workType: '제목' });
    r = addItem(r, 0, 0);
    r = updateItemFields(r, 0, 0, 1, { client: 'MX 본사' });
    r = updateItemFields(r, 0, 0, 0, { client: '' });
    r = fillItemClientsFromRow(r, 0, 0);
    // 사용자가 쓴 값(MX 본사)은 그대로, 빈 칸은 같은 행에서 쓰던 고객사로
    expect(r.days[0].blocks[0].items.map((i) => i.client)).toEqual(['MX 본사', 'MX 본사']);
    r = updateItemFields(r, 0, 0, 0, { site: '' });
    r = fillItemSitesFromRow(r, 0, 0);
    expect(r.days[0].blocks[0].items[0].site).toBe('누리사옥');
  });

  it('행 칸이 팀·부서명이면 팀명이 아니라 그 팀에 쓰던 고객사를 채운다 (한강 SRE → AB Z+)', () => {
    let r = updateBlockFields(parse(tpl().md), 0, 0, { locations: ['한강 제트플러스 4F'], customer: '한강 SRE' });
    r = updateItemFields(r, 0, 0, 0, { client: 'AB Z+', workType: '패치' });
    // 다른 날의 같은 팀 행 — 고객사를 비워 두면 이 보고서에서 그 팀에 쓰던 AB Z+로
    r = updateBlockFields(r, 1, 0, { locations: ['한강 제트플러스 4F'], customer: '한강 SRE' });
    r = fillItemClientsFromRow(r, 1, 0);
    expect(r.days[1].blocks[0].items[0].client).toBe('AB Z+');
    expect(addItem(r, 1, 0).days[1].blocks[0].items[1].client).toBe('AB Z+');
    // 처음 보는 팀 — 팀명을 고객사로 넣지 않고 비워 둔다 (이 보고서는 칸에 팀명을 쓰는 보고서)
    r = updateBlockFields(r, 2, 0, { locations: ['한강 제트플러스 4F'], customer: '서원 ADMIN' });
    expect(fillItemClientsFromRow(r, 2, 0).days[2].blocks[0].items[0].client).toBe('');
    // 고객사의 다른 표기(제트플러스)를 칸에 쓰면 보고서가 쓰는 표기(AB Z+)로
    r = updateBlockFields(r, 3, 0, { locations: ['외부'], customer: '제트플러스' });
    expect(fillItemClientsFromRow(r, 3, 0).days[3].blocks[0].items[0].client).toBe('AB Z+');
  });

  it('항목 → 행: 행의 고객사가 비어 있을 때만 채운다', () => {
    let r = updateItemFields(parse(tpl().md), 0, 0, 0, { client: 'MX' });
    r = fillRowCustomerFromItem(r, 0, 0, 0);
    expect(r.days[0].blocks[0].customer).toBe('MX');
    r = updateItemFields(r, 0, 0, 0, { client: 'ABZ+' });
    expect(fillRowCustomerFromItem(r, 0, 0, 0).days[0].blocks[0].customer).toBe('MX');
  });

  it('이어쓰기는 대상 날의 골격 행을 채운다 (빈 행이 남지 않음)', () => {
    let r = base();
    r = updateItemFields(r, 0, 0, 0, { client: 'MX', contact: '담당A', channel: '메일', workType: '에이전트 IP' });
    const { report, at } = continueItem(r, 0, 0, 0, r.days[1].date);
    expect(at).toEqual({ di: 1, bi: 0, ii: 0 });
    expect(report.days[1].blocks).toHaveLength(1);
    expect(report.days[1].blocks[0].items[0]).toMatchObject({ client: 'MX', contact: '담당A', workType: '에이전트 IP' });
  });
});

describe('지난주 미결 이월', () => {
  const lastWeek = `@PREV 2026-09-14 ~ 2026-09-20

# 2026-09-14(월)
@LOC 원격
@CUS MX
@SUM [MX] (담당A/메일) 에이전트 이름 변경
  -> 대시보드 미반영
  *<- 로그 확인 후 제조사 문의 예정
@SUM [MX] (담당B/메일) 라이선스 문의
  -> 만료일 문의
  *<- 확인 후 회신 예정

# 2026-09-16(수)
@LOC 원격
@CUS MX
@SUM [MX] (담당B/메일) 라이선스 문의
  <- 만료일 안내 완료
@SUM [ABZ+] (담당C/유선) 수집 지연
  *-> 고객 재현 결과 대기
`;

  it('같은 건은 마지막 기록만 본다 — 이어 쓴 뒤 미결을 풀었으면 제외', () => {
    const items = collectOpenItems(parse(lastWeek));
    expect(items.map((i) => i.header.workType)).toEqual(['에이전트 이름 변경', '수집 지연']);
    expect(items[0].pending).toEqual([{ kind: 'out', text: '로그 확인 후 제조사 문의 예정' }]);
    expect(items[1]).toMatchObject({ lastDate: '2026-09-16', pending: [{ kind: 'in', text: '고객 재현 결과 대기' }] });
  });

  it('후보 중 새 보고 주 바로 앞 주를 고른다', () => {
    const mk = (start: string) => ({ report: { ...parse(lastWeek), prevWeekRange: { start, end: start } }, label: start });
    const picked = pickPreviousReport([mk('2026-09-07'), mk('2026-09-14'), mk('2026-09-21')], '2026-09-21');
    expect(picked?.label).toBe('2026-09-14');
    expect(pickPreviousReport([mk('2026-09-21')], '2026-09-21')).toBeUndefined();
  });
});

describe('줄 → 비주얼 위치', () => {
  it('항목 줄·본문 줄은 그 항목, 항목 앞 줄은 그 일자', () => {
    const md = `@PREV 2026-09-21 ~ 2026-09-27

# 2026-09-21(월)
@LOC 원격
@CUS MX
@SUM [MX] 첫 건
  -> a
@SUM [MX] 둘째 건
  -> b

# 2026-09-22(화)
@LOC 원격
`;
    const r = parseTolerant(md).report;
    expect(locateLine(r, 7)).toEqual({ key: '0-0-0', date: '2026-09-21' });
    expect(locateLine(r, 9)).toEqual({ key: '0-0-1', date: '2026-09-21' });
    expect(locateLine(r, 12)).toEqual({ date: '2026-09-22' });
    expect(locateLine(r, 1)).toEqual({});
    expect(lineOfKey(r, '0-0-1')).toBe(8);
  });
});
