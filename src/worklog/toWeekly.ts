/**
 * 작업일지 → 주간보고 .md — 한 주의 일지를 읽어 주간보고 골격을 채운다(AI 없이 규칙만, 바로·무료).
 * 규칙은 주간보고 루틴과 같다 — 2026-11-13에 루틴 쪽을 이 표에 맞췄다.
 * 한쪽을 바꾸면 다른 쪽도 고친다.
 *   ■ (요청자/채널) 사안      → @SUM [고객] (요청자/채널) 사안
 *   ■ 사안 (요청자 없음)        → @SUM [고객] 사안            (현장·내부 작업)
 *   ■ 회의 (캘린더 일정)        → @SUM [고객] 회의 참석
 *   ※ 참고(■ 바로 아래)         → - 참고                      (회의록 출처 줄은 뺀다)
 *   ▶ 수행                     → - 수행 (헤드라인)
 *   - 사실 / > 부연             → > 사실 / > 부연              (헤드라인 아래 항목별 줄)
 *   ※ 전달물 + 원문             → 빼기 (▶에 이미 적혀 있다)
 * 고객사|작업구분(@CUS)은 지난 주간보고에서 배운다 — 요청자별로 가장 많이 쓴 값, 없으면 폴더 기본값.
 * 고객 토큰은 표준 표기로 쓴다 — 지난 보고에 `ABZ+`가 많아도 `[AB Z+]` (customer.ts canonicalClient, 2026-11-10).
 */
import type { WorklogFileText } from '../../electron/worklog-types';
import type { WeekReport } from '@core/index';
import { canonicalClient, getWeekday } from '@core/index';
import { caseKey, parseWorklog, type WlBlock } from './format';

export interface WeeklyLearn {
  /** 요청자 → 가장 많이 쓴 @CUS */
  contactCus: Map<string, string>;
  /** 고객 토큰 → 가장 많이 쓴 @CUS·@LOC */
  clientDefaults: Map<string, { cus: string; loc: string; count: number }>;
  reports: number;
}

function top(m: Map<string, number>): string {
  let best = '';
  let n = -1;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return best;
}

/** 지난 주간보고에서 요청자별 @CUS와 고객별 기본 @CUS·@LOC를 센다 */
export function learnFromReports(reports: readonly WeekReport[]): WeeklyLearn {
  const byContact = new Map<string, Map<string, number>>();
  const byClient = new Map<string, { cus: Map<string, number>; loc: Map<string, number>; count: number }>();
  const bump = (m: Map<string, number>, k: string) => k && m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of reports) {
    for (const day of r.days) {
      let lastLoc = '';
      for (const block of day.blocks) {
        const loc = block.locations.join(' / ').trim() || (block.inheritLocation ? lastLoc : '');
        if (loc) lastLoc = loc;
        for (const it of block.items) {
          if (!it.client.trim()) continue;
          // 같은 고객사의 다른 표기(ABZ+·AB Z+)는 하나로 센다
          const client = canonicalClient(it.client);
          const c = byClient.get(client) ?? { cus: new Map(), loc: new Map(), count: 0 };
          c.count++;
          bump(c.cus, block.customer.trim());
          bump(c.loc, loc);
          byClient.set(client, c);
          const who = (it.contact ?? '').split('/')[0];
          for (const name of who.split(/\s*[,·]\s*/).map((s) => s.trim()).filter(Boolean)) {
            const m = byContact.get(name) ?? new Map();
            bump(m, block.customer.trim());
            byContact.set(name, m);
          }
        }
      }
    }
  }
  return {
    contactCus: new Map([...byContact].map(([k, m]) => [k, top(m)])),
    clientDefaults: new Map([...byClient].map(([k, v]) => [k, { cus: top(v.cus), loc: top(v.loc), count: v.count }])),
    reports: reports.length,
  };
}

export interface FolderMap {
  folder: string;
  /** @SUM 대괄호 고객 토큰 */
  client: string;
  /** 요청자로 정하지 못할 때의 @CUS */
  cus: string;
  loc: string;
}

/** 폴더 기본값 — 가장 큰 폴더는 지난 보고에서 가장 많이 쓴 고객, 나머지는 사내 */
export function defaultFolderMaps(folders: readonly string[], learn: WeeklyLearn, company: string): FolderMap[] {
  const clients = [...learn.clientDefaults.entries()].sort((a, b) => b[1].count - a[1].count);
  const main = clients.find(([k]) => k !== '사내');
  const inside = learn.clientDefaults.get('사내');
  const insideCus = inside?.cus || `사내 (${company || '회사'})`;
  return folders.map((folder, i) => {
    if (i === 0 && main) return { folder, client: main[0], cus: main[1].cus, loc: main[1].loc };
    return { folder, client: '사내', cus: insideCus, loc: inside?.loc || main?.[1].loc || '' };
  });
}

interface WeeklyItem {
  cus: string;
  loc: string;
  key: string;
  header: string;
  lines: string[];
}

const MEETING_NOTE = /^회의록\s*:/;

function itemLines(b: WlBlock): { lines: string[]; skipped: number } {
  const out: string[] = [];
  for (const n of b.notes) if (!MEETING_NOTE.test(n.text) && n.text.trim()) out.push(`- ${n.text}`);
  for (const f of b.looseFacts) {
    out.push(`- ${f.text}`);
    for (const d of f.details) out.push(`> ${d.text}`);
  }
  for (const a of b.acts) {
    out.push(`- ${a.text}`);
    for (const f of a.facts) {
      out.push(`> ${f.text}`);
      for (const d of f.details) out.push(`> ${d.text}`);
    }
  }
  // 원문 없는 ※(▶ 뒤 상태 메모)는 헤드라인으로, 원문이 있는 전달물은 뺀다
  for (const d of b.deliverables) if (!d.raw.length && d.name.trim()) out.push(`- ${d.name}`);
  return { lines: out.filter((l) => l.replace(/^[->]\s*/, '').trim()), skipped: b.extra.length };
}

