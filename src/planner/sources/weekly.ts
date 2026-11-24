/**
 * 주간보고 → 후보·일정 (설계 §5.3). **형식 표지만** 읽는다 — `*<-`(내 후속 조치) · `*->`(상대 회신 대기) · `@PLAN`.
 * 문장 속 상태 낱말은 읽지 않는다: 주간보고는 작업일지의 요약본이라 같은 건을 두 번 세게 된다.
 * 대상은 가장 최근 보고서 하나(지금 초안과 지난 파일 중 보고 주가 가장 늦은 것)다.
 */
import { formatItemHeader } from '../../core/item-header';
import { parseTolerant } from '../../core/parser';
import type { WeekReport } from '../../core/types';
import { detectClient, sortEvents, type HomeEvent } from '../classify';
import type { Candidate } from './worklog';

export interface WeeklySource {
  /** 파일 이름 — 지금 초안이면 '' */
  name: string;
  text: string;
}

export interface WeeklyScan {
  candidates: Candidate[];
  /** `@PLAN` 줄 — 오늘 이후 */
  plans: HomeEvent[];
  /** 읽은 보고서 (없으면 null) */
  from: { name: string; week: string } | null;
}

function latest(sources: readonly WeeklySource[]): { src: WeeklySource; report: WeekReport } | null {
  let best: { src: WeeklySource; report: WeekReport } | null = null;
  for (const src of sources) {
    if (!src.text.trim()) continue;
    const { report } = parseTolerant(src.text);
    const start = report.prevWeekRange.start;
    if (!start) continue;
    // 같은 주면 앞에 온 것(지금 초안)을 쓴다
    if (!best || start > best.report.prevWeekRange.start) best = { src, report };
  }
  return best;
}

/** `10:00 MX(정기점검)` · `(종일) 가나스토어 패치` · `휴가` → 시각과 제목 */
function planParts(text: string): { time: string; title: string } {
  const t = text.trim();
  const m = /^(\d{1,2}:\d{2})\s+(.*)$/.exec(t);
  if (m) return { time: m[1].padStart(5, '0'), title: m[2].trim() };
  return { time: '', title: t.replace(/^\(종일\)\s*/, '') };
}

export function scanWeekly(sources: readonly WeeklySource[], today: string): WeeklyScan {
  const hit = latest(sources);
  if (!hit) return { candidates: [], plans: [], from: null };
  const { src, report } = hit;
  const candidates: Candidate[] = [];
  for (const day of report.days) {
    if (day.holiday) continue;
    for (const block of day.blocks) {
      for (const item of block.items) {
        const header = formatItemHeader(item);
        for (const c of item.content) {
          if (c.kind !== 'dialog') continue;
          for (const turn of c.turns) {
            if (!turn.pending || !turn.text.trim() || (turn.kind !== 'in' && turn.kind !== 'out')) continue;
            const phrase = turn.text.trim().split(/\r?\n/)[0];
            candidates.push({
              key: ['weekly', report.prevWeekRange.start, header.replace(/\s+/g, ''), phrase].join('\u0000'),
              source: 'weekly',
              // `*<-` = 내 후속 조치가 남음, `*->` = 상대 회신을 기다림
              cls: turn.kind === 'out' ? 'todo' : 'wait',
              title: item.workType.trim() || header,
              client: item.client.trim(),
              who: (item.contact ?? '').split('/')[0].trim(),
              phrase,
              waitingOn: '',
              date: day.date,
              due: null,
              weekly: { file: src.name, line: item.srcLine ?? 0 },
            });
          }
        }
      }
    }
  }
  const plans: HomeEvent[] = [];
  (report.plans ?? []).forEach((p, i) => {
    if (!p.text.trim() || p.date < today) return;
    const { time, title } = planParts(p.text);
    const leave = /^(휴가|연차|반차)/.test(title);
    plans.push({
      key: `plan/${report.prevWeekRange.start}/${i}`,
      ref: null,
      title,
      kind: leave ? 'leave' : /회의|미팅/.test(title) ? 'meeting' : 'work',
      allDay: !time,
      date: p.date,
      endDate: p.date,
      startTime: time,
      endTime: '',
      location: '',
      client: leave ? '' : detectClient(title),
      htmlLink: '',
      canWrite: false,
      source: 'plan',
    });
  });
  return { candidates, plans: sortEvents(plans), from: { name: src.name, week: report.prevWeekRange.start } };
}

/**
 * `.md` 머리(첫 `# 일자` 앞)에 `@PLAN` 줄을 끼워 넣는다 — 나머지 줄은 한 글자도 바꾸지 않는다.
 * 자리는 마지막 `@PLAN` 줄 뒤, 없으면 마지막 머리 지시어(@PREV·@CURRENT·@AUTHOR) 뒤다.
 */
export function insertPlanLines(md: string, plans: ReadonlyArray<{ date: string; text: string }>): string {
  if (plans.length === 0) return md;
  const lines = md.split('\n');
  const firstDay = lines.findIndex((l) => /^#\s/.test(l));
  const head = firstDay < 0 ? lines.length : firstDay;
  let at = -1;
  let lastPlan = -1;
  for (let i = 0; i < head; i++) {
    const t = lines[i].trim();
    if (/^@PLAN(\s|$)/.test(t)) lastPlan = i;
    if (/^@(PREV|WEEK|CURRENT|NEXT|AUTHOR|PLAN)(\s|$)/.test(t)) at = i;
  }
  const where = (lastPlan >= 0 ? lastPlan : at) + 1;
  lines.splice(where, 0, ...plans.map((p) => `@PLAN ${p.date} ${p.text}`));
  return lines.join('\n');
}

/**
 * 달력 일정 → 주간보고 `@PLAN` 줄 (설계 §12 3단계). 범위(다음 주 월~일) 안의 회의·작업·휴가만.
 * 일정 칸 형식은 주간보고 형식 문서 §6: `HH:MM 제목` · `(종일) 제목` · `휴가`.
 */
export function plansFromEvents(events: readonly HomeEvent[], range: { start: string; end: string }): Array<{ date: string; text: string }> {
  const out: Array<{ date: string; text: string }> = [];
  for (const e of events) {
    if (e.source !== 'gcal' || e.kind === 'place' || e.kind === 'holiday') continue;
    if (e.date < range.start || e.date > range.end) continue;
    const text = e.kind === 'leave' ? (e.allDay ? '휴가' : `${e.startTime} ${e.title}`) : e.allDay ? `(종일) ${e.title}` : `${e.startTime} ${e.title}`;
    if (!out.some((p) => p.date === e.date && p.text === text)) out.push({ date: e.date, text });
  }
  return out;
}
