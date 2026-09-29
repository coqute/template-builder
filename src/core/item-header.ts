/**
 * 항목 머리 `[고객사] (괄호 정보) 제목` 해석·출력 단일 소스 — parser·importer·serializer·renderer 공용.
 * 형식 명세: 주간보고 형식 명세 §4.1
 *
 * - 원격 대응: `[MX] (담당자/채널) 제목` — 채널이 표준 어휘일 때만 담당자·채널로 나눈다
 * - 현장 방문: `[MX] (건물) (담당자) 제목` — 괄호 둘이 이어지면 첫째가 건물
 *              `[MX] (건물) 제목` — 괄호 하나가 지원장소의 건물명과 같으면 건물
 * - 그 외 괄호 하나: 담당자(사람·팀)
 */
import type { ClientItem } from './types';
import { buildingOf, KNOWN_CHANNELS, normalizeChannelValue } from './types';

export type ItemHeader = Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>;

export interface HeaderIssue {
  severity: 'warning' | 'info';
  code: string;
  message: string;
  hint?: string;
}

const RE_HEAD = /^\[([^\]]*)\]\s*(.*)$/;
const RE_PAREN = /^\(([^()]*)\)\s*/;

/** v0.3.x 새 주간보고 골격의 자리 문구 (값으로 저장되어 있던 형태) */
const LEGACY_PLACEHOLDER = '[고객사] (담당자/메일) 제목';

/** 제목이 `(`로 시작하면 괄호 정보(건물·담당자)로 읽히므로 저장 시 `\(`로 고정한다 — 읽을 때 되돌림 */
function unescapeTitle(s: string): string {
  const t = s.trim();
  return t.startsWith('\\(') ? t.slice(1) : t;
}

/** 괄호 안 `A/B` → 담당자·채널. B가 표준 채널이 아니면 나누지 않고 원문을 담당자로 보존 */
function parseContact(raw: string, issues: HeaderIssue[]): Pick<ClientItem, 'contact' | 'channel'> {
  const s = raw.trim();
  const idx = s.indexOf('/');
  if (idx < 0) return s ? { contact: s } : {};
  const a = s.slice(0, idx).trim();
  const b = s.slice(idx + 1).trim();
  const ch = normalizeChannelValue(b);
  if (ch.known) {
    if (ch.normalized) {
      issues.push({ severity: 'info', code: 'channel-normalized', message: `채널 "${b}"를 "${ch.value}"로 정규화했습니다.` });
    }
    return a ? { contact: a, channel: ch.value } : { channel: ch.value };
  }
  issues.push({
    severity: 'warning',
    code: 'unknown-channel',
    message: `괄호 (${s})의 "${b}"는 표준 채널(${KNOWN_CHANNELS.join('·')})이 아니어서 담당자로 보존합니다.`,
    hint: '원격 대응은 (담당자/채널), 현장 방문은 (건물) (담당자)로 나눠 쓰세요.',
  });
  return { contact: s };
}

/**
 * @param locations 이 항목이 속한 행의 지원장소 — `MX(누리사옥)`의 건물명으로 `(누리사옥)`을 건물로 인식
 */
export function parseItemHeader(text: string, locations: readonly string[] = []): { header: ItemHeader; issues: HeaderIssue[] } {
  const issues: HeaderIssue[] = [];
  // `@SUM` 단독 — 아직 쓰지 않은 골격 항목 (경고 없음).
  // v0.3.x 새 주간보고가 값으로 넣던 자리 문구도 빈 골격으로 읽는다 — 예전 초안·파일이 그대로 메일에 나가지 않게
  if (!text.trim() || text.trim() === LEGACY_PLACEHOLDER) return { header: { client: '', workType: '' }, issues };
  const m = RE_HEAD.exec(text.trim());
  if (!m) {
    issues.push({
      severity: 'warning',
      code: 'sum-no-bracket',
      message: `@SUM에 [고객사] 표기가 없습니다: ${text.slice(0, 40)}`,
      hint: '`@SUM [고객사] (담당자/채널) 제목` 형식을 권장합니다.',
    });
    return { header: { client: '', workType: text.trim() }, issues };
  }
  const client = m[1].trim();
  let rest = m[2];
  const g1 = RE_PAREN.exec(rest);
  if (!g1) return { header: { client, workType: unescapeTitle(rest) }, issues };
  const first = g1[1].trim();
  const afterFirst = rest.slice(g1[0].length);
  const g2 = first.includes('/') ? null : RE_PAREN.exec(afterFirst);

  let header: ItemHeader;
  if (g2) {
    // (건물) (담당자[/채널]) — 현장 방문
    rest = afterFirst.slice(g2[0].length);
    header = { client, ...(first ? { site: first } : {}), ...parseContact(g2[1], issues), workType: unescapeTitle(rest) };
  } else {
    rest = afterFirst;
    const buildings = locations.map((l) => buildingOf(l)).filter((b): b is string => !!b);
    if (first && !first.includes('/') && (buildings.includes(first) || locations.includes(first))) {
      header = { client, site: first, workType: unescapeTitle(rest) };
    } else {
      header = { client, ...parseContact(first, issues), workType: unescapeTitle(rest) };
    }
  }
  return { header, issues };
}

export interface FormatHeaderOptions {
  /** .md 저장용 — `(`로 시작하는 제목을 `\(`로 고정 (표 출력에는 쓰지 않음) */
  escapeTitle?: boolean;
  /** 머리가 모두 비면 `[]` 대신 빈 문자열 (골격 항목을 `@SUM` 단독으로 저장) */
  blankAsEmpty?: boolean;
}

/** 항목 머리 출력 — `[고객사] (건물) (담당자/채널) 제목` (빈 부분 생략) */
export function formatItemHeader(h: ItemHeader, opts: FormatHeaderOptions = {}): string {
  if (opts.blankAsEmpty && !h.client.trim() && !h.site && !h.contact && !h.channel && !h.workType.trim()) {
    return '';
  }
  const parts = [`[${h.client}]`];
  if (h.site) parts.push(`(${h.site})`);
  if (h.contact || h.channel) {
    const who = h.contact ?? '';
    parts.push(h.channel ? `(${who}/${h.channel})` : `(${who})`);
  }
  const head = parts.join(' ');
  const title = opts.escapeTitle && h.workType.startsWith('(') ? `\\${h.workType}` : h.workType;
  return title ? `${head} ${title}` : head;
}
