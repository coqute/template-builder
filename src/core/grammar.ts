/**
 * 주간보고서 DSL 문법 단일 소스 (Grammar Registry).
 * parser(정밀 캡처) · importer(재인식) · CodeMirror(하이라이트)가 이 테이블 하나를 공유한다.
 * 새 토큰 추가/변경 = 이 파일 1곳 수정. 동형성은 tests/grammar-iso.test.ts가 고정한다.
 * 형식 명세: 주간보고 형식 명세
 */

/** 유연 날짜 조각 — ISO 외 점(.)·슬래시(/) 구분자, 한 자리 월·일 (파서가 ISO로 정규화) */
export const DATE_FLEX_SRC = String.raw`\d{4}[-./]\d{1,2}[-./]\d{1,2}`;

/** 파서/임포터용 정밀(캡처) 정규식 — 입력은 앞뒤 공백을 제거한 줄 (들여쓰기는 content.ts가 따로 계산) */
export const GRAMMAR = {
  prev: new RegExp(`^@(?:PREV|WEEK)\\s+(${DATE_FLEX_SRC})\\s*~\\s*(${DATE_FLEX_SRC})\\s*$`),
  current: new RegExp(`^@(?:CURRENT|NEXT)\\s+(${DATE_FLEX_SRC})\\s*~\\s*(${DATE_FLEX_SRC})\\s*$`),
  author: /^@AUTHOR\s+(.+?)\s*$/,
  /** 다음 주 일정 예정 한 줄 — `@PLAN 2026-09-29 10:00 MX(주간미팅)` */
  plan: new RegExp(`^@PLAN\\s+(${DATE_FLEX_SRC})\\s+(.+?)\\s*$`),
  /** 일자 행 — `#` 뒤 공백 생략·요일 생략 허용 (요일 없으면 파서가 자동 보충) */
  day: new RegExp(`^#\\s*(${DATE_FLEX_SRC})\\s*(?:\\(([^)]*)\\))?\\s*$`),
  /** @LOC/@CUS — 값 생략 허용(빈 블록·타이핑 중). 빈 @LOC는 "장소 미정 새 블록" 마커로 직렬화 왕복에 쓰인다 */
  loc: /^@LOC(?:\s+(.+?))?\s*$/,
  cus: /^@CUS(?:\s+(.+?))?\s*$/,
  holiday: /^@HOLIDAY(?:\s+(.*))?\s*$/,
  /** 반차·조퇴 등 부분 근태 — 근무일 유지, 날짜 셀에 라벨 표기 */
  halfday: /^@HALFDAY(?:\s+(.*))?\s*$/,
  /** @SUM (신규) 또는 ## (legacy) — 두 형식 모두 인식. 머리 텍스트는 item-header.ts가 해석 */
  client: /^(?:@SUM|##)(?:\s+(.+?))?\s*$/,
  num: /^(\d+)\)\s*(.*?)\s*$/,
  /** `-` 단독(빈 항목)도 수용 — 직렬화된 빈 세부항목 `- `이 trim 후 리터럴 '-' 텍스트로 오염되지 않도록 */
  dash: /^-(?:\s+(.*?))?\s*$/,
  /** `*==>` 결론·후속 과제 */
  conclusion: /^\*==>\s*(.*?)\s*$/,
  /** `*<-`·`*->` 미결 턴 — 진행 중이거나 후속 조치가 남은 대화 */
  pending: /^\*(<-|->)\s*(.*?)\s*$/,
  /** `<-` 작성자 대응 (안내·전달·조치·요청) */
  turnOut: /^<-\s*(.*?)\s*$/,
  /** `->` 상대방 발화 (고객·제조사의 문의·요청·회신·제보) */
  turnIn: /^->\s*(.*?)\s*$/,
  /** `>` 보조 설명(노트) */
  note: /^>\s?(.*?)\s*$/,
} as const;

/**
 * 에디터 하이라이트용 관용 규칙 — 본문 트레일링을 선택(`(?:\s.*)?`)으로 완화해
 * 타이핑 중(디렉티브만 입력된 상태)에도 즉시 칠해진다. 줄 앞 들여쓰기는 highlightClassFor가 제거한다.
 * 불변식: 파서(GRAMMAR)가 수용하는 라인은 반드시 여기서도 매치된다 (동형성 테스트 고정).
 */
export const HIGHLIGHT_RULES: ReadonlyArray<{ re: RegExp; cls: string }> = [
  { re: /^@(?:PREV|WEEK)(?:\s.*)?$/, cls: 'tok-week' },
  { re: /^@(?:CURRENT|NEXT)(?:\s.*)?$/, cls: 'tok-next' },
  { re: /^@PLAN(?:\s.*)?$/, cls: 'tok-next' },
  { re: /^@AUTHOR(?:\s.*)?$/, cls: 'tok-author' },
  // 일자 행은 GRAMMAR.day와 동일 날짜 조각에서 파생 (요일 캡처만 제외)
  { re: new RegExp(`^#\\s*${DATE_FLEX_SRC}\\s*(?:\\([^)]*\\))?\\s*$`), cls: 'tok-day' },
  { re: /^@LOC(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@CUS(?:\s.*)?$/, cls: 'tok-loc' },
  { re: /^@SUM(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^##(?:\s.*)?$/, cls: 'tok-client' },
  { re: /^@HOLIDAY(?:\s.*)?$/, cls: 'tok-holiday' },
  { re: /^@HALFDAY(?:\s.*)?$/, cls: 'tok-holiday' },
  { re: /^\*==>.*$/, cls: 'tok-conclusion' },
  { re: /^\*(?:<-|->).*$/, cls: 'tok-pending' },
  // 본문 마커는 GRAMMAR가 마커 뒤 공백 생략(`1)NMS`, `<-문의`)도 수용하므로 하이라이트도 동일 엄격도로
  { re: /^\d+\).*$/, cls: 'tok-num' },
  { re: /^-(?:\s.*)?$/, cls: 'tok-dash' },
  { re: /^<-.*$/, cls: 'tok-out' },
  { re: /^->.*$/, cls: 'tok-in' },
  { re: /^>.*$/, cls: 'tok-note' },
];

/** 라인에 매치되는 하이라이트 클래스 (없으면 undefined) — 에디터·동형성 테스트 공용. 들여쓰기 무시 */
export function highlightClassFor(lineText: string): string | undefined {
  const text = lineText.replace(/^[ \t 　]+/, '');
  for (const rule of HIGHLIGHT_RULES) {
    if (rule.re.test(text)) return rule.cls;
  }
  return undefined;
}
