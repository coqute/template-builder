/**
 * AI 정돈 마스킹 — 외부로 나가기 전에 IP·URL·메일 주소·전화번호·키/라이선스 문자열을 자리표시로 바꾸고,
 * 돌아온 글에서 원래 값으로 되돌린다. 같은 값은 같은 자리표시를 쓴다(문맥 유지).
 * 자리표시 모양: ⟦IP1⟧ ⟦URL2⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ — 이미지·표·코드 블록용 ⟦IMG1⟧ 등은 호출부가 쓴다.
 */

export type MaskKind = 'URL' | 'MAIL' | 'IP' | 'TEL' | 'KEY';

// 순서가 중요하다 — URL 안의 IP·메일, 메일 안의 도메인을 먼저 통째로 잡는다
const PATTERNS: Array<{ kind: MaskKind; re: RegExp }> = [
  { kind: 'URL', re: /\b(?:https?|ftp):\/\/[^\s<>"'`)\]]+/gi },
  { kind: 'MAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  // IPv4 (+포트·CIDR)
  { kind: 'IP', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?:\/\d{1,2})?(?![\d.])/g },
  { kind: 'TEL', re: /(?<!\d)0\d{1,2}-\d{3,4}-\d{4}(?!\d)/g },
  // UUID
  { kind: 'KEY', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // 라이선스형 — 대문자·숫자 4~6자 묶음이 하이픈으로 4개 이상
  { kind: 'KEY', re: /\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){3,}\b/g },
  // 제조사 라이선스·액세스 키형 — 소문자·숫자 10자 이상 묶음이 하이픈으로 3개 이상(숫자 포함).
  // 위 두 꼴(대문자 4~6자 묶음, 하이픈 없는 24자)에 걸리지 않아 그대로 나가던 모양이다.
  // 버전·파일명(job-manager-x.y.z)은 묶음이 짧거나 점·밑줄이 있어 걸리지 않는다
  { kind: 'KEY', re: /\b(?=[a-z0-9-]*\d)[a-z0-9]{10,}(?:-[a-z0-9]{10,}){2,}\b/gi },
  // 토큰·키형 — 글자와 숫자가 섞인 24자 이상 덩어리(하이픈·밑줄 없음 → 버전·파일명은 걸리지 않는다)
  { kind: 'KEY', re: /(?<![A-Za-z0-9+/=_.-])(?=[A-Za-z0-9+/=]*\d)(?=[A-Za-z0-9+/=]*[A-Za-z])[A-Za-z0-9+/=]{24,}(?![A-Za-z0-9+/=_-])/g },
];

const TOKEN_RE = /⟦[A-Z]+\d+⟧/g;

export class Masker {
  private byValue = new Map<string, string>();
  private byToken = new Map<string, string>();
  private counts: Record<string, number> = {};

  /** 글 안의 민감 값을 자리표시로 */
  mask(text: string): string {
    let out = text;
    for (const { kind, re } of PATTERNS) {
      out = out.replace(re, (m) => (m.includes('⟦') ? m : this.tokenFor(kind, m)));
    }
    return out;
  }

  /** 자리표시를 원래 값으로 — 모르는 자리표시는 그대로 둔다(검증에서 걸러진다) */
  unmask(text: string): string {
    return text.replace(TOKEN_RE, (t) => this.byToken.get(t) ?? t);
  }

  /** 임의 값(이미지·표 원본 등)에 자리표시를 붙인다 */
  reserve(kind: string, value: string): string {
    return this.tokenFor(kind, value);
  }

  original(token: string): string | undefined {
    return this.byToken.get(token);
  }

  /** 종류별 가린 개수 — 확인 창에 "IP 2·URL 1 가림"으로 보여 준다 */
  summary(): Record<string, number> {
    return { ...this.counts };
  }

  private tokenFor(kind: string, value: string): string {
    const hit = this.byValue.get(`${kind}\u0000${value}`);
    if (hit) return hit;
    const n = (this.counts[kind] ?? 0) + 1;
    this.counts[kind] = n;
    const token = `⟦${kind}${n}⟧`;
    this.byValue.set(`${kind}\u0000${value}`, token);
    this.byToken.set(token, value);
    return token;
  }
}

/** 글에 든 자리표시 목록(중복 포함, 정렬) — 바뀌기 전·후 비교용 */
export function tokensOf(text: string): string[] {
  return (text.match(TOKEN_RE) ?? []).sort();
}

export function sameTokens(a: string, b: string): boolean {
  const x = tokensOf(a);
  const y = tokensOf(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * 숫자가 든 낱말(버전·수치·날짜·시간)은 사실이다 — 다듬은 글에서 빠졌으면 그 변경을 받지 않는다.
 * 띄어쓰기 차이("30일" ↔ "30 일")는 허용.
 */
export function missingFacts(before: string, after: string): string[] {
  const squash = (s: string) => s.replace(/\s+/g, '');
  const target = squash(after);
  const facts = before.replace(TOKEN_RE, ' ').match(/[0-9][0-9A-Za-z.:%/_-]*/g) ?? [];
  return [...new Set(facts)].filter((f) => !target.includes(squash(f.replace(/[.:_/-]+$/, ''))));
}
