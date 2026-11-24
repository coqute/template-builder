/**
 * Notion에서 읽은 페이지를 홈에 맞게 — ① 회의록을 본인 달력의 일정에 잇기 ② 최근 바뀐 것을 DB별로 묶기.
 * 순수 함수다(읽는 것은 main의 notion.ts). 설계: docs/home-schedule-design.md §19.10
 *
 * 회의록 DB에는 달력 일정과 이어 주는 칸이 없다. 실제 자료에서 회의록은 모두 회의 중에 만들어졌으므로
 * (만든 때가 그 일정의 시간 안), 제목이나 분류가 아니라 **만든 시각**으로 잇는다.
 */
import type { HomeEvent } from '../classify';
import { addDays, localParts } from '../dates';
import type { NotionPage, NotionSettings, NotionSource } from '../types';

/** 일정 시작 전·끝난 뒤 이만큼까지는 그 회의의 회의록으로 본다 (분) */
const SLACK_MIN = 30;
/** 끝나는 시각이 없는 일정의 길이 (분) */
const DEFAULT_LEN_MIN = 60;
/** 제목 견주기에서 빼는 낱말 — 어느 회의에나 붙는다 */
const COMMON = new Set(['회의', '회의록', '미팅', 'meeting', '주간', '정기', '월간']);

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^0-9a-z가-힣+]+/)
      .filter((w) => w.length >= 2 && !COMMON.has(w)),
  );
}

/** 두 제목에 함께 나오는 낱말 수 */
export function sharedWords(a: string, b: string): number {
  const B = words(b);
  let n = 0;
  for (const w of words(a)) if (B.has(w)) n++;
  return n;
}

export interface NoteLinks {
  /** 일정 키 → 그 일정의 회의록 (만든 순) */
  byEvent: Map<string, NotionPage[]>;
  /** 이을 일정을 찾지 못한 회의록 */
  orphans: NotionPage[];
}

/** 회의록을 이을 수 있는 일정 — 본인 달력의, 시각이 있는, 하루 안에 끝나는 일정 */
const linkable = (e: HomeEvent): boolean => e.source === 'gcal' && !e.other && !e.allDay && e.kind !== 'holiday' && e.kind !== 'leave' && e.date === e.endDate && minutes(e.startTime) >= 0;

/**
 * 회의록 → 일정.
 * ① 같은 날, 일정 시작 30분 전 ~ 끝 30분 뒤 사이에 만든 것 (둘 이상이면 제목 낱말이 더 겹치는 쪽, 그다음 시작이 가까운 쪽)
 * ② 없으면 그날 이을 수 있는 일정이 하나뿐일 때 그 일정
 * ③ 없으면 다음 날 일정 가운데 제목 낱말이 겹치는 것 (회의록을 전날 미리 만든 경우)
 * ④ 끝까지 없으면 orphans
 */
export function linkMeetingNotes(notes: readonly NotionPage[], events: readonly HomeEvent[]): NoteLinks {
  const pool = events.filter(linkable);
  const byEvent = new Map<string, NotionPage[]>();
  const orphans: NotionPage[] = [];
  const sorted = [...notes].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const note of sorted) {
    const at = localParts(note.createdAt);
    const min = minutes(at.time);
    const sameDay = pool.filter((e) => e.date === at.date);
    const start = (e: HomeEvent) => minutes(e.startTime);
    const end = (e: HomeEvent) => (minutes(e.endTime) >= 0 ? minutes(e.endTime) : start(e) + DEFAULT_LEN_MIN);
    const best = (list: HomeEvent[]): HomeEvent | undefined =>
      [...list].sort((a, b) => sharedWords(note.title, b.title) - sharedWords(note.title, a.title) || Math.abs(start(a) - min) - Math.abs(start(b) - min))[0];
    let hit = min >= 0 ? best(sameDay.filter((e) => min >= start(e) - SLACK_MIN && min <= end(e) + SLACK_MIN)) : undefined;
    if (!hit && sameDay.length === 1) hit = sameDay[0];
    if (!hit) {
      const next = addDays(at.date, 1);
      hit = best(pool.filter((e) => e.date === next && sharedWords(note.title, e.title) > 0));
    }
    if (hit) byEvent.set(hit.key, [...(byEvent.get(hit.key) ?? []), note]);
    else orphans.push(note);
  }
  return { byEvent, orphans };
}

export interface NotionGroup {
  /** DB — DB 밖의 페이지 묶음이면 null */
  source: NotionSource | null;
  pages: Array<NotionPage & { date: string; fresh: boolean }>;
}

/**
 * 최근 `days`일(오늘 포함)에 고친 페이지를 DB별로 — 가장 최근에 움직인 DB가 위로.
 * 설정에서 고르지 않은 DB의 페이지(회의록 DB만 따로 읽은 경우 등)는 넣지 않는다.
 */
export function recentGroups(pages: readonly NotionPage[], settings: NotionSettings, today: string): NotionGroup[] {
  const from = addDays(today, -(Math.max(1, settings.days) - 1));
  const names = new Map(settings.sources.map((s) => [s.id, s]));
  const groups = new Map<string, NotionGroup>();
  for (const p of pages) {
    const date = localParts(p.editedAt).date;
    if (date < from) continue;
    const source = p.sourceId ? (names.get(p.sourceId) ?? null) : null;
    if (p.sourceId ? !source : !settings.loose) continue;
    const key = source?.id ?? '';
    const g = groups.get(key) ?? { source, pages: [] };
    g.pages.push({ ...p, date, fresh: localParts(p.createdAt).date >= from });
    groups.set(key, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.pages.sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : 0));
  return list.sort((a, b) => (a.pages[0].editedAt < b.pages[0].editedAt ? 1 : -1));
}

/** main에 읽어 달라고 할 DB — 홈에 보일 DB와 회의록 DB */
export function sourcesToRead(settings: NotionSettings): string[] {
  return [...new Set([...settings.sources.map((s) => s.id), settings.meetings].filter(Boolean))];
}
