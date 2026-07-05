import type {
  ClientItem,
  ContentBlock,
  DateRange,
  DayEntry,
  Diagnostic,
  LocationBlock,
  NumberedBlock,
  ParseOutcome,
  QaBlock,
  Severity,
  Weekday,
  WeekReport,
} from './types';
import { getWeekday, normalizeChannelValue, NOTE_PREFIX, WEEKDAYS } from './types';

export class ParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`L${line}: ${message}`);
    this.line = line;
  }
}

// ── 유연 문법 정규식 ──
// 날짜: ISO 외 점(.)·슬래시(/) 구분자, 한 자리 월·일 허용 → 파서가 ISO로 정규화 + info 진단
const RE_DATE_FLEX = String.raw`\d{4}[-./]\d{1,2}[-./]\d{1,2}`;
const RE_PREV = new RegExp(`^@(?:PREV|WEEK)\\s+(${RE_DATE_FLEX})\\s*~\\s*(${RE_DATE_FLEX})\\s*$`);
const RE_CURRENT = new RegExp(`^@(?:CURRENT|NEXT)\\s+(${RE_DATE_FLEX})\\s*~\\s*(${RE_DATE_FLEX})\\s*$`);
const RE_AUTHOR = /^@AUTHOR\s+(.+?)\s*$/;
/** 일자 행 — `#` 뒤 공백 생략·요일 생략 허용 (요일 없으면 자동 보충) */
const RE_DAY_FLEX = new RegExp(`^#\\s*(${RE_DATE_FLEX})\\s*(?:\\(([^)]*)\\))?\\s*$`);
const RE_LOC = /^@LOC\s+(.+?)\s*$/;
const RE_CUS = /^@CUS\s+(.+?)\s*$/;
const RE_HOLIDAY = /^@HOLIDAY(?:\s+(.*))?\s*$/;
/** @SUM (신규) 또는 ## (legacy) — 두 형식 모두 인식 */
const RE_CLIENT = /^(?:@SUM|##)\s+(.+?)\s*$/;
const RE_NUM = /^(\d+)\)\s*(.*?)\s*$/;
const RE_DASH = /^-\s+(.*?)\s*$/;
const RE_QA_Q = /^<-\s*(.*?)\s*$/;
const RE_QA_A = /^->\s*(.*?)\s*$/;
/** `>` 보조 설명(노트) 라인 — NOTE_PREFIX 접두 문자열로 details/items/answers에 in-band 저장 */
const RE_NOTE = /^>\s?(.*?)\s*$/;

// @SUM 헤더 — workType 빈 문자열 허용 (`(.*?)`) — 비어 있으면 validator가 warning
const RE_CLIENT_CHANNEL = /^\[([^\]]+)\]\s*\(([^)/]+)\/([^)]+)\)\s*(.*?)\s*$/;
const RE_CLIENT_NEW = /^\[([^\]]+)\]\s*\(([^)/]+)\)\s*(.*?)\s*$/;
const RE_CLIENT_BARE = /^\[([^\]]+)\]\s*(.*?)\s*$/;

interface ParseContext {
  prevWeekRange?: DateRange;
  currentWeekRange?: DateRange;
  authorName: string;
  days: DayEntry[];
  currentDay?: DayEntry;
  currentBlock?: LocationBlock;
  currentItem?: ClientItem;
  currentContent?: ContentBlock;
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

