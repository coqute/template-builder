/**
 * 앱이 바깥 브라우저로 열어도 되는 주소 — Gmail(임시보관함)과 Google 달력뿐이다.
 * main 전용이지만 Electron에 기대지 않아 테스트에서 바로 쓴다.
 *
 * renderer가 넘긴 주소를 그대로 열면 피싱·임의 주소로 나갈 수 있다. 글자 앞부분이 아니라 주소를 풀어
 * 프로토콜·호스트·경로를 통째로 견준다(`https://mail.google.com.example/…` 같은 것이 지나가지 않게).
 *
 * 2026-11-24: 전에는 Gmail 주소만 통과시켜, 홈의 "달력에서 열기"와 ⋯ "Google 달력 열기"가 아무 일도 하지 않았다.
 */
const ANY_PATH_HOSTS = new Set(['mail.google.com', 'calendar.google.com']);

export function isAllowedExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 4000) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (ANY_PATH_HOSTS.has(u.hostname)) return true;
  // 달력이 일정마다 주는 링크(htmlLink)는 `https://www.google.com/calendar/event?eid=…` 모양이다
  return u.hostname === 'www.google.com' && u.pathname.startsWith('/calendar/');
}
