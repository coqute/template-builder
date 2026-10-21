/** 작업일지 전체 검색·자동완성 어휘 — 수백 개 파일(수 MB)까지 메모리에서 바로 찾는다 */
import type { WorklogFileText } from '../../electron/worklog-types';
import { parseWorklog } from './format';

export interface SearchLine {
  no: number;
  text: string;
  /** 일치 구간 [시작, 끝) */
  ranges: Array<[number, number]>;
}

export interface SearchHit {
  folder: string;
  name: string;
  date: string;
  title: string;
  lines: SearchLine[];
  /** 파일 안 일치 줄 수 */
  total: number;
}

/** "따옴표 묶음"은 한 낱말로 */
export function searchTerms(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return [...new Set(out)];
}

function rangesOf(text: string, terms: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const out: Array<[number, number]> = [];
  for (const t of terms) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) out.push([i, i + t.length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 모든 낱말이 들어 있는 파일 — 최신순. 파일마다 낱말이 많이 든 줄부터 최대 perFile줄 */
export function searchWorklogs(files: WorklogFileText[], query: string, limit = 60, perFile = 4): SearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const f of files) {
    const hay = `${f.title}\n${f.text}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const scored: Array<SearchLine & { score: number }> = [];
    f.text.split('\n').forEach((text, i) => {
      const lower = text.toLowerCase();
      const score = terms.filter((t) => lower.includes(t)).length;
      if (score > 0) scored.push({ no: i + 1, text, ranges: rangesOf(text, terms), score });
    });
    const lines = [...scored]
      .sort((a, b) => b.score - a.score || a.no - b.no)
      .slice(0, perFile)
      .sort((a, b) => a.no - b.no)
      .map(({ score: _s, ...l }) => l);
    hits.push({ folder: f.folder, name: f.name, date: f.date, title: f.title, lines, total: scored.length });
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface Vocabulary {
  /** 요청자 — 많이 쓴 순 */
  requesters: Array<{ name: string; count: number }>;
  channels: Array<{ name: string; count: number }>;
}

const DEFAULT_CHANNELS = ['메신저', '메일', '유선', '카톡', '현장'];

/** 모든 일지의 `■ (요청자/채널)`에서 요청자·채널 어휘를 모은다 */
export function collectVocabulary(files: Array<{ text: string }>): Vocabulary {
  const who = new Map<string, number>();
  const ch = new Map<string, number>();
  for (const f of files) {
    for (const b of parseWorklog(f.text).blocks) {
      if (!b.source) continue;
      for (const n of b.source.names) if (n.length <= 20) who.set(n, (who.get(n) ?? 0) + 1);
      if (b.source.channel && b.source.channel.length <= 12) ch.set(b.source.channel, (ch.get(b.source.channel) ?? 0) + 1);
    }
  }
  for (const c of DEFAULT_CHANNELS) if (!ch.has(c)) ch.set(c, 0);
  const sorted = (m: Map<string, number>) =>
    [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { requesters: sorted(who), channels: sorted(ch) };
}
