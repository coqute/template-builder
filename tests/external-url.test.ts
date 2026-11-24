// @vitest-environment node
/**
 * 바깥 브라우저로 여는 주소의 허용 목록(electron/external-url.ts).
 * 2026-11-24까지는 Gmail 주소만 통과해 홈의 "달력에서 열기"·"Google 달력 열기"가 아무 일도 하지 않았다.
 */
import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../electron/external-url';

describe('isAllowedExternalUrl', () => {
  it('Gmail 임시보관함과 Google 달력 주소를 연다', () => {
    for (const url of [
      'https://mail.google.com/mail/u/0/#drafts',
      'https://calendar.google.com/calendar/',
      'https://calendar.google.com/calendar/u/0/r/week',
      // 달력이 일정마다 주는 링크(htmlLink)
      'https://www.google.com/calendar/event?eid=YWJjZGVmZyBob25nQGV4YW1wbGUuY29t&ctz=Asia/Seoul',
      'https://calendar.google.com/calendar/event?eid=YWJjZGVmZw',
    ]) {
      expect([url, isAllowedExternalUrl(url)]).toEqual([url, true]);
    }
  });

  it('그 밖의 주소는 열지 않는다 — 비슷하게 생긴 호스트, 다른 경로, 다른 프로토콜', () => {
    for (const url of [
      'https://www.google.com/search?q=calendar',
      'https://www.google.com/calendarx/event',
      'https://www.google.com/',
      'https://mail.google.com.example.com/mail/',
      'https://calendar.google.com.example.com/calendar/',
      'https://example.com/calendar/event?eid=1',
      'https://evil.example/?https://calendar.google.com/calendar/',
      // 사용자 정보가 붙은 주소 — 공개 검사가 메일 주소 모양으로 읽지 않게 골뱅이를 이어 붙인다
      ['https://user:pw', 'calendar.google.com/calendar/'].join('@'),
      'https://calendar.google.com:8443/calendar/',
      'http://calendar.google.com/calendar/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'calendar.google.com/calendar/',
      '',
    ]) {
      expect([url, isAllowedExternalUrl(url)]).toEqual([url, false]);
    }
  });

  it('글자가 아니거나 지나치게 긴 값은 열지 않는다', () => {
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl({ href: 'https://calendar.google.com/' })).toBe(false);
    expect(isAllowedExternalUrl(`https://calendar.google.com/calendar/?x=${'a'.repeat(5000)}`)).toBe(false);
  });
});