function headerOf(b: WlBlock, rawClient: string): string {
  // 저장해 둔 폴더 설정에 옛 표기(ABZ+)가 남아 있어도 표준 표기로 쓴다
  const client = canonicalClient(rawClient);
  let title = b.title.trim();
  if (b.calendar && /회의$/.test(title)) title = `${title} 참석`;
  const who = b.source?.names.join(', ') ?? '';
  const paren = who ? `(${who}${b.source?.channel ? `/${b.source.channel}` : ''}) ` : '';
  return `@SUM [${client}] ${paren}${title}`;
}

function cusOf(b: WlBlock, map: FolderMap, learn: WeeklyLearn): string {
  for (const n of b.source?.names ?? []) {
    const hit = learn.contactCus.get(n);
    if (hit) return hit;
  }
  return map.cus;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export interface BuildWeeklyOptions {
  prevStart: string;
  author: string;
  files: readonly WorklogFileText[];
  maps: readonly FolderMap[];
  learn: WeeklyLearn;
  /** 지금 문서의 @PLAN 줄 (같은 주일 때 그대로 둔다) */
  plans?: readonly string[];
}

export interface BuildWeeklyResult {
  md: string;
  stats: { files: number; items: number; days: number; merged: number; skippedLines: number; unmappedFolders: string[] };
}

export function buildWeeklyMd(o: BuildWeeklyOptions): BuildWeeklyResult {
  const prevEnd = addDays(o.prevStart, 6);
  const curStart = addDays(o.prevStart, 7);
  const curEnd = addDays(o.prevStart, 13);
  const mapOf = new Map(o.maps.map((m) => [m.folder, m]));
  const order = new Map(o.maps.map((m, i) => [m.folder, i]));
  const inWeek = o.files.filter((f) => f.date >= o.prevStart && f.date <= prevEnd);
  const unmapped = [...new Set(inWeek.filter((f) => !mapOf.has(f.folder)).map((f) => f.folder))];
  const lines = [`@PREV ${o.prevStart} ~ ${prevEnd}`, `@CURRENT ${curStart} ~ ${curEnd}`, `@AUTHOR ${o.author.trim() || '작성자'}`];
  for (const p of o.plans ?? []) lines.push(p);
  lines.push('');
  let items = 0;
  let days = 0;
  let merged = 0;
  let skippedLines = 0;

  for (let i = 0; i < 7; i++) {
    const date = addDays(o.prevStart, i);
    lines.push(`# ${date}(${getWeekday(date)})`);
    const dayFiles = inWeek
      .filter((f) => f.date === date && mapOf.has(f.folder))
      .sort((a, b) => (order.get(a.folder) ?? 0) - (order.get(b.folder) ?? 0));
    const dayItems: WeeklyItem[] = [];
    for (const f of dayFiles) {
      const map = mapOf.get(f.folder)!;
      for (const b of parseWorklog(f.text).blocks) {
        if (!b.title.trim()) continue;
        const { lines: body, skipped } = itemLines(b);
        skippedLines += skipped;
        const key = `${map.client}\u0000${caseKey(b)}`;
        const same = dayItems.find((it) => it.key === key);
        if (same && (b.followup || !body.length || same.header === headerOf(b, map.client))) {
          same.lines.push(...body);
          merged++;
          continue;
        }
        dayItems.push({ cus: cusOf(b, map, o.learn), loc: map.loc, key, header: headerOf(b, map.client), lines: body });
      }
    }
    if (dayItems.length === 0) {
      if (i >= 5) lines.push('@HOLIDAY');
      lines.push('');
      continue;
    }
    days++;
    // 지원장소별로, 그 안에서 같은 @CUS끼리 처음 나온 순서대로 — 장소마다 @LOC 한 번, 같은 장소의 다음 묶음은
    // 빈 줄 뒤 @CUS로 장소를 이어받는다. 전에는 그날 첫 묶음의 @LOC만 써서, 고객 폴더와 사내 폴더가 같은 날
    // 있으면 사내 작업이 고객사 지원장소에서 한 것으로 나갔다(폴더별 지원장소 설정이 버려짐)
    const byLoc = new Map<string, Map<string, WeeklyItem[]>>();
    for (const it of dayItems) {
      const cusMap = byLoc.get(it.loc) ?? new Map<string, WeeklyItem[]>();
      cusMap.set(it.cus, [...(cusMap.get(it.cus) ?? []), it]);
      byLoc.set(it.loc, cusMap);
    }
    let first = true;
    for (const [loc, cusMap] of byLoc) {
      let firstInLoc = true;
      for (const [cus, list] of cusMap) {
        if (!first) lines.push('');
        if (firstInLoc) lines.push(`@LOC ${loc}`.trimEnd());
        lines.push(`@CUS ${cus}`.trimEnd());
        for (const it of list) {
          lines.push(it.header, ...it.lines);
          items++;
        }
        first = false;
        firstInLoc = false;
      }
    }
    lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { md: `${lines.join('\n')}\n`, stats: { files: inWeek.length, items, days, merged, skippedLines, unmappedFolders: unmapped } };
}

/** 오늘 기준 지난 주 월요일 */
export function lastMonday(today = new Date()): string {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 아무 날짜 → 그 주 월요일 */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return addDays(iso, -((dt.getDay() + 6) % 7));
}
