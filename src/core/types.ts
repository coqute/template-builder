import { isoOf } from '../lib/dates';

export type Weekday = '월' | '화' | '수' | '목' | '금' | '토' | '일';

/**
 * 표준 채널 — 기준 보고서의 어휘 (주간보고 형식 명세 §4.1).
 * 메신저·현장은 작업일지 탭의 채널 어휘라 일지에서 가져온 항목에 그대로 나온다(2026-11-10 추가).
 */
export type Channel = '메일' | '유선' | '유선&메일' | '메신저' | '슬랙' | '문자' | '카톡' | '현장';

export interface DateRange {
  start: string;
  end: string;
}

export interface WeekReport {
  /** 보고 대상 주 (월~일) — 제목·□ Date */
  prevWeekRange: DateRange;
  /** 다음 주 (월~일) — □ 일정 예정 범위. @PLAN이 있을 때만 출력 */
  currentWeekRange: DateRange;
  authorName: string;
  days: DayEntry[];
  /** @PLAN — 다음 주 일정 예정 (없으면 생략) */
  plans?: PlanEntry[];
}

export interface PlanEntry {
  /** ISO 날짜 */
  date: string;
  /** 일정 문구 — `HH:MM 고객사(작업)` · `(종일) 고객사 작업` · `휴가` */
  text: string;
  srcLine?: number;
}

export interface DayEntry {
  date: string;
  weekday: Weekday;
  blocks: LocationBlock[];
  holiday?: HolidayInfo;
  /** @HALFDAY — 반차·조퇴 등 부분 근태. 근무일 유지, 날짜 셀 아래 주황 라벨로 표기 */
  partial?: PartialDayInfo;
  /** 원본 md에서 `# 일자` 행의 1-based 라인 번호 — 진단 라인 점프용 */
  srcLine?: number;
}

export interface HolidayInfo {
  reason: string;
}

export interface PartialDayInfo {
  /** 표기 라벨 (예: "오후 반차(13:00~18:00)"). 비면 렌더 시 "반차" 폴백 */
  label: string;
}

export interface LocationBlock {
  /** @LOC — 지원장소 컬럼 (` / `로 멀티라인) */
  locations: string[];
  /** @CUS — 고객사|작업구분 컬럼 */
  customer: string;
  /** @SUM 항목 — 내용 셀의 항목 머리 + 본문 */
  items: ClientItem[];
  /** true이면 직전 block과 @LOC를 공유 (장소 셀 rowspan에 흡수됨) */
  inheritLocation?: boolean;
  /** 원본 md에서 이 블록이 시작된 1-based 라인 번호 */
  srcLine?: number;
}

export interface ClientItem {
  client: string;
  /** 현장 방문 건물 — `[고객사] (건물) (담당자)`의 첫 괄호 */
  site?: string;
  /** 담당자(사람·팀). `(A/B)`에서 B가 표준 채널이 아니면 "A/B" 원문 그대로 보존 */
  contact?: string;
  /** 채널 — 표준 채널(Channel)일 때만 채워진다 */
  channel?: string;
  workType: string;
  content: ContentBlock[];
  /** 원본 md에서 @SUM 행의 1-based 라인 번호 */
  srcLine?: number;
}

/** 본문 블록 — indent는 들여쓰기 단계(2칸 = 1단계). 0이면 생략 */
export type ContentBlock = NumberedBlock | DialogBlock | BulletsBlock;

export interface NumberedBlock {
  kind: 'numbered';
  index: number;
  title: string;
  /** `- 세부` 또는 `> 노트`(NOTE_PREFIX 접두) */
  details: string[];
  indent?: number;
}

/**
 * 대화 이력 — 한 건의 문의·대응 경과를 시간순 턴으로 기록 (docs §4.2).
 * `->` 상대방 발화 · `<-` 작성자 대응 · `*<-` 미결 대응 · `*==>` 결론 · `>` 노트
 */
export interface DialogBlock {
  kind: 'dialog';
  turns: DialogTurn[];
  indent?: number;
}

export type TurnKind = 'in' | 'out' | 'conclusion' | 'note';

