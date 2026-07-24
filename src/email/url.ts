/**
 * 링크 삽입용 URL 정규화 — 사용자가 스킴 없이 입력한 도메인/이메일을 클릭 가능한 URL로 보정.
 * 최종 보안 게이트는 sanitize.ts의 isSafeHref (http/https/mailto/# 만 허용) — 여기서는 흔한 유효 입력을
 * 그 허용 범위로 끌어올리고, 지원하지 않는(위험) 스킴은 '' 로 반환해 애초에 링크를 만들지 않는다.
 */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  // 이미 안전 스킴 — 그대로 (대소문자 무관: isSafeHref가 lower-case 비교)
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  // 페이지 내 앵커
  if (v.startsWith('#')) return v;
  // 스킴 없는 이메일 주소 → mailto:
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(v)) return `mailto:${v}`;
  // 명시적 스킴 형태인가? (RFC 3986: ALPHA *(ALPHA/DIGIT/+/-/.))
  const m = v.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  if (m) {
    const scheme = m[1];
    const rest = m[2];
    const schemeHasDot = scheme.includes('.'); // example.com:8080 → 스킴이 아니라 호스트
    const isHostPort = /^\d+([/?#]|$)/.test(rest); // localhost:3000, host:8080/path → 포트
    if (schemeHasDot || isHostPort) return `https://${v}`; // authority → https 부착
    // 진짜 스킴이지만 http/https/mailto 아님 (javascript:, data:, vbscript:, tel:, ftp: 등)
    // → 지원하지 않음. 위험 href를 라이브 DOM에 넣지 않도록 링크 생성 자체를 막는다.
    return '';
  }
  // 스킴 없음 → 도메인/경로로 간주하고 https 부착 (www.example.com, docs.example.com/guide 등)
  return `https://${v}`;
}
