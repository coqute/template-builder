import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { getWeekday } from '@core/index';

const DIRECTIVES: Completion[] = [
  {
    label: '@PREV',
    detail: '보고 대상 주 (지난 주)',
    apply: '@PREV ',
    info: '예: @PREV 2026-05-11 ~ 2026-05-17',
  },
  {
    label: '@CURRENT',
    detail: '작성 시점 주 (이번 주)',
    apply: '@CURRENT ',
    info: '예: @CURRENT 2026-05-18 ~ 2026-05-24',
  },
  { label: '@AUTHOR', detail: '작성자명', apply: '@AUTHOR ', info: '예: @AUTHOR 홍길동' },
  { label: '@LOC', detail: '지원장소 (` / `로 줄바꿈)', apply: '@LOC ', info: '예: @LOC 한강 제트플러스 4F' },
  {
    label: '@CUS',
    detail: '고객사/작업구분 (` / `로 줄바꿈)',
    apply: '@CUS ',
    info: '예: @CUS 한강/서원 SRE',
  },
  snippetCompletion('@SUM [${고객사}] (${담당자}) ${작업 설명}', {
    label: '@SUM',
    detail: '작업 요약 헤더 (내용 셀 굵은 상위 분류)',
    info: '예: @SUM [ABZ+] (이영희/메일) 수집서버 설치',
  }),
  { label: '@HOLIDAY', detail: '휴무일 (빨간 행)', apply: '@HOLIDAY', info: '예: @HOLIDAY 근로자의 날' },
];

const RE_DOC_DAY = /^#\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/gm;
const RE_DOC_PREV = /^@(?:PREV|WEEK)\s+(\d{4})[-./](\d{1,2})[-./](\d{1,2})/m;

/**
 * 보고서 자동완성 — 2종만:
 * ① 라인 시작 `@` → 디렉티브 7종 (@SUM은 snippet)
 * ② 라인이 `#`(+공백)뿐 → 마지막 일자+1부터 연속 날짜 5개 제안 (없으면 @PREV 시작일)
 */
export function reportCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  if (/^@\w*$/.test(before)) {
    return { from: line.from, options: DIRECTIVES, validFor: /^@\w*$/ };
  }

  if (/^#\s*$/.test(before)) {
    const options = suggestDates(ctx.state.doc.toString());
    if (options.length === 0) return null;
    // validFor를 `#` 이후 자유 입력까지 허용 — 날짜 일부를 타이핑해도 팝업이 유지되며 label 필터링
    return { from: line.from, options, validFor: /^#[^\n]*$/ };
  }

  return null;
}

function suggestDates(docText: string): Completion[] {
  let base: Date | null = null;

  // 문서 내 마지막(최대) `# 일자` + 1일
  let maxDate: Date | null = null;
  for (const m of docText.matchAll(RE_DOC_DAY)) {
    const d = new Date(`${m[1]}-${pad(m[2])}-${pad(m[3])}T00:00:00`);
    if (!Number.isNaN(d.getTime()) && (!maxDate || d > maxDate)) maxDate = d;
  }
  if (maxDate) {
    base = new Date(maxDate);
    base.setDate(base.getDate() + 1);
  } else {
    // 일자가 없으면 @PREV 시작일부터
    const pm = docText.match(RE_DOC_PREV);
    if (pm) {
      const d = new Date(`${pm[1]}-${pad(pm[2])}-${pad(pm[3])}T00:00:00`);
      if (!Number.isNaN(d.getTime())) base = d;
    }
  }
  if (!base) return [];

  const out: Completion[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = fmtDate(d);
    const wd = getWeekday(iso);
    const isWeekend = wd === '토' || wd === '일';
    out.push({
      label: `# ${iso}(${wd})`,
      detail: isWeekend ? '주말 — @HOLIDAY 권장' : undefined,
      apply: isWeekend ? `# ${iso}(${wd})\n@HOLIDAY` : `# ${iso}(${wd})`,
      boost: -i,
    });
  }
  return out;
}

function pad(s: string): string {
  return s.padStart(2, '0');
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