export interface DialogTurn {
  /** in = 상대방(고객·제조사) 발화, out = 작성자 대응, conclusion = 결론·후속 과제, note = 보조 설명 */
  kind: TurnKind;
  /** 여러 줄 가능 (`\n`) — 마커 없는 이어지는 줄 */
  text: string;
  /** `*<-`/`*->` — 진행 중이거나 후속 조치가 남은 턴 */
  pending?: boolean;
}

export interface BulletsBlock {
  kind: 'bullets';
  items: string[];
  indent?: number;
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
    /** `*<-` 미결 대응 개수 — 발송 전 점검용 */
    pending: number;
  };
}

export const WEEKDAYS: readonly Weekday[] = ['월', '화', '수', '목', '금', '토', '일'] as const;

export const KNOWN_CHANNELS: readonly Channel[] = ['메일', '유선', '메신저', '슬랙', '문자', '카톡', '현장', '유선&메일'] as const;

/** 지원장소 — 현장 방문이 아닐 때의 근무 위치 어휘 (docs §3.1) */
export const LEAVE_LOCATION = '휴가';
export const WORK_PLACES: readonly string[] = ['파트너사', '회사', '외부', LEAVE_LOCATION] as const;

/** 고객사|작업구분 — 특정 고객 건이 아닐 때의 작업구분 어휘 (docs §3.2) */
export const WORK_CATEGORIES: readonly string[] = ['제조사문의', '미팅', '테스트'] as const;

export function isKnownChannel(s: string): s is Channel {
  return (KNOWN_CHANNELS as readonly string[]).includes(s);
}

/** 채널 정규화 결과 — 진단 없는 코어 규칙. 항목 머리 해석(item-header.ts)이 사용 */
export interface ChannelNormalization {
  /** 최종 채널 값 — 표준값으로 수렴됐거나, 미등록이면 raw 그대로 */
  value: string;
  /** 최종 값이 표준 채널인가 */
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
 * `>` 보조 설명(노트) 라인 — numbered.details / bullets.items 배열 안에 `'> '` 접두 문자열로 in-band 저장.
 * 대화 이력에서는 DialogTurn(kind: 'note')로 저장한다.
 */
export const NOTE_PREFIX = '> ';

export function isNoteLine(s: string): boolean {
  return s.startsWith(NOTE_PREFIX) || s === '>';
}

export function noteText(s: string): string {
  return s.replace(/^>\s?/, '');
}

/** @LOC 값 구분자 — 공백 둘러싼 슬래시(` / `)만. "8080/443"·"한강/서원" 등 공백 없는 슬래시는 단어로 보존 */
export const LOCATION_SEPARATOR = /\s+\/\s+/;

/** @LOC 텍스트 → 장소 배열. parser·importer·비주얼 에디터가 같은 규칙을 공유한다 */
export function splitLocations(text: string): string[] {
  return text
    .split(LOCATION_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 지원장소 `MX(누리사옥)` → 건물명 `누리사옥` (괄호가 없으면 undefined) */
export function buildingOf(location: string): string | undefined {
  const m = /\(([^()]+)\)\s*$/.exec(location.trim());
  return m ? m[1].trim() : undefined;
}

export function isLeaveBlock(block: Pick<LocationBlock, 'locations'>): boolean {
  return block.locations.length === 1 && block.locations[0] === LEAVE_LOCATION;
}

/**
 * 달력에 실제로 있는 ISO 날짜인가.
 * `new Date('2026-02-30T00:00:00')`은 오류가 아니라 3월 2일로 넘어간다 — NaN 검사만으로는
 * 2026-02-30·2026-04-31 같은 날짜가 "유효"로 통과하므로, 만든 날짜를 되돌려 비교한다.
 */
export function isRealIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

export function getWeekday(date: string): Weekday {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return WEEKDAYS[(d.getDay() + 6) % 7];
}

/** ISO 날짜 목록 — start~end 포함 (잘못된 범위·31일 초과면 빈 배열) */
export function datesInRange(range: DateRange): string[] {
  const s = new Date(`${range.start}T00:00:00`);
  const e = new Date(`${range.end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s > e) return [];
  const out: string[] = [];
  const d = new Date(s);
  while (d <= e && out.length <= 31) {
    out.push(isoOf(d));
    d.setDate(d.getDate() + 1);
  }
  return out.length > 31 ? [] : out;
}
