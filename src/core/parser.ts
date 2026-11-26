import type {
  ClientItem,
  DateRange,
  DayEntry,
  Diagnostic,
  LocationBlock,
  ParseOutcome,
  PlanEntry,
  Severity,
  Weekday,
  WeekReport,
} from './types';
import { getWeekday, isRealIsoDate, splitLocations, WEEKDAYS } from './types';
import { isoOf } from '../lib/dates';
import { GRAMMAR } from './grammar';
import { appendContentLine, appendPlainText, indentLevel, matchContentLine, type ContentCursor } from './content';
import { parseItemHeader } from './item-header';

export class ParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`L${line}: ${message}`);
    this.line = line;
  }
}

// ── 문법 정규식 — 단일 소스는 grammar.ts (Grammar Registry). 로컬 별칭만 유지 ──
const RE_PREV = GRAMMAR.prev;
const RE_CURRENT = GRAMMAR.current;
const RE_AUTHOR = GRAMMAR.author;
const RE_PLAN = GRAMMAR.plan;
const RE_DAY_FLEX = GRAMMAR.day;
const RE_LOC = GRAMMAR.loc;
const RE_CUS = GRAMMAR.cus;
const RE_HOLIDAY = GRAMMAR.holiday;
const RE_HALFDAY = GRAMMAR.halfday;
const RE_CLIENT = GRAMMAR.client;

interface ParseContext {
  prevWeekRange?: DateRange;
  currentWeekRange?: DateRange;
  authorName: string;
  days: DayEntry[];
  plans: PlanEntry[];
  currentDay?: DayEntry;
  currentBlock?: LocationBlock;
  currentItem?: ClientItem;
  cursor: ContentCursor;
  diagnostics: Diagnostic[];
}

export interface ParseOptions {
  defaultAuthor?: string;
}

/**
 * 관용 파서 — 구문 편차를 복구하며 진단(Diagnostic)을 수집한다. throw하지 않는다.
 * 복구 불가능한 문제(@PREV 누락 등)는 severity 'error'로 기록하고 추정값으로 계속 진행.
 */
