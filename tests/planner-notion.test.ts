/**
 * Notion에서 읽은 페이지를 홈에 맞게 — 회의록을 본인 달력 일정에 잇는 규칙, 최근 바뀐 것을 DB별로 묶기,
 * 설정을 저장할 때 다듬기, 일지 회의 블록의 회의록 줄. 값은 모두 합성이다.
 */
import { describe, expect, it } from 'vitest';
import { classifyEvents } from '../src/planner/classify';
import { addDays } from '../src/planner/dates';
import { applyOp, DEFAULT_NOTION, emptyState, newTaskId, normalizeState } from '../src/planner/ops';
import { linkMeetingNotes, recentGroups, sharedWords, sourcesToRead } from '../src/planner/sources/notion';
import type { NotionPage, NotionSettings, RawEvent } from '../src/planner/types';
import { eventBlock } from '../src/planner/worklogWrite';

const DAY = '2026-11-18';
const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();

function event(id: string, summary: string, date: string, start: string, end: string, extra: Partial<RawEvent> = {}): RawEvent {
  return { calendarId: 'primary', id, summary, location: '', allDay: false, start: at(date, start), end: at(date, end), status: 'confirmed', eventType: 'default', htmlLink: '', meet: false, declined: false, holiday: false, canWrite: true, updated: '', ...extra };
}
const note = (id: string, title: string, created: string, edited = created, sourceId = 'ds-meet'): NotionPage => ({ id, sourceId, title, createdAt: created, editedAt: edited, url: `https://www.notion.so/${id}` });
const home = (raw: RawEvent[]) => classifyEvents(raw);

describe('linkMeetingNotes — 회의록을 본인 달력 일정에 잇는다', () => {
  it('일정 시간(앞뒤 30분) 안에 만든 회의록은 그 일정에 — 제목이 달라도', () => {
    const events = home([event('a', 'AB Z+ 현장 지원', DAY, '10:00', '12:00'), event('b', 'MX 주간 미팅', DAY, '14:00', '15:00')]);
    const got = linkMeetingNotes([note('n1', '예시 고객사 협의', at(DAY, '10:05')), note('n2', '주간 정리', at(DAY, '15:20'))], events);
    expect(got.byEvent.get('primary/a')?.map((n) => n.id)).toEqual(['n1']);
    expect(got.byEvent.get('primary/b')?.map((n) => n.id)).toEqual(['n2']);
    expect(got.orphans).toEqual([]);
  });

  it('시작 30분 전까지는 그 일정으로 보고, 그보다 이르면 시각으로는 잇지 않는다', () => {
    const events = home([event('a', '가나스토어 점검', DAY, '10:00', '11:00'), event('b', 'MX 협의', DAY, '16:00', '17:00')]);
    expect(linkMeetingNotes([note('n1', '메모', at(DAY, '09:31'))], events).byEvent.has('primary/a')).toBe(true);
    expect(linkMeetingNotes([note('n2', '메모', at(DAY, '13:00'))], events).orphans.map((n) => n.id)).toEqual(['n2']);
  });

  it('시간이 겹치는 일정이 둘이면 제목 낱말이 더 겹치는 쪽', () => {
    const events = home([event('a', '가나스토어 정기점검', DAY, '10:00', '11:00'), event('b', 'AB Z+ 알림 설정 협의', DAY, '10:30', '11:30')]);
    const got = linkMeetingNotes([note('n1', 'AB Z+ 알림 설정 회의', at(DAY, '10:40'))], events);
    expect([...got.byEvent.keys()]).toEqual(['primary/b']);
  });

  it('시각이 맞지 않아도 그날 이을 수 있는 일정이 하나뿐이면 그 일정', () => {
    const events = home([event('a', 'AB Z+ 현장 지원', DAY, '10:00', '11:00'), event('x', '휴가', DAY, '00:00', '00:00', { allDay: true, start: DAY, end: addDays(DAY, 1) })]);
    expect(linkMeetingNotes([note('n1', '저녁에 정리한 회의록', at(DAY, '19:00'))], events).byEvent.has('primary/a')).toBe(true);
  });

  it('전날 미리 만든 회의록은 다음 날 일정 가운데 제목 낱말이 겹치는 것에', () => {
    const next = addDays(DAY, 1);
    const events = home([event('a', 'MX 알림 분류 회의', next, '10:00', '11:00'), event('b', '가나스토어 점검', next, '14:00', '15:00')]);
    const got = linkMeetingNotes([note('n1', 'MX 알림 분류 회의', at(DAY, '17:30')), note('n2', '관계없는 메모', at(DAY, '17:40'))], events);
    expect(got.byEvent.get('primary/a')?.map((n) => n.id)).toEqual(['n1']);
    expect(got.orphans.map((n) => n.id)).toEqual(['n2']);
  });

  it('남의 달력·종일 일정·휴가에는 잇지 않는다', () => {
    const events = home([
      event('team', '담당A 현장 점검', DAY, '10:00', '11:00', { calendarId: 'team', other: true, calendarName: '담당A', canWrite: false }),
      event('all', '사내 행사', DAY, '00:00', '00:00', { allDay: true, start: DAY, end: addDays(DAY, 1) }),
      event('leave', '오후 반차', DAY, '14:00', '18:00'),
    ]);
    const got = linkMeetingNotes([note('n1', '현장 점검', at(DAY, '10:10')), note('n2', '메모', at(DAY, '15:00'))], events);
    expect(got.byEvent.size).toBe(0);
    expect(got.orphans).toHaveLength(2);
  });

  it('한 일정에 회의록이 둘이면 만든 순서로 둘 다', () => {
    const events = home([event('a', 'AB Z+ 정기 회의', DAY, '10:00', '11:00')]);
    const got = linkMeetingNotes([note('late', '후속 정리', at(DAY, '10:50')), note('early', '회의록', at(DAY, '10:02'))], events);
    expect(got.byEvent.get('primary/a')?.map((n) => n.id)).toEqual(['early', 'late']);
  });

  it('제목 견주기는 어느 회의에나 붙는 낱말(회의·미팅·주간)을 세지 않는다', () => {
    expect(sharedWords('MX 주간 회의', '가나스토어 주간 회의')).toBe(0);
    expect(sharedWords('AB Z+ 알림 설정 회의', 'AB Z+ 알림 설정 협의')).toBe(4); // ab · z+ · 알림 · 설정
  });
});

