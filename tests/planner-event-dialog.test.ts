/**
 * 일정 고치기 창이 달력에 보내는 값 — 바뀐 칸만 보내고, 밤을 넘기거나 여러 날에 걸친 일정의 길이를 지킨다.
 * (2026-11-24 점검: 전에는 창의 값 전부를 보내, 제목만 고쳐도 시각을 다시 썼고 여러 날 시각 일정이 하루로 줄었다.)
 */
import { describe, expect, it } from 'vitest';
import { buildEventInput, eventPatch } from '../src/planner/components/EventDialog';
import type { EventInput } from '../src/planner/types';

const form = { title: '수집 서버 패치', allDay: false, date: '2026-12-03', endDate: '2026-12-03', start: '10:00', end: '12:00', location: '' };

describe('buildEventInput', () => {
  it('시각 일정 — 같은 날이면 끝이 시작보다 뒤여야 한다', () => {
    expect(buildEventInput(form)).toEqual({ summary: '수집 서버 패치', allDay: false, start: '2026-12-03T10:00', end: '2026-12-03T12:00', location: '' });
    expect(buildEventInput({ ...form, end: '10:00' })).toBe('끝 시각이 시작 시각보다 뒤여야 합니다.');
    expect(buildEventInput({ ...form, title: '  ' })).toBe('제목을 입력하세요.');
    expect(buildEventInput({ ...form, date: '2026-02-30' })).toBe('날짜를 고르세요.');
  });

  it('밤을 넘기는 일정 — 걸친 날 수를 지켜 끝을 다음 날로 보낸다', () => {
    expect(buildEventInput({ ...form, start: '22:00', end: '01:00', span: 1 })).toMatchObject({ start: '2026-12-03T22:00', end: '2026-12-04T01:00' });
    // 달을 넘겨도
    expect(buildEventInput({ ...form, date: '2026-12-31', start: '09:00', end: '18:00', span: 2 })).toMatchObject({ start: '2026-12-31T09:00', end: '2027-01-02T18:00' });
  });

  it('종일 일정 — 끝 날짜(포함)가 비었거나 틀리면 하루짜리', () => {
    expect(buildEventInput({ ...form, allDay: true, endDate: '2026-12-05' })).toMatchObject({ allDay: true, start: '2026-12-03', end: '2026-12-05' });
    expect(buildEventInput({ ...form, allDay: true, endDate: '' })).toMatchObject({ start: '2026-12-03', end: '2026-12-03' });
    expect(buildEventInput({ ...form, allDay: true, endDate: '2026-12-01' })).toBe('끝 날짜가 시작 날짜보다 앞섭니다.');
  });
});

describe('eventPatch — 바뀐 칸만', () => {
  const original = { title: '수집 서버 패치', allDay: false, date: '2026-12-03', endDate: '2026-12-03', startTime: '10:00', endTime: '12:00', location: '누리사옥 4층' };
  const same: EventInput = { summary: '수집 서버 패치', allDay: false, start: '2026-12-03T10:00', end: '2026-12-03T12:00', location: '누리사옥 4층' };

  it('아무것도 고치지 않았으면 빈 값', () => {
    expect(eventPatch(original, same)).toEqual({});
  });

  it('제목만·장소만 고치면 그 칸만 — 시각은 보내지 않는다', () => {
    expect(eventPatch(original, { ...same, summary: '수집 서버 패치 (2차)' })).toEqual({ summary: '수집 서버 패치 (2차)' });
    expect(eventPatch(original, { ...same, location: '' })).toEqual({ location: '' });
  });

  it('시각을 옮기면 종일 여부·시작·끝을 함께 보낸다', () => {
    expect(eventPatch(original, { ...same, start: '2026-12-04T14:00', end: '2026-12-04T16:00' })).toEqual({ allDay: false, start: '2026-12-04T14:00', end: '2026-12-04T16:00' });
    expect(eventPatch(original, { ...same, allDay: true, start: '2026-12-03', end: '2026-12-03' })).toEqual({ allDay: true, start: '2026-12-03', end: '2026-12-03' });
  });

  it('제목이 없던 일정 — 자리 글 "(제목 없음)"을 그대로 두면 제목을 보내지 않는다', () => {
    const untitled = { ...original, title: '(제목 없음)' };
    expect(eventPatch(untitled, { ...same, summary: '(제목 없음)', location: '본사 3층' })).toEqual({ location: '본사 3층' });
  });

  it('여러 날에 걸친 시각 일정 — 손대지 않으면 시각을 보내지 않는다', () => {
    const long = { ...original, endDate: '2026-12-04', endTime: '18:00' };
    const input = buildEventInput({ title: long.title, allDay: false, date: long.date, endDate: long.endDate, start: long.startTime, end: long.endTime, location: long.location, span: 1 });
    expect(eventPatch(long, input as EventInput)).toEqual({});
  });

  it('여러 날 종일 일정 — 끝 날짜(포함)가 같으면 보내지 않는다', () => {
    const leave = { title: '휴가', allDay: true, date: '2026-12-03', endDate: '2026-12-05', startTime: '', endTime: '', location: '' };
    expect(eventPatch(leave, { summary: '휴가', allDay: true, start: '2026-12-03', end: '2026-12-05', location: '' })).toEqual({});
    expect(eventPatch(leave, { summary: '휴가', allDay: true, start: '2026-12-03', end: '2026-12-04', location: '' })).toEqual({ allDay: true, start: '2026-12-03', end: '2026-12-04' });
  });
});
