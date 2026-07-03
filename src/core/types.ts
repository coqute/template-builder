export type Weekday = '월' | '화' | '수' | '목' | '금' | '토' | '일';

export type Channel = '메일' | '유선' | '유선&메일';

export interface DateRange {
  start: string;
  end: string;
}

export interface WeekReport {
  /** 보고 대상 주 — 작성 시점 기준 지난 주 (한 일) */
  prevWeekRange: DateRange;
  /** 작성 시점 기준 이번 주 — 본문 □ Date에 표시 (앞으로 할 일) */
  currentWeekRange: DateRange;
  authorName: string;
  days: DayEntry[];
}

export interface DayEntry {
  date: string;
  weekday: Weekday;
  blocks: LocationBlock[];
  holiday?: HolidayInfo;
  /** 원본 md에서 `# 일자` 행의 1-based 라인 번호 — 진단 라인 점프용 */
  srcLine?: number;
}

export interface HolidayInfo {
  reason: string;
}

export interface LocationBlock {
  /** @LOC — 지원장소 컬럼 (slash로 멀티라인 가능) */
  locations: string[];
  /** @CUS — 고객사/작업구분 컬럼 (단일 텍스트) */
  customer: string;
  /** @SUM 항목 — 내용 셀의 상위 헤더(workType) + 하위 1)/-/<-/-> 본문 */
  items: ClientItem[];
  /** true이면 직전 block과 @LOC를 공유 (장소 셀 rowspan에 흡수됨) */
  inheritLocation?: boolean;
  /** 원본 md에서 이 블록이 시작된 1-based 라인 번호 */
  srcLine?: number;
}

export interface ClientItem {
  client: string;
  contact?: string;
  /** 채널 — 알려진 값(Channel) 외 자유 입력 허용. 미등록 값은 파서가 warning 진단 */
  channel?: string;
  workType: string;
  content: ContentBlock[];
  /** 원본 md에서 @SUM 행의 1-based 라인 번호 */
  srcLine?: number;
}

export type ContentBlock = NumberedBlock | QaBlock | BulletsBlock;

export interface NumberedBlock {
  kind: 'numbered';
  index: number;
  title: string;
  details: string[];
}

export interface QaBlock {
  kind: 'qa';
  question?: string;
  answers: string[];
}

export interface BulletsBlock {
  kind: 'bullets';
  items: string[];
}

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  line?: number;
  message: string;
  hint?: string;
}

export type DiagnosticSource = 'parser' | 'validator';

/** 관용 파서·검증기가 수집하는 라인 단위 진단 — 에디터 gutter/StatusBar 표시용 */
export interface Diagnostic {
  /** 1-based 라인 번호. 0 = 문서 수준 (@PREV 누락 등) */
  line: number;
  severity: Severity;
  message: string;
  hint?: string;
  source: DiagnosticSource;
  /** 기계 식별용 코드 (예: 'prev-missing', 'unknown-channel', 'sum-no-bracket') */
  code?: string;
}

export interface ParseOutcome {
  report: WeekReport;
  diagnostics: Diagnostic[];
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    days: number;
    locations: number;
    clientItems: number;
    contentBlocks: number;
  };
}

export const WEEKDAYS: readonly Weekday[] = ['월', '화', '수', '목', '금', '토', '일'] as const;

export const KNOWN_CHANNELS: readonly Channel[] = ['메일', '유선', '유선&메일'] as const;

export function isKnownChannel(s: string): s is Channel {
  return (KNOWN_CHANNELS as readonly string[]).includes(s);
}

/** 채널 정규화 결과 — 진단 없는 코어 규칙. parser(진단 래퍼)와 importer가 공유 */
export interface ChannelNormalization {
  /** 최종 채널 값 — 표준값으로 수렴됐거나, 미등록이면 raw 그대로 */
  value: string;
  /** 최종 값이 표준 채널(메일/유선/유선&메일)인가 */
  known: boolean;
  /** 공백 변주(`유선 & 메일`) 수렴이 일어났는가 */
  normalized: boolean;
}

export function normalizeChannelValue(raw: string): ChannelNormalization {
  if (isKnownChannel(raw)) return { value: raw, known: true, normalized: false };
  const compact = raw.replace(/\s*&\s*/g, '&').trim();
  if (isKnownChannel(compact)) return { value: compact, known: true, normalized: true };
  return { value: raw, known: false, normalized: false };
}

/**
 * `>` 보조 설명(노트) 라인 — details/items/answers 배열 안에 `'> '` 접두 문자열로 in-band 저장.
 * 구조 변경 없이 기존 string[] 배열과 호환되며, 렌더/직렬화 시 이 마커로 구분한다.
 */
export const NOTE_PREFIX = '> ';

export function isNoteLine(s: string): boolean {
  return s.startsWith(NOTE_PREFIX) || s === '>';
}

export function noteText(s: string): string {
  return s.replace(/^>\s?/, '');
}

export function getWeekday(date: string): Weekday {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return WEEKDAYS[(d.getDay() + 6) % 7];
}
