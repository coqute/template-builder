/**
 * 주간보고서 DSL 문법 단일 소스 (Grammar Registry).
 * parser(정밀 캡처) · importer(재인식) · CodeMirror(하이라이트)가 이 테이블 하나를 공유한다.
 * 새 토큰 추가/변경 = 이 파일 1곳 수정. 동형성은 tests/grammar-iso.test.ts가 고정한다.
 */

/** 유연 날짜 조각 — ISO 외 점(.)·슬래시(/) 구분자, 한 자리 월·일 (파서가 ISO로 정규화) */
export const DATE_FLEX_SRC = String.raw`\d{4}[-./]\d{1,2}[-./]\d{1,2}`;

/** 파서/임포터용 정밀(캡처) 정규식 */
export const GRAMMAR = {
  prev: new RegExp(`^@(?:PREV|WEEK)\\s+(${DATE_FLEX_SRC})\\s*~\\s*(${DATE_FLEX_SRC})\\s*$`),
  current: new RegExp(`^@(?:CURRENT|NEXT)\\s+(${DATE_FLEX_SRC})\\s*~\\s*(${DATE_FLEX_SRC})\\s*$`),
  author: /^@AUTHOR\s+(.+?)\s*$/,
  /** 일자 행 — `#` 뒤 공백 생략·요일 생략 허용 (요일 없으면 파서가 자동 보충) */
  day: new RegExp(`^#\\s*(${DATE_FLEX_SRC})\\s*(?:\\(([^)]*)\\))?\\s*$`),
  loc: /^@LOC\s+(.+?)\s*$/,
  cus: /^@CUS\s+(.+?)\s*$/,
  holiday: /^@HOLIDAY(?:\s+(.*))?\s*$/,
  /** @SUM (신규) 또는 ## (legacy) — 두 형식 모두 인식 */
  client: /^(?:@SUM|##)\s+(.+?)\s*$/,
  num: /^(\d+)\)\s*(.*?)\s*$/,
  dash: /^-\s+(.*?)\s*$/,
  qaQ: /^<-\s*(.*?)\s*$/,
  qaA: /^->\s*(.*?)\s*$/,
  /** `>` 보조 설명(노트) — NOTE_PREFIX 접두로 in-band 저장 */
  note: /^>\s?(.*?)\s*$/,
  // @SUM 헤더 3종 — workType 빈 문자열 허용 (`(.*?)`), 비면 validator가 warning
  clientChannel: /^\[([^\]]+)\]\s*\(([^)/]+)\/([^)]+)\)\s*(.*?)\s*$/,
  clientNew: /^\[([^\]]+)\]\s*\(([^)/]+)\)\s*(.*?)\s*$/,
  clientBare: /^\[([^\]]+)\]\s*(.*?)\s*$/,
} as const;

/**
 * 에디터 하이라이트용 관용 규칙 — 본문 트레일링을 선택(`(?:\s.*)?`)으로 완화해
 * 타이핑 중(디렉티브만 입력된 상태)에도 즉시 칠해진다.
 * 불변식: 파서(GRAMMAR)가 수용하는 라인은 반드시 여기서도 매치된다 (동형성 테스트 고정).
 */
export const HIGHLIGHT_RULES: ReadonlyArray<{ re: RegExp; cls: string }> = [
  { re: /^@(?:PREV|WEEK)(?:\s.*)?$/, cls: 'tok-week' },
  { re: /^@(?:CURRENT|NEXT)(?:\s.*)?$/, cls: 'tok-next' },
  { re: /^@AUTHOR(?:\s.*)?$/, cls: 'tok-author' },
  // 일자 행은 GRAMMAR.day와 동일 날짜 조각에서 파생 (요일 캡처만 제외)
  { re: new RegExp(`^#\\s*${DATE_FLEX_SRC}\\s*(?:\\([^)]*\\))?\\s*$`), cls: 'tok-day' },
  { re: /^@LOC(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@CUS(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@SUM(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^##(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^@HOLIDAY(?:\s.*)?$/, cls: 'tok-holiday' },
  { re: /^\d+\)(?:\s.*)?$/, cls: 'tok-num' },
  { re: /^-(?:\s.*)?$/, cls: 'tok-dash' },
  { re: /^<-(?:\s.*)?$/, cls: 'tok-qaq' },
  { re: /^->(?:\s.*)?$/, cls: 'tok-qaa' },
  { re: /^>(?:\s.*)?$/, cls: 'tok-note' },
];

/** 라인에 매치되는 하이라이트 클래스 (없으면 undefined) — 에디터·동형성 테스트 공용 */
export function highlightClassFor(lineText: string): string | undefined {
  for (const rule of HIGHLIGHT_RULES) {
    if (rule.re.test(lineText)) return rule.cls;
  }
  return undefined;
}
