/**
 * 이 앱을 쓰는 곳에 맞춘 실제 값 — 코드 안의 실제 값(회사·고객사 표기·Gmail 자격증명 폴더)은 이 파일에만 둔다.
 * 그 밖의 예시·테스트·문서는 합성 값을 쓴다. 이메일 서식의 실제 받는 사람·참조 주소는 src/email/builtin/tech-inquiry.json에 있다.
 *
 * - 앱은 REAL_SITE를 쓴다. 테스트는 tests/setup-site.ts가 EXAMPLE_SITE로 바꿔 돌린다(테스트에 실제 값을 쓰지 않게).
 * - 공개 사본은 아래 `실제 값` 블록을 `const REAL_SITE: SiteConfig = EXAMPLE_SITE;` 한 줄로 갈아 끼운다.
 * - tests/site-config.test.ts가 실제 값이 이 파일과 서식 파일 밖으로 새지 않았는지 확인한다.
 * main(electron)·renderer·scripts/verify-weekly.mjs가 함께 읽는다 — 다른 모듈을 import하지 않는다.
 */

/** 같은 고객사의 여러 표기 — 비교·표준 표기·작업일지 폴더 판별에 쓴다 */
export interface CustomerAlias {
  /** 표준 표기 — 항목 `[고객사]`에 쓰는 모양 */
  canonical: string;
  /** 비교 키(customerKey 결과)로 모을 값 */
  key: string;
  /** customerKey(공백·점 제거, 소문자) 뒤의 문자열에서 다른 표기를 찾는 식 — g 플래그 */
  pattern: RegExp;
  /** 표준 표기가 아닌 옛 표기 — 주간보고 검증 스크립트가 고치라고 알린다 */
  oldTokens: readonly string[];
}

export interface SiteConfig {
  /** 회사 이름 기본값(프로필이 비었을 때)·AI 지침의 소속 */
  company: string;
  /** 예전 기본값 — 사용자가 바꾸지 않고 저장된 값이면 새 기본값으로 옮긴다 */
  legacyCompany: string;
  customers: readonly CustomerAlias[];
  /** 머리 괄호에 담당자 대신 팀명을 쓴 것으로 보는 낱말 — 주간보고 검증 스크립트 */
  teamHint: RegExp;
  /** Gmail OAuth 자격증명 폴더 — 홈 폴더 기준 경로(oauth-client.json·token.json을 읽기만 한다) */
  gmailCredDir: string;
  /**
   * 메일 본문을 거르는 도구(sanitizer) — 메일을 앱 밖(AI)으로 보내기 전에 반드시 이 도구를 거친다. 없으면 메일 본문을 읽지 않는다.
   * `root`는 그 도구의 폴더(홈 폴더 기준), `entry`는 그 안의 모듈(`sanitizeDeep`를 내보내는 파일).
   * 앱은 그 도구가 도는 방식 그대로(node + tsx) 불러 쓴다 — 규칙을 옮겨 적지 않으므로 도구의 규칙이 바뀌면 바로 따라간다.
   */
  mailSanitizer: { root: string; entry: string };
}

/** 예시 값 — 테스트·문서·공개 사본용. 실제 값과 같은 모양을 유지한다 */
export const EXAMPLE_SITE: SiteConfig = {
  company: '예시IT',
  legacyCompany: '예시아이티',
  customers: [
    {
      canonical: 'AB Z+',
      key: 'abz+',
      pattern: /ab제트플러스|abz\+|제트플러스|(?<![a-z])z\+/g,
      oldTokens: ['ABZ+', '제트플러스', 'AB제트플러스', 'AB 제트플러스', 'Z+'],
    },
  ],
  teamHint: /SRE|NMS|IDC|개발팀$|^현장$/,
  gmailCredDir: '.template-builder/gmail-credentials',
  mailSanitizer: { root: '.template-builder/mail-sanitizer', entry: 'engine.ts' },
};

const REAL_SITE: SiteConfig = EXAMPLE_SITE;

let current: SiteConfig = REAL_SITE;

export function site(): SiteConfig {
  return current;
}

/** 실제 값 — 실제 값이 이 파일 밖으로 새지 않았는지 확인하는 테스트만 쓴다 */
export function realSite(): SiteConfig {
  return REAL_SITE;
}

/** 쓰는 값을 바꾼다 — 테스트 준비(tests/setup-site.ts)용 */
export function setSiteConfig(next: SiteConfig): void {
  current = next;
}