  /**
   * 본문 라인(1)/-/<-/->/>)이 @SUM 없이 시작될 때 암묵 항목 생성.
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
      '`@SUM [고객사] 작업 설명` 헤더를 추가하세요.',
      'content-no-sum',
    );
    return implicit;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const line = raw.trim();

    if (line === '') {
      ctx.currentContent = undefined;
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
        computed = getWeekday(date);
      } catch {
        computed = null;
      }
      let weekday: Weekday;
      if (!computed) {
        diag(
          lineNo,
          'warning',
          `일자 "${date}"가 유효하지 않은 날짜입니다.`,
          undefined,
          'invalid-date',
        );
        weekday = (WEEKDAYS as readonly string[]).includes(rawWd) ? (rawWd as Weekday) : '월';
      } else if (!rawWd) {
        weekday = computed;
        diag(
          lineNo,
          'info',
          `요일이 생략되어 (${computed})로 보충했습니다.`,
          undefined,
          'day-no-weekday',
        );
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
      ctx.currentItem = undefined;
      ctx.currentContent = undefined;
      continue;
    }

    if ((m = line.match(RE_HOLIDAY))) {
      if (!ctx.currentDay) {
        diag(
          lineNo,
          'warning',
          '@HOLIDAY가 # 일자 앞에 있어 건너뜁니다.',
          '`# YYYY-MM-DD(요일)` 일자 행 뒤에 선언하세요.',
          'holiday-before-day',
        );
        continue;
      }
      const reason = (m[1] ?? '').trim();
      ctx.currentDay.holiday = { reason };
      ctx.currentBlock = undefined;
      ctx.currentItem = undefined;
      ctx.currentContent = undefined;
      continue;
    }

    if ((m = line.match(RE_LOC))) {
      if (!ctx.currentDay) {
        diag(
          lineNo,
          'warning',
          '@LOC가 # 일자 앞에 있어 건너뜁니다.',
          '`# YYYY-MM-DD(요일)` 일자 행 뒤에 선언하세요.',
          'loc-before-day',
        );
        continue;
      }
      // 공백 둘러싼 슬래시(` / `)만 줄바꿈 — "8080/443"·"한강/서원" 등 공백 없는 슬래시는 단어로 보존
      const locations = m[1]
        .split(/\s+\/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const block: LocationBlock = { locations, customer: '', items: [], srcLine: lineNo };
      ctx.currentDay.blocks.push(block);
      ctx.currentBlock = block;
      ctx.currentItem = undefined;
      ctx.currentContent = undefined;
      continue;
    }

    if ((m = line.match(RE_CUS))) {
      if (!ctx.currentDay) {
        diag(
          lineNo,
          'warning',
          '@CUS가 # 일자 앞에 있어 건너뜁니다.',
          '`# YYYY-MM-DD(요일)` 일자 행 뒤에 선언하세요.',
          'cus-before-day',
        );
        continue;
      }
      const customerText = m[1].trim();
      if (!ctx.currentBlock) {
        const block: LocationBlock = {
          locations: [],
          customer: customerText,
          items: [],
          srcLine: lineNo,
        };
        ctx.currentDay.blocks.push(block);
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
        ctx.currentDay.blocks.push(newBlock);
        ctx.currentBlock = newBlock;
      } else {
        ctx.currentBlock.customer = customerText;
      }
      ctx.currentItem = undefined;
      ctx.currentContent = undefined;
      continue;
    }

    if ((m = line.match(RE_CLIENT))) {
      if (!ctx.currentDay) {
        diag(
          lineNo,
          'warning',
          '@SUM이 # 일자 앞에 있어 건너뜁니다.',
          '`# YYYY-MM-DD(요일)` 일자 행 뒤에 선언하세요.',
          'sum-before-day',
        );
        continue;
      }
      if (!ctx.currentBlock) {
        const auto: LocationBlock = { locations: [], customer: '', items: [], srcLine: lineNo };
        ctx.currentDay.blocks.push(auto);
        ctx.currentBlock = auto;
      }
      const item = parseClientHeader(m[1], lineNo, diag);
      item.srcLine = lineNo;
      ctx.currentBlock.items.push(item);
      ctx.currentItem = item;
      ctx.currentContent = undefined;
      continue;
    }

    if ((m = line.match(RE_NUM))) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      const block: NumberedBlock = {
        kind: 'numbered',
        index: Number.parseInt(m[1], 10),
        title: m[2],
        details: [],
      };
      item.content.push(block);
      ctx.currentContent = block;
      continue;
    }

    if ((m = line.match(RE_QA_Q))) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      const block: QaBlock = { kind: 'qa', question: m[1] || undefined, answers: [] };
      item.content.push(block);
      ctx.currentContent = block;
      continue;
    }

    if ((m = line.match(RE_QA_A))) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      let target = ctx.currentContent;
      if (!target || target.kind !== 'qa') {
        target = { kind: 'qa', answers: [] };
        item.content.push(target);
        ctx.currentContent = target;
      }
      (target as QaBlock).answers.push(m[1]);
      continue;
    }

    if ((m = line.match(RE_DASH))) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      const target = ctx.currentContent;
      if (target && target.kind === 'numbered') {
        target.details.push(m[1]);
      } else {
        let bullets = target && target.kind === 'bullets' ? target : undefined;
        if (!bullets) {
          bullets = { kind: 'bullets', items: [] };
          item.content.push(bullets);
          ctx.currentContent = bullets;
        }
        bullets.items.push(m[1]);
      }
      continue;
    }

    if ((m = line.match(RE_NOTE))) {
      const item = ensureItem(lineNo);
      if (!item) continue;
      // 기존 catch-all과 동일하게 마지막 콘텐츠 블록에 부착 — 레거시 파일 AST 동일성 보장
      const noteLine = `${NOTE_PREFIX}${m[1]}`;
      const last = item.content[item.content.length - 1];
      if (last && last.kind === 'numbered') {
        last.details.push(noteLine);
      } else if (last && last.kind === 'qa') {
        last.answers.push(noteLine);
      } else if (last && last.kind === 'bullets') {
        last.items.push(noteLine);
      } else {
        const bullets: ContentBlock = { kind: 'bullets', items: [noteLine] };
        item.content.push(bullets);
        ctx.currentContent = bullets;
      }
      continue;
    }

    if (ctx.currentItem) {
      const last = ctx.currentItem.content[ctx.currentItem.content.length - 1];
      if (last && last.kind === 'numbered') {
        last.details.push(line);
        continue;
      }
      if (last && last.kind === 'qa') {
        last.answers.push(line);
        continue;
      }
      if (last && last.kind === 'bullets') {
        last.items.push(line);
        continue;
      }
      const bullets: ContentBlock = { kind: 'bullets', items: [line] };
      ctx.currentItem.content.push(bullets);
      ctx.currentContent = bullets;
      continue;
    }

    diag(
      lineNo,
      'warning',
      `구문을 인식할 수 없어 건너뜁니다: ${line.slice(0, 60)}`,
      '디렉티브(@LOC/@CUS/@SUM)·본문(1)/-/<-/->/>) 형식을 확인하세요.',
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

  return {
    report: {
      prevWeekRange: ctx.prevWeekRange,
      currentWeekRange: ctx.currentWeekRange,
      authorName: ctx.authorName,
      days: ctx.days,
    },
    diagnostics: ctx.diagnostics,
  };
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

/** @SUM 헤더 파싱 — throw하지 않고 진단 수집. 브래킷 없는 텍스트도 수용 */
function parseClientHeader(text: string, lineNo: number, diag: DiagFn): ClientItem {
  let m: RegExpMatchArray | null;
  if ((m = text.match(RE_CLIENT_CHANNEL))) {
    const [, client, contact, channelRaw, workType] = m;
    const channel = normalizeChannel(channelRaw.trim(), lineNo, diag);
    return { client, contact, channel, workType, content: [] };
  }
  if ((m = text.match(RE_CLIENT_NEW))) {
    const [, client, contact, workType] = m;
    return { client, contact, workType, content: [] };
  }
  if ((m = text.match(RE_CLIENT_BARE))) {
    const [, client, workType] = m;
    return { client, workType, content: [] };
  }
  // [고객사] 브래킷 없는 자유 텍스트 — 전체를 workType으로 수용
  diag(
    lineNo,
    'warning',
    `@SUM에 [고객사] 표기가 없습니다: ${text.slice(0, 40)}`,
    '`@SUM [고객사] (담당자) 작업 설명` 형식을 권장합니다.',
    'sum-no-bracket',
  );
  return { client: '', workType: text, content: [] };
}

/** 채널 정규화 진단 래퍼 — 규칙 자체는 normalizeChannelValue(types.ts, importer와 공유) */
function normalizeChannel(channelRaw: string, lineNo: number, diag: DiagFn): string {
  const r = normalizeChannelValue(channelRaw);
  if (r.normalized) {
    diag(
      lineNo,
      'info',
      `채널 "${channelRaw}"를 "${r.value}"로 정규화했습니다.`,
      undefined,
      'channel-normalized',
    );
  } else if (!r.known) {
    diag(
      lineNo,
      'warning',
      `채널 "${channelRaw}"는 표준 값(메일/유선/유선&메일)이 아닙니다. 입력값 그대로 사용합니다.`,
      undefined,
      'unknown-channel',
    );
  }
  return r.value;
}

/** `2026.5.1` / `2026/05/01` → `2026-05-01` ISO 정규화 */
function normalizeDate(s: string): string {
  const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
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
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
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
  return { start: fmt(monday), end: fmt(sunday) };
}

function inferNextWeek(prevWeekRange: DateRange): DateRange {
  const startDate = new Date(`${prevWeekRange.start}T00:00:00`);
  const endDate = new Date(`${prevWeekRange.end}T00:00:00`);
  const nextStart = new Date(startDate);
  nextStart.setDate(startDate.getDate() + 7);
  const nextEnd = new Date(endDate);
  nextEnd.setDate(endDate.getDate() + 7);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { start: fmt(nextStart), end: fmt(nextEnd) };
}