export function parseTolerant(md: string, options: ParseOptions = {}): ParseOutcome {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const ctx: ParseContext = {
    authorName: options.defaultAuthor ?? '작성자',
    days: [],
    plans: [],
    cursor: {},
    diagnostics: [],
  };

  const diag = (
    line: number,
    severity: Severity,
    message: string,
    hint?: string,
    code?: string,
  ) => {
    ctx.diagnostics.push({ line, severity, message, hint, source: 'parser', code });
  };

  /** token은 조사 포함 (예: '@SUM이') */
  const beforeDay = (lineNo: number, token: string, code: string): boolean => {
    if (ctx.currentDay) return false;
    diag(lineNo, 'warning', `${token} # 일자 앞에 있어 건너뜁니다.`, '`# YYYY-MM-DD(요일)` 일자 행 뒤에 선언하세요.', code);
    return true;
  };

  /**
   * 본문 라인이 @SUM 없이 시작될 때 암묵 항목 생성.
   * currentDay조차 없으면 null 반환 (날짜를 지어낼 수 없음 → 호출자가 스킵).
   */
  const ensureItem = (lineNo: number): ClientItem | null => {
    if (ctx.currentItem) return ctx.currentItem;
    if (!ctx.currentDay) {
      diag(
        lineNo,
        'warning',
        '본문 항목이 # 일자 앞에 있어 건너뜁니다.',
        '`# YYYY-MM-DD(요일)` 일자 행을 먼저 선언하세요.',
        'content-before-day',
      );
      return null;
    }
    if (!ctx.currentBlock) {
      const auto: LocationBlock = { locations: [], customer: '', items: [], srcLine: lineNo };
      ctx.currentDay.blocks.push(auto);
      ctx.currentBlock = auto;
    }
    const implicit: ClientItem = { client: '', workType: '', content: [], srcLine: lineNo };
    ctx.currentBlock.items.push(implicit);
    ctx.currentItem = implicit;
    diag(
      lineNo,
      'warning',
      '본문이 @SUM 없이 시작되어 빈 고객사 항목을 생성했습니다.',
      '`@SUM [고객사] 제목` 헤더를 추가하세요.',
      'content-no-sum',
    );
    return implicit;
  };

  const resetBlockContext = () => {
    ctx.currentItem = undefined;
    ctx.cursor = {};
  };

  /**
   * 휴일(@HOLIDAY)로 표시한 날에 내용이 있다 — 표·검증은 휴일 행만 보고, 비주얼 편집의 저장(serialize)도
   * 휴일 날의 블록을 쓰지 않는다. 말없이 두면 주말 근무 기록이 메일에서 빠지고, 비주얼 모드에서 한 번
   * 고친 뒤 저장하면 .md에서도 사라진다. 날마다 한 번만 알린다(유실 가드 LOSSY_CODES에 포함).
   */
  const holidayWarned = new Set<DayEntry>();
  const warnOnHoliday = (lineNo: number) => {
    const day = ctx.currentDay;
    if (!day?.holiday || holidayWarned.has(day)) return;
    holidayWarned.add(day);
    diag(
      lineNo,
      'warning',
      `${day.date}은 휴일(@HOLIDAY)로 표시되어 있어 이 날의 내용은 표에 나오지 않습니다.`,
      '이 날 한 일을 보고하려면 @HOLIDAY 줄을 지우세요. 쉬는 날이 맞으면 아래 내용을 지우세요.',
      'content-on-holiday',
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const line = raw.trim();

    if (line === '') {
      ctx.cursor = {};
      continue;
    }

    let m: RegExpMatchArray | null;

    if ((m = line.match(RE_PREV))) {
      ctx.prevWeekRange = normalizeRange(m[1], m[2], lineNo, '@PREV', diag);
      continue;
    }
    if ((m = line.match(RE_CURRENT))) {
      ctx.currentWeekRange = normalizeRange(m[1], m[2], lineNo, '@CURRENT', diag);
      continue;
    }
    if ((m = line.match(RE_AUTHOR))) {
      ctx.authorName = m[1];
      continue;
    }
    if ((m = line.match(RE_PLAN))) {
      const date = normalizeDate(m[1]);
      if (!isValidIso(date)) {
        diag(lineNo, 'warning', `@PLAN 일자 "${m[1]}"가 유효하지 않아 건너뜁니다.`, undefined, 'plan-invalid-date');
        continue;
      }
      ctx.plans.push({ date, text: m[2], srcLine: lineNo });
      continue;
    }

    if ((m = line.match(RE_DAY_FLEX))) {
      const date = normalizeDate(m[1]);
      if (date !== m[1]) {
        diag(
          lineNo,
          'info',
          `일자 "${m[1]}"를 ISO 형식(${date})으로 정규화했습니다.`,
          undefined,
          'day-normalized',
        );
      }
      const rawWd = (m[2] ?? '').trim();
      let computed: Weekday | null = null;
      try {
        // 달력에 없는 날짜(2026-04-31)는 Date가 다음 달로 넘겨 요일까지 계산해 준다 — 유효하지 않은 날짜로 알린다
        computed = isRealIsoDate(date) ? getWeekday(date) : null;
      } catch {
        computed = null;
      }
      let weekday: Weekday;
      if (!computed) {
        diag(lineNo, 'warning', `일자 "${date}"가 유효하지 않은 날짜입니다.`, undefined, 'invalid-date');
        weekday = (WEEKDAYS as readonly string[]).includes(rawWd) ? (rawWd as Weekday) : '월';
      } else if (!rawWd) {
        weekday = computed;
        diag(lineNo, 'info', `요일이 생략되어 (${computed})로 보충했습니다.`, undefined, 'day-no-weekday');
      } else if (!(WEEKDAYS as readonly string[]).includes(rawWd)) {
        weekday = computed;
        diag(
          lineNo,
          'warning',
          `요일 "${rawWd}"를 인식할 수 없어 (${computed})로 교정했습니다.`,
          undefined,
          'day-bad-weekday',
        );
      } else {
        // 기재 요일 유지 — 날짜와 불일치하면 validator가 warning (자동 교정하지 않음)
        weekday = rawWd as Weekday;
      }
      const day: DayEntry = { date, weekday, blocks: [], srcLine: lineNo };
      ctx.days.push(day);
      ctx.currentDay = day;
      ctx.currentBlock = undefined;
      resetBlockContext();
      continue;
    }

    if ((m = line.match(RE_HOLIDAY))) {
      if (beforeDay(lineNo, '@HOLIDAY가', 'holiday-before-day')) continue;
      ctx.currentDay!.holiday = { reason: (m[1] ?? '').trim() };
      // 내용을 쓴 뒤 @HOLIDAY를 붙인 경우 — 위에 쓴 블록이 버려진다
      if (ctx.currentDay!.blocks.length > 0) warnOnHoliday(lineNo);
      ctx.currentBlock = undefined;
      resetBlockContext();
      continue;
    }

    if ((m = line.match(RE_HALFDAY))) {
      if (beforeDay(lineNo, '@HALFDAY가', 'halfday-before-day')) continue;
      // 부분 근태 — 근무일 유지: 블록 컨텍스트를 리셋하지 않는다
      ctx.currentDay!.partial = { label: (m[1] ?? '').trim() };
      continue;
    }

    if ((m = line.match(RE_LOC))) {
      if (beforeDay(lineNo, '@LOC가', 'loc-before-day')) continue;
      warnOnHoliday(lineNo);
      // 값 생략(`@LOC` 단독)은 장소 미정 새 블록 — 비주얼 에디터의 빈 장소 블록이 직전 @LOC를 상속하지 않도록
      const block: LocationBlock = { locations: splitLocations(m[1] ?? ''), customer: '', items: [], srcLine: lineNo };
      ctx.currentDay!.blocks.push(block);
      ctx.currentBlock = block;
      resetBlockContext();
      continue;
    }

    if ((m = line.match(RE_CUS))) {
      if (beforeDay(lineNo, '@CUS가', 'cus-before-day')) continue;
      warnOnHoliday(lineNo);
      const customerText = (m[1] ?? '').trim();
      if (!ctx.currentBlock) {
        const block: LocationBlock = { locations: [], customer: customerText, items: [], srcLine: lineNo };
        ctx.currentDay!.blocks.push(block);
        ctx.currentBlock = block;
      } else if (ctx.currentBlock.customer || ctx.currentBlock.items.length > 0) {
        // 같은 @LOC 아래 두 번째 @CUS — 새 sub-row block 생성 (장소 상속)
        const newBlock: LocationBlock = {
          locations: ctx.currentBlock.locations,
          customer: customerText,
          items: [],
          inheritLocation: true,
          srcLine: lineNo,
        };
        ctx.currentDay!.blocks.push(newBlock);
        ctx.currentBlock = newBlock;
      } else {
        ctx.currentBlock.customer = customerText;
      }
      resetBlockContext();
      continue;
    }

    if ((m = line.match(RE_CLIENT))) {
      if (beforeDay(lineNo, '@SUM이', 'sum-before-day')) continue;
      warnOnHoliday(lineNo);
      if (!ctx.currentBlock) {
        const auto: LocationBlock = { locations: [], customer: '', items: [], srcLine: lineNo };
        ctx.currentDay!.blocks.push(auto);
        ctx.currentBlock = auto;
      }
      const { header, issues } = parseItemHeader(m[1] ?? '', ctx.currentBlock.locations);
      for (const is of issues) diag(lineNo, is.severity, is.message, is.hint, is.code);
      const item: ClientItem = { ...header, content: [], srcLine: lineNo };
      ctx.currentBlock.items.push(item);
      ctx.currentItem = item;
      ctx.cursor = {};
      continue;
    }

    const content = matchContentLine(line);
    if (content) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      warnOnHoliday(lineNo);
      appendContentLine(item, ctx.cursor, content, indentLevel(raw));
      continue;
    }

    if (ctx.currentItem) {
      appendPlainText(ctx.currentItem, ctx.cursor, line, indentLevel(raw));
      continue;
    }

    diag(
      lineNo,
      'warning',
      `구문을 인식할 수 없어 건너뜁니다: ${line.slice(0, 60)}`,
      '디렉티브(@LOC/@CUS/@SUM)·본문(1)/-/->/<-/*<-/*==>/>) 형식을 확인하세요.',
      'unknown-syntax',
    );
  }

  if (!ctx.prevWeekRange) {
    ctx.prevWeekRange = estimatePrevRange(ctx.days);
    diag(
      0,
      'error',
      '@PREV 디렉티브가 누락되었습니다.',
      '`@PREV YYYY-MM-DD ~ YYYY-MM-DD` 형식으로 보고 대상 주를 명시하세요. 일자 행 기준으로 추정했습니다.',
      'prev-missing',
    );
  }
  if (!ctx.currentWeekRange) {
    ctx.currentWeekRange = inferNextWeek(ctx.prevWeekRange);
  }

  const report: WeekReport = {
    prevWeekRange: ctx.prevWeekRange,
    currentWeekRange: ctx.currentWeekRange,
    authorName: ctx.authorName,
    days: ctx.days,
  };
  if (ctx.plans.length > 0) report.plans = ctx.plans;
  return { report, diagnostics: ctx.diagnostics };
}

