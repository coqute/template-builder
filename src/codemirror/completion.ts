import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { getWeekday, WORK_CATEGORIES, WORK_PLACES } from '@core/index';
import { isoOf } from '../lib/dates';

export const DIRECTIVES: Completion[] = [
  {
    label: '@PREV',
    detail: '보고 대상 주 (지난 주 월~일)',
    apply: '@PREV ',
    info: '예: @PREV 2026-05-11 ~ 2026-05-17',
  },
  {
    label: '@CURRENT',
    detail: '다음 주 (일정 예정 범위)',
    apply: '@CURRENT ',
    info: '예: @CURRENT 2026-05-18 ~ 2026-05-24',
  },
  {
    label: '@PLAN',
    detail: '일정 예정 한 줄 (표 아래 □ 일정 예정)',
    apply: '@PLAN ',
    info: '예: @PLAN 2026-05-19 10:00 MX(주간미팅) · @PLAN 2026-05-20 (종일) 가나스토어 패치',
  },
  {
    label: '@LOC',
    detail: '지원장소 — 방문 건물 또는 파트너사·회사·외부·휴가',
    apply: '@LOC ',
    info: '예: @LOC MX(누리사옥)',
  },
  {
    label: '@CUS',
    detail: '고객사|작업구분 — 고객 약칭 또는 제조사문의·미팅·테스트',
    apply: '@CUS ',
    info: '예: @CUS MX',
  },
  snippetCompletion('@SUM [${고객사}] (${담당자}/${메일}) ${제목}', {
    label: '@SUM',
    detail: '항목 머리 — 원격 (담당자/채널), 현장 (건물) (담당자)',
    info: '예: @SUM [MX] (홍길동/메일) 에이전트 이름 변경 반영 안 됨',
  }),
  { label: '@HOLIDAY', detail: '휴일 — 주말·공휴일 (빨간 행)', apply: '@HOLIDAY ', info: '예: 주말은 @HOLIDAY, 공휴일은 @HOLIDAY 근로자의 날' },
  {
    label: '@HALFDAY',
    detail: '반차·조퇴 (근무일 유지, 날짜 칸 주황 라벨)',
    apply: '@HALFDAY ',
    info: '예: @HALFDAY 오후 반차(13:00~18:00)',
  },
];

/** `*`로 시작하는 본문 마커 — 미결 대응·결론 */
const STAR_MARKERS: Completion[] = [
  { label: '*<-', detail: '미결 대응 — 진행 중·후속 조치 남음', apply: '*<- ' },
  { label: '*==>', detail: '결론·후속 과제', apply: '*==> ' },
  { label: '*->', detail: '상대 회신 대기', apply: '*-> ' },
];

const RE_DOC_DAY = /^#\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/gm;
const RE_DOC_PREV = /^@(?:PREV|WEEK)\s+(\d{4})[-./](\d{1,2})[-./](\d{1,2})/m;

/**
 * 보고서 자동완성:
 * ① 라인 시작 `@` → 디렉티브 (@SUM은 snippet)
 * ② 라인이 `#`(+공백)뿐 → 마지막 일자+1부터 연속 날짜 5개 제안 (없으면 @PREV 시작일)
 * ③ `@LOC ` / `@CUS ` 값 → 규격 어휘 + 문서에 쓴 값
 * ④ `@SUM ` 직후 → 문서에 이미 쓴 항목 머리 (같은 건을 다른 날에 이어 쓰는 히스토리)
 * ⑤ 들여쓰기 뒤 `*` → 미결·결론 마커
 */
export function reportCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  // 들여쓴 줄에서도 — 대화 턴 뒤 Enter로 들여쓰기가 이어진 채 새 항목(@SUM)을 쓰는 경우. 확정하면 들여쓰기를 걷어낸다
  if (/^\s*@\w*$/.test(before)) {
    return { from: line.from, options: DIRECTIVES, validFor: /^\s*@\w*$/ };
  }

  if (/^#\s*$/.test(before)) {
    const options = suggestDates(ctx.state.doc.toString());
    if (options.length === 0) return null;
    // validFor를 `#` 이후 자유 입력까지 허용 — 날짜 일부를 타이핑해도 팝업이 유지되며 label 필터링
    return { from: line.from, options, validFor: /^#[^\n]*$/ };
  }

  let m: RegExpExecArray | null;
  if ((m = /^@(LOC|CUS)\s+/.exec(before))) {
    const from = line.from + m[0].length;
    const values = collectValues(ctx.state.doc.toString(), m[1] as 'LOC' | 'CUS');
    const base = m[1] === 'LOC' ? WORK_PLACES : WORK_CATEGORIES;
    const options = [...new Set([...base, ...values])].map((v, i) => ({
      label: v,
      detail: (base as readonly string[]).includes(v) ? '규격 어휘' : '문서에 쓴 값',
      boost: -i,
    }));
    return { from, options, validFor: /^[^\n]*$/ };
  }

  if ((m = /^@SUM\s+/.exec(before)) && !/\]/.test(before)) {
    const heads = collectHeaders(ctx.state.doc.toString(), line.number);
    if (heads.length === 0) return null;
    return {
      from: line.from + m[0].length,
      options: heads.map((h, i) => ({ label: h, detail: '이어쓰기', boost: -i })),
      validFor: /^[^\n]*$/,
    };
  }

  if (/^\s*\*$/.test(before)) {
    return { from: ctx.pos - 1, options: STAR_MARKERS, validFor: /^\*[<=-]*>?$/ };
  }

  return null;
}

/** 문서의 @LOC / @CUS 값 (중복 제거, 등장 순) */
function collectValues(docText: string, kind: 'LOC' | 'CUS'): string[] {
  const re = kind === 'LOC' ? /^@LOC\s+(.+?)\s*$/gm : /^@CUS\s+(.+?)\s*$/gm;
  const out = new Set<string>();
  for (const m of docText.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** 문서의 항목 머리 — 최근(아래쪽) 것부터, 현재 줄 제외 */
function collectHeaders(docText: string, currentLine: number): string[] {
  const lines = docText.split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i + 1 === currentLine) continue;
    const m = /^\s*(?:@SUM|##)\s+(\[.+?)\s*$/.exec(lines[i]);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
      if (out.length >= 30) break;
    }
  }
  return out;
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
    const iso = isoOf(d);
    const wd = getWeekday(iso);
    const isWeekend = wd === '토' || wd === '일';
    out.push({
      label: `# ${iso}(${wd})`,
      detail: isWeekend ? '주말 — 휴일(@HOLIDAY)' : undefined,
      apply: isWeekend ? `# ${iso}(${wd})\n@HOLIDAY` : `# ${iso}(${wd})`,
      boost: -i,
    });
  }
  return out;
}

function pad(s: string): string {
  return s.padStart(2, '0');
}