describe('recentGroups — 최근 바뀐 것을 DB별로', () => {
  const TODAY = '2026-11-24';
  const settings: NotionSettings = {
    sources: [
      { id: 'ds-meet', name: '예시 회의', url: '' },
      { id: 'ds-support', name: '지원 기록', url: '' },
    ],
    meetings: 'ds-meet',
    loose: true,
    days: 7,
  };
  const pages: NotionPage[] = [
    note('s1', '수집 누락 문의', at('2026-11-10', '09:00'), at(TODAY, '09:10'), 'ds-support'),
    note('s2', '알림 분류 요청', at('2026-11-23', '15:00'), at('2026-11-23', '15:00'), 'ds-support'),
    note('m1', '정기 회의', at('2026-11-20', '10:00'), at('2026-11-20', '11:00'), 'ds-meet'),
    note('old', '지난 회의', at('2026-11-01', '10:00'), at('2026-11-17', '10:00'), 'ds-meet'),
    note('x', '고르지 않은 DB의 행', at(TODAY, '08:00'), at(TODAY, '08:00'), 'ds-other'),
    note('p', '온보딩 안내', at('2026-10-01', '10:00'), at('2026-11-22', '10:00'), ''),
  ];

  it('기간 안의 것만, 가장 최근에 움직인 DB부터, 고르지 않은 DB는 빼고', () => {
    const got = recentGroups(pages, settings, TODAY);
    expect(got.map((g) => g.source?.name ?? 'DB 밖')).toEqual(['지원 기록', 'DB 밖', '예시 회의']);
    expect(got[0].pages.map((p) => p.id)).toEqual(['s1', 's2']);
    expect(got[2].pages.map((p) => p.id)).toEqual(['m1']); // 11/17에 고친 것은 7일(11/18~) 밖
  });

  it('그 기간에 새로 만든 페이지에만 fresh', () => {
    const got = recentGroups(pages, settings, TODAY);
    expect(got[0].pages.map((p) => [p.id, p.fresh])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
  });

  it('DB 밖의 페이지는 설정을 껐으면 넣지 않고, 기간을 줄이면 그만큼만', () => {
    expect(recentGroups(pages, { ...settings, loose: false }, TODAY).some((g) => !g.source)).toBe(false);
    expect(recentGroups(pages, { ...settings, days: 1 }, TODAY).flatMap((g) => g.pages.map((p) => p.id))).toEqual(['s1']);
  });

  it('읽을 DB = 홈에 보일 DB + 회의록 DB (겹치면 한 번)', () => {
    expect(sourcesToRead(settings)).toEqual(['ds-meet', 'ds-support']);
    expect(sourcesToRead({ ...settings, sources: [settings.sources[1]] })).toEqual(['ds-support', 'ds-meet']);
    expect(sourcesToRead(DEFAULT_NOTION)).toEqual([]);
  });
});

describe('Notion 설정 저장', () => {
  const ctx = { now: '2026-11-24T09:00:00.000Z', today: '2026-11-24', by: 'app' as const, newId: newTaskId };

  it('옛 저장 파일(Notion 칸 없음)은 기본값으로 읽는다', () => {
    const state = normalizeState({ version: 1, rev: 3, tasks: [], links: [], settings: { lookbackDays: 30, calendars: ['primary'], holidays: true } });
    expect(state.settings.notion).toEqual(DEFAULT_NOTION);
  });

  it('DB 목록은 ID가 겹치지 않게, 주소는 Notion의 https 주소만, 기간은 1~30일로', () => {
    const { state } = applyOp(
      emptyState(),
      {
        type: 'settings',
        patch: {
          notion: {
            sources: [
              { id: 'ds-1', name: '  예시   회의 ', url: 'https://www.notion.so/abc' },
              { id: 'ds-1', name: '겹친 것', url: '' },
              { id: 'ds-2', name: '', url: 'https://evil.example/notion.so/' },
              { id: '', name: 'ID 없음', url: '' },
            ],
            meetings: 'ds-1',
            loose: false,
            days: 90,
          },
        },
      },
      ctx,
    );
    expect(state.settings.notion).toEqual({
      sources: [
        { id: 'ds-1', name: '예시 회의', url: 'https://www.notion.so/abc' },
        { id: 'ds-2', name: '이름 없는 DB', url: '' },
      ],
      meetings: 'ds-1',
      loose: false,
      days: 30,
    });
  });

  it('다른 설정만 고치면 Notion 설정은 그대로 남는다', () => {
    const a = applyOp(emptyState(), { type: 'settings', patch: { notion: { sources: [{ id: 'ds-1', name: '회의', url: '' }], meetings: 'ds-1', loose: true, days: 3 } } }, ctx).state;
    const b = applyOp(a, { type: 'settings', patch: { lookbackDays: 60 } }, ctx).state;
    expect(b.settings.lookbackDays).toBe(60);
    expect(b.settings.notion).toEqual(a.settings.notion);
  });
});

describe('일지 회의 블록의 회의록 줄', () => {
  it('이어진 회의록이 있으면 루틴과 같은 줄을 한 줄 더한다 — 주소는 넣지 않는다', () => {
    expect(eventBlock({ title: 'MX 알림 설정', kind: 'meeting' }, { db: '예시 회의', title: 'MX 알림 설정 회의' })).toBe('■ MX 알림 설정 회의 (캘린더 일정)\n※ 회의록: Notion 예시 회의 > MX 알림 설정 회의');
    expect(eventBlock({ title: 'AB Z+ 현장 지원', kind: 'work' }, { db: '', title: '협의' })).toBe('■ AB Z+ 현장 지원 (캘린더 일정)\n※ 회의록: Notion 협의');
    expect(eventBlock({ title: 'AB Z+ 현장 지원', kind: 'work' })).toBe('■ AB Z+ 현장 지원 (캘린더 일정)');
  });
});