/**
 * 엄격 파서 — 기존 시그니처 유지. parseTolerant 실행 후
 * severity 'error'인 첫 진단을 ParseError로 throw. warning/info는 통과.
 */
export function parse(md: string, options: ParseOptions = {}): WeekReport {
  const { report, diagnostics } = parseTolerant(md, options);
  const firstError = diagnostics.find((d) => d.severity === 'error');
  if (firstError) {
    throw new ParseError(firstError.line, firstError.message);
  }
  return report;
}

type DiagFn = (
  line: number,
  severity: Severity,
  message: string,
  hint?: string,
  code?: string,
) => void;

/** `2026.5.1` / `2026/05/01` → `2026-05-01` ISO 정규화 */
function normalizeDate(s: string): string {
  const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function isValidIso(s: string): boolean {
  return isRealIsoDate(s);
}

function normalizeRange(
  rawStart: string,
  rawEnd: string,
  lineNo: number,
  label: string,
  diag: DiagFn,
): DateRange {
  const start = normalizeDate(rawStart);
  const end = normalizeDate(rawEnd);
  if (start !== rawStart || end !== rawEnd) {
    diag(
      lineNo,
      'info',
      `${label} 날짜를 ISO 형식(${start} ~ ${end})으로 정규화했습니다.`,
      undefined,
      'range-normalized',
    );
  }
  return { start, end };
}

/** @PREV 누락 시 추정 — 첫 일자 행이 속한 주의 월~일, 일자도 없으면 오늘 기준 지난주 */
function estimatePrevRange(days: DayEntry[]): DateRange {
  let base: Date | null = null;
  if (days.length > 0) {
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const first = new Date(`${sorted[0].date}T00:00:00`);
    if (!Number.isNaN(first.getTime())) base = first;
  }
  if (!base) {
    base = new Date();
    base.setDate(base.getDate() - 7);
  }
  const monday = new Date(base);
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: isoOf(monday), end: isoOf(sunday) };
}

/** @CURRENT 누락 시 — 보고 주 + 7일 (월~일 길이 보존) */
function inferNextWeek(prevWeekRange: DateRange): DateRange {
  const nextStart = new Date(`${prevWeekRange.start}T00:00:00`);
  nextStart.setDate(nextStart.getDate() + 7);
  const nextEnd = new Date(`${prevWeekRange.end}T00:00:00`);
  nextEnd.setDate(nextEnd.getDate() + 7);
  return { start: isoOf(nextStart), end: isoOf(nextEnd) };
}
