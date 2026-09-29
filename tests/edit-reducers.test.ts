import { describe, expect, it } from 'vitest';
import {
  addContentBlock,
  addDay,
  addItem,
  ensureBlock,
  moveContentBlock,
  moveItem,
  removeDay,
  removeItem,
  setWeekByPrevMonday,
  toggleHoliday,
  updateBlockFields,
  updateHolidayReason,
  updateItemFields,
  updateContentBlock,
} from '../src/core/edit';
import { parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import type { WeekReport } from '../src/core/types';

function base(): WeekReport {
  return parse(
    [
      '@PREV 2026-05-11 ~ 2026-05-17',
      '@CURRENT 2026-05-18 ~ 2026-05-24',
      '@AUTHOR 김테스트',
      '',
      '# 2026-05-11(월)',
      '@LOC 한강',
      '@CUS 한강 SRE',
      '@SUM [ABZ+] (이영희/메일) 문의 대응',
      '1) 설치 지원',
      '- 가이드 전달',
      '',
      '# 2026-05-12(화)',
      '',
    ].join('\n'),
  );
}

describe('edit 리듀서 — 불변성', () => {
  it('원본 AST는 변경되지 않는다', () => {
    const r = base();
    const snapshot = JSON.stringify(r);
    toggleHoliday(r, 1);
    addDay(r, '2026-05-13');
    updateItemFields(r, 0, 0, 0, { workType: '변경' });
    addContentBlock(r, 0, 0, 0, 'dialog');
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe('edit 리듀서 — 일자/휴무', () => {
  it('addDay는 날짜순 삽입 + 요일 자동, 중복·잘못된 날짜는 무시', () => {
    const r = base();
    const next = addDay(r, '2026-05-13'); // 수요일, 중간이 아니라 끝이지만 정렬 확인
    expect(next.days.map((d) => d.date)).toEqual(['2026-05-11', '2026-05-12', '2026-05-13']);
    expect(next.days[2].weekday).toBe('수');
    expect(addDay(next, '2026-05-11')).toBe(next); // 중복 무시
    expect(addDay(next, 'not-a-date')).toBe(next); // 무효 무시
  });

  it('toggleHoliday on/off — blocks 보존, reason 갱신', () => {
    const r = base();
    const on = toggleHoliday(r, 0);
    expect(on.days[0].holiday).toEqual({ reason: '' });
    expect(on.days[0].blocks.length).toBe(1); // 작업 보존
    const withReason = updateHolidayReason(on, 0, '대체 휴무');
    expect(withReason.days[0].holiday).toEqual({ reason: '대체 휴무' });
    const off = toggleHoliday(withReason, 0);
    expect(off.days[0].holiday).toBeUndefined();
    expect(off.days[0].blocks[0].items[0].workType).toBe('문의 대응');
  });

  it('removeDay + 경계 무시', () => {
    const r = base();
    expect(removeDay(r, 1).days.map((d) => d.date)).toEqual(['2026-05-11']);
    expect(removeDay(r, 9)).toBe(r);
  });

  it('setWeekByPrevMonday — @PREV 월~일 + @CURRENT 다음주 월~일 (일정 예정 범위)', () => {
    const r = setWeekByPrevMonday(base(), '2026-06-22');
    expect(r.prevWeekRange).toEqual({ start: '2026-06-22', end: '2026-06-28' });
    expect(r.currentWeekRange).toEqual({ start: '2026-06-29', end: '2026-07-05' });
  });
});

describe('edit 리듀서 — 블록/항목', () => {
  it('ensureBlock은 빈 일자에만 기본 블록 생성', () => {
    const r = base();
    const ensured = ensureBlock(r, 1);
    expect(ensured.days[1].blocks.length).toBe(1);
    expect(ensureBlock(ensured, 1)).toBe(ensured); // 이미 있으면 no-op
  });

  it('updateBlockFields — @LOC/@CUS 갱신', () => {
    const r = updateBlockFields(base(), 0, 0, { locations: ['서원'], customer: '서원 SRE' });
    expect(r.days[0].blocks[0].locations).toEqual(['서원']);
    expect(r.days[0].blocks[0].customer).toBe('서원 SRE');
  });

  it('updateItemFields — 빈 contact/channel은 필드 제거 (serialize 괄호 생략)', () => {
    const r = updateItemFields(base(), 0, 0, 0, { contact: ' ', channel: '' });
    const item = r.days[0].blocks[0].items[0];
    expect(item.contact).toBeUndefined();
    expect(item.channel).toBeUndefined();
    expect(serialize(r)).toContain('@SUM [ABZ+] 문의 대응');
  });

  it('add/remove/moveItem + 경계 이동 no-op', () => {
    let r = addItem(base(), 0, 0);
    r = updateItemFields(r, 0, 0, 1, { client: 'MX', workType: '점검' });
    expect(r.days[0].blocks[0].items.map((i) => i.client)).toEqual(['ABZ+', 'MX']);
    r = moveItem(r, 0, 0, 1, -1);
    expect(r.days[0].blocks[0].items.map((i) => i.client)).toEqual(['MX', 'ABZ+']);
    expect(moveItem(r, 0, 0, 0, -1)).toBe(r); // 경계 밖 no-op
    expect(removeItem(r, 0, 0, 0).days[0].blocks[0].items.map((i) => i.client)).toEqual(['ABZ+']);
  });
});

describe('edit 리듀서 — 콘텐츠 블록', () => {
  it('addContentBlock: numbered index 자동 증가, dialog/bullets 시드', () => {
    let r = addContentBlock(base(), 0, 0, 0, 'numbered');
    let content = r.days[0].blocks[0].items[0].content;
    expect(content[1]).toEqual({ kind: 'numbered', index: 2, title: '', details: [] });
    r = addContentBlock(r, 0, 0, 0, 'dialog');
    content = r.days[0].blocks[0].items[0].content;
    expect(content[2]).toEqual({ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }] });
  });

  it('updateContentBlock 교체 + moveContentBlock 순서 변경', () => {
    let r = addContentBlock(base(), 0, 0, 0, 'bullets');
    r = updateContentBlock(r, 0, 0, 0, 1, { kind: 'bullets', items: ['항목A', '> 노트'] });
    expect(r.days[0].blocks[0].items[0].content[1]).toEqual({
      kind: 'bullets',
      items: ['항목A', '> 노트'],
    });
    r = moveContentBlock(r, 0, 0, 0, 1, -1);
    expect(r.days[0].blocks[0].items[0].content[0].kind).toBe('bullets');
  });
});

describe('edit 리듀서 — serialize 왕복 프로퍼티', () => {
  it('리듀서 편집 결과는 serialize→parse 후에도 동일 구조', () => {
    let r = base();
    r = addDay(r, '2026-05-13');
    // ensureBlock은 빈 항목 1개를 품은 골격 행을 만든다 — 그 항목을 채우고 골격 대화 이력을 목록으로 바꾼다
    r = ensureBlock(r, 2);
    r = updateBlockFields(r, 2, 0, { locations: ['남산'], customer: '남산 IDC' });
    r = updateItemFields(r, 2, 0, 0, { client: 'ABZ+', contact: '담당', channel: '유선', workType: '정기 점검' });
    r = updateContentBlock(r, 2, 0, 0, 0, { kind: 'bullets', items: ['점검 완료', '> 이상 없음'] });
    r = toggleHoliday(r, 1);
    r = updateHolidayReason(r, 1, '대체 휴무');

    const reparsed = parse(serialize(r));
    expect(reparsed.days.map((d) => d.date)).toEqual(r.days.map((d) => d.date));
    expect(reparsed.days[1].holiday).toEqual({ reason: '대체 휴무' });
    expect(reparsed.days[2].blocks[0].items[0]).toMatchObject({
      client: 'ABZ+',
      contact: '담당',
      channel: '유선',
      workType: '정기 점검',
    });
    expect(reparsed.days[2].blocks[0].items[0].content).toEqual(r.days[2].blocks[0].items[0].content);
  });
});
