// 주간보고 .md 를 앱과 같은 파서·검증기로 확인한다 — 주간보고 루틴이 부른다.
// 사용: node scripts/verify-weekly.mjs "<주간보고 .md 경로>"     (npm run verify:weekly -- "<경로>")
// 종료 코드: 0 = 통과(파싱·검증 오류 0, 7일), 1 = 오류 있음, 2 = 실행 실패
// 앱 코어(src/core)를 esbuild 로 묶어 그대로 쓴다. 전에는 루틴이 임시 스크립트를 만들어 `npx tsx`로 돌렸는데,
// tsx 는 이 프로젝트의 의존성이 아니라 npx 캐시에 있을 때만 돌았다(없으면 월요일 아침에 내려받아야 한다).
// style 은 검증기가 보지 않는 "이 사용자의 보고서 표기" 점검이다 — 지난 발송본 27개가 지키는 모양(2026-11-13 대조).
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
  console.error('사용: node scripts/verify-weekly.mjs "<주간보고 .md 경로>"');
  process.exit(2);
}

const HONORIFIC = /(님|책임|부장|차장|과장|대리|선임|수석|사원|주임|전임|매니저|팀장|이사|대표|프로)$/;
/** 앱 코어의 site-config — 고객사 옛 표기·팀명 낱말(실제 값은 src/core/site-config.ts에만). 코어를 묶은 뒤 채운다 */
let SITE = null;
const DIRECTIVE = /^@(PREV|WEEK|CURRENT|NEXT|AUTHOR|PLAN|LOC|CUS|SUM|HOLIDAY|HALFDAY)\b/;

/** 검증기가 보지 않는 표기 점검 — 줄 번호와 함께 */
function styleIssues(md) {
  const out = [];
  const lines = md.replace(/^﻿/, '').split(/\r?\n/);
  let day = null;
  const days = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const no = i + 1;
    const d = /^#\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(t);
    if (d) {
      day = { no, dow: new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getDay(), holiday: null, lines: 0 };
      days.push(day);
      return;
    }
    if (!t) return;
    if (day && !/^@(PREV|WEEK|CURRENT|NEXT|AUTHOR|PLAN)\b/.test(t)) day.lines++;
    if (DIRECTIVE.test(t) && /\s#\s/.test(t)) out.push(`L${no}: 지시어 줄 끝에 '# 설명'이 붙어 있습니다 — 값의 일부로 읽힙니다. 지우세요.`);
    const h = /^@HOLIDAY(?:\s+(.*))?$/.exec(t);
    if (h && day) day.holiday = (h[1] ?? '').trim();
    const s = /^@SUM\s+\[([^\]]*)\]\s*(.*)$/.exec(t);
    if (s) {
      const old = SITE.customers.find((c) => c.oldTokens.includes(s[1].trim()));
      if (old) out.push(`L${no}: 고객 토큰 [${s[1]}] → [${old.canonical}] 로 씁니다.`);
      const p = /^\(([^)]*)\)/.exec(s[2]);
      if (p) {
        const who = p[1].includes('/') ? p[1].slice(0, p[1].lastIndexOf('/')) : p[1];
        const names = who.split(/\s*[,·]\s*/).map((n) => n.trim()).filter(Boolean);
        if (names.some((n) => HONORIFIC.test(n.replace(/\s+/g, '')))) out.push(`L${no}: 머리 괄호의 담당자는 이름만 씁니다(호칭·직급 제거).`);
        if (names.some((n) => SITE.teamHint.test(n))) out.push(`L${no}: 머리 괄호에 팀명이 있습니다 — 팀은 @CUS 칸에만, 괄호는 (담당자/채널)만 씁니다.`);
      }
      return;
    }
    if (/^-\s.*\s—\s/.test(t)) out.push(`L${no}: '-' 줄에 상세를 '—'로 이어 붙였습니다 — 헤드라인만 남기고 상세는 아래 '>' 줄로 나눕니다.`);
  });
  for (const d of days) {
    const weekend = d.dow === 0 || d.dow === 6;
    if (weekend && d.holiday === null && d.lines === 0) out.push(`L${d.no}: 토·일의 빈 날은 @HOLIDAY 로 씁니다.`);
    if (!weekend && d.holiday === '') out.push(`L${d.no}: 평일 휴무는 사유를 적습니다(@HOLIDAY 휴가, @HOLIDAY 개천절 등).`);
  }
  return out;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tb-verify-'));
let code = 2;
try {
  const outfile = path.join(tmp, 'core.mjs');
  await build({
    stdin: {
      contents: "export { parseTolerant } from './src/core/parser';\nexport { validate } from './src/core/validator';\nexport { site } from './src/core/site-config';\n",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    alias: { '@core': path.join(root, 'src/core') },
    logLevel: 'silent',
  });
  const { parseTolerant, validate, site } = await import(pathToFileURL(outfile).href);
  SITE = site();
  const md = readFileSync(file, 'utf8');
  const { report, diagnostics } = parseTolerant(md);
  const v = validate(report);
  const at = (i) => (i.line ? `L${i.line}: ` : '') + i.message;
  const result = {
    days: report.days.length,
    holidays: report.days.filter((d) => d.holiday).length,
    parseErrors: diagnostics.filter((d) => d.severity === 'error').map(at),
    validateErrors: v.issues.filter((i) => i.severity === 'error').map(at),
    warnings: v.issues.filter((i) => i.severity === 'warning').map(at),
    style: styleIssues(md),
  };
  result.pass = result.parseErrors.length === 0 && result.validateErrors.length === 0 && result.days === 7;
  console.log(JSON.stringify(result, null, 2));
  code = result.pass ? 0 : 1;
} catch (err) {
  console.error(`검증 실행 실패: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
