/**
 * 메일 후보 추리기 — 찾은 스레드 가운데 이 할 일의 사안과 가까운 것을 앞에 세운다.
 *
 * 메일을 하나로 특정할 값(식별값)은 일지에 없다. 그 대신 할 일이 가진 단서로 후보를 줄인다:
 *  - 제목이 사안·할 일의 제목과 겹치는가 (가장 큰 단서)
 *  - 사안이 일지에 적힌 날(또는 그 무렵)에 오간 메일인가
 *  - 제목에 고객사가 들어 있는가
 *  - 요청자가 보낸 메일인가, 내가 회신했는가, 최근에 오갔는가
 *  - 메모·이전 기록의 낱말이 제목에 있는가
 * 규칙만 쓴다 — AI를 부르지 않고, 제목과 이름은 화면에서만 본다(밖으로 나가지 않는다).
 * 틀릴 수 있으므로 걸러 내지 않고 순서만 바꾼다: 가까운 것을 먼저 보이고 나머지는 접어 둔다.
 */
import { customerKey } from '../core/customer';
import { diffDays, md } from './dates';
import type { MailThreadInfo } from './types';

export interface MailHint {
  /** 사안의 제목과 할 일의 제목 */
  titles: readonly string[];
  /** 메모와 이전 기록 — 보조 단서 */
  notes: readonly string[];
  /** 고객사·구분 (없으면 '') */
  client: string;
  /** 요청자 이름들 */
  who: readonly string[];
  /** 사안이 일지에 적힌 날들 YYYY-MM-DD */
  caseDates: readonly string[];
  today: string;
}

export interface RankedThread extends MailThreadInfo {
  score: number;
  /** 가깝다고 본 까닭 — 화면에 보인다 */
  why: string[];
  /** 이 사안을 가리키는 단서가 있는가 — 제목·메모의 낱말, 사안이 적힌 날. 요청자·고객사·내 회신은 찾은 메일 대부분에 해당해 가르지 못한다 */
  pointed: boolean;
}

/** 이 점수부터 "사안과 가까운 메일"로 먼저 보인다 */
export const LIKELY_SCORE = 4;
/** 미리 골라 둘 만큼 뚜렷한가 — 이 점수 이상이고 다음 후보와 이만큼 벌어져 있을 때 */
const PICK_SCORE = 7;
const PICK_GAP = 3;

/** 제목마다 흔히 나와 가르는 데 쓸모없는 낱말 */
const COMMON = new Set([
  're', 'fw', 'fwd', '답장', '전달', '회신', '문의', '요청', '관련', '확인', '안내', '공유', '부탁', '드립니다', '건', '및', '대한', '대해', '관련하여',
  '진행', '예정', '완료', '처리', '답변', '질문', '내용', '사항', '방법', '여부', '가능', '후속', '메일', '원인',
]);
const PARTICLE = '(?:으로|에서|에게|까지|부터|은|는|이|가|을|를|의|에|와|과|도|로)';
const PARTICLE_RE = new RegExp(`${PARTICLE}$`);
/** 영문·숫자 뒤에 바로 붙은 조사 — "2.9.5로", "agent를" */
const GLUED_PARTICLE_RE = new RegExp(`^([0-9a-z+._-]*[0-9a-z])${PARTICLE}$`);

/** 견줄 낱말 — 소문자, 두 글자 이상, 흔한 낱말 제외. 세 글자 이상인 한글 낱말과 영문·숫자 낱말은 끝의 조사를 뗀다 */
export function hintWords(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of texts.join(' ').toLowerCase().split(/[^0-9a-z가-힣+._-]+/)) {
    let w = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (/^[가-힣]{3,}$/.test(w)) w = w.replace(PARTICLE_RE, '');
    else w = w.replace(GLUED_PARTICLE_RE, '$1');
    if (w.length >= 2 && !COMMON.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** 스레드 하나의 점수와 까닭 */
export function scoreThread(t: MailThreadInfo, hint: MailHint): RankedThread {
  const subject = squash(t.subject);
  const why: string[] = [];
  let score = 0;

  const titleWords = hintWords(hint.titles);
  const titleHits = titleWords.filter((w) => subject.includes(w));
  if (titleHits.length) {
    score += Math.min(3, titleHits.length) * 3;
    why.push(`제목이 겹침: ${titleHits.slice(0, 3).join(' · ')}`);
  }
  const noteHits = hintWords(hint.notes).filter((w) => !titleWords.includes(w) && subject.includes(w));
  if (noteHits.length) {
    score += Math.min(3, noteHits.length);
    why.push(`메모·기록의 낱말: ${noteHits.slice(0, 3).join(' · ')}`);
  }

  const sameDay = hint.caseDates.find((d) => t.days.includes(d));
  if (sameDay) {
    score += 4;
    why.push(`사안이 일지에 적힌 날(${md(sameDay)})의 메일`);
  } else if (hint.caseDates.some((d) => t.days.some((x) => Math.abs(diffDays(d, x)) <= 1))) {
    score += 2;
    why.push('사안이 적힌 날 무렵의 메일');
  }
  const pointed = why.length > 0;

  const client = customerKey(hint.client);
  if (client && client !== '-' && customerKey(t.subject).includes(client)) {
    score += 2;
    why.push('제목에 고객사');
  }
  if (hint.who.some((n) => n.trim().length >= 2 && t.from.includes(n.trim()))) {
    score += 1;
    why.push('요청자가 보낸 메일');
  }
  if (t.mine) score += 1; // 줄에 "내 회신 있음"으로 이미 보인다
  if (t.date && Math.abs(diffDays(hint.today, t.date)) <= 3) score += 1;

  return { ...t, score, why, pointed };
}

/** 가까운 것부터 — 점수가 같으면 최근 것이 먼저 */
export function rankThreads(threads: readonly MailThreadInfo[], hint: MailHint): RankedThread[] {
  return threads.map((t) => scoreThread(t, hint)).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
}

/**
 * 먼저 보일 것과 접어 둘 것.
 * 사안을 가리키는 단서(제목·메모의 낱말, 사안이 적힌 날)가 있는 메일이 하나라도 있으면 그런 메일만 먼저 보인다 —
 * 요청자로 찾은 목록이라 "같은 고객사·같은 요청자"만으로는 줄어들지 않기 때문이다.
 * 그런 메일이 하나도 없을 때에만 고객사·요청자로 기준 점수를 넘은 것을 먼저 보인다.
 */
export function splitLikely(ranked: readonly RankedThread[]): { likely: RankedThread[]; rest: RankedThread[] } {
  const anyPointed = ranked.some((t) => t.pointed && t.score >= LIKELY_SCORE);
  const isLikely = (t: RankedThread) => t.score >= LIKELY_SCORE && (!anyPointed || t.pointed);
  return { likely: ranked.filter(isLikely), rest: ranked.filter((t) => !isLikely(t)) };
}

/** 미리 골라 둘 스레드 — 하나가 뚜렷이 앞설 때만. 아니면 null(사용자가 고른다) */
export function confidentPick(ranked: readonly RankedThread[]): RankedThread | null {
  const [top, next] = ranked;
  if (!top || top.score < PICK_SCORE) return null;
  return (next?.score ?? 0) <= top.score - PICK_GAP ? top : null;
}
