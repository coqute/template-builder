#!/usr/bin/env node
/**
 * public-guard — 공개 저장소에 실데이터가 들어가지 않게 막는 검사.
 *
 * 값은 절대 출력하지 않는다. 종류·파일·건수(옵션으로 줄 번호)만 보고한다.
 *
 * 검사 대상
 *   1) 일반 패턴(이 파일에 내장): 메일 주소(예시 도메인만 허용), IPv4(문서용 대역만 허용),
 *      프로젝트 코드 모양 값, 사람 이름 모양(주간보고 문법의 괄호 담당자·작성자 줄)
 *   2) 비공개 용어 사전(저장소 밖 파일): 고객사·조직·사이트·시스템·실명·회사 도메인 등.
 *      위치는 환경변수 PUBLIC_GUARD_TERMS 또는 `git config guard.termsFile`.
 *      사전이 없으면 실패한다(fail closed). 일반 패턴만 돌리려면 --no-terms 를 명시한다.
 *   3) 차단 경로: 자격증명·환경파일·빌드 산출물·사전 파일 모양의 경로
 *
 * 사용
 *   node scripts/public-guard.mjs --tree [dir]     작업 폴더 전체
 *   node scripts/public-guard.mjs --staged         커밋 대기 내용(pre-commit)
 *   node scripts/public-guard.mjs --msg <file>     커밋 메시지(commit-msg)
 *   node scripts/public-guard.mjs --history        모든 커밋의 트리·메시지·작성자
 *   옵션: --lines(줄 번호 표시) --no-terms
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------- 허용 목록 ----------
const ALLOWED_MAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$/i;
const ALLOWED_MAIL_EXACT = new Set(['noreply@anthropic.com']);
const ALLOWED_MAIL_SUFFIX = /@users\.noreply\.github\.com$/i;

function ipAllowed(o) {
  const [a, b, c] = o;
  if (a < 10) return true; // 첫 칸이 10 미만인 네 마디 숫자는 버전 표기로 본다(2.0.6.6) — 앱의 익명화 게이트와 같은 기준
  if (a === 127 || (a === 0 && b === 0 && c === 0)) return true; // loopback·미지정
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 240) return true; // 240/4 예약 대역·브로드캐스트
  return false;
}

/** 예시로 쓰는 번호 — 1234·12345처럼 1부터 오르는 숫자, 한 숫자 반복, 1001처럼 1·0·끝자리, 56000처럼 끝이 000 */
function placeholderNumber(d) {
  if (/^(\d)\1+$/.test(d)) return true;
  if ('1234567890'.startsWith(d)) return true;
  if (/^[19]0{2,}\d$/.test(d)) return true;
  if (/^\d{1,3}000$/.test(d)) return true;
  return false;
}

/** 예시로 쓰는 ID — 서로 다른 글자가 8종 이하(11111111-2222-…) */
function placeholderId(s) {
  return new Set(s.replace(/-/g, '').toLowerCase()).size <= 8;
}

// 예시 인물 — 사람 이름 모양 검사에서 허용
const FAKE_PEOPLE = new Set([
  '홍길동', '김철수', '이영희', '박민수', '최지우', '정다은', '강하늘', '윤서준', '임도윤', '한지민',
  '오민준', '서지훈', '신예린', '권민호', '조은비', '배수진', '고은우', '문하준',
]);
// 흔한 성씨 30개 — 이 글자로 시작하는 세 글자만 사람 이름 후보로 본다(오탐을 줄이려고)
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남';
// 성씨 글자로 시작하지만 사람이 아닌 세 글자 낱말
const NOT_PEOPLE = new Set([
  '고객사', '이메일', '서비스', '정상화', '조직도', '신청서', '장애건', '이관건', '전화로', '한국어', '정보팀', '이전건',
]);

// ---------- 경로 차단 ----------
const BLOCKED_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(node_modules|dist|dist-electron|release|\.ai-live|coverage|\.vite)\//,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(credentials?|client_secret|token|tokens|secrets?)[^/]*\.json$/i,
  /(redact|guard-terms|anonymi[sz]e)[^/]*\.json$/i,
  /(^|\/)real-[^/]*\.(md|json|txt)$/i,
  /\.local\.(json|md|txt|ya?ml)$/i,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', '.ai-live', 'coverage', '.vite']);

// ---------- 사전 ----------
function loadTerms(noTerms) {
  if (noTerms) return [];
  let file = process.env.PUBLIC_GUARD_TERMS || '';
  if (!file) {
    try {
      file = execFileSync('git', ['config', '--get', 'guard.termsFile'], { encoding: 'utf8' }).trim();
    } catch {
      file = '';
    }
  }
  if (!file || !existsSync(file)) {
    console.error('[public-guard] 비공개 용어 사전을 찾지 못했습니다. PUBLIC_GUARD_TERMS 또는 `git config guard.termsFile <경로>`로 지정하세요.');
    console.error('[public-guard] 사전 없이 일반 패턴만 검사하려면 --no-terms 를 붙이세요.');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const m of raw.allowMail ?? []) ALLOWED_MAIL_EXACT.add(String(m).toLowerCase());
  const list = raw.terms ?? raw.rules ?? [];
  const out = [];
  for (const t of list) {
    const pat = t.pattern ?? t.from;
    if (!pat) continue;
    const kind = t.kind || '비공개 용어';
    let re;
    try {
      // 정규식 항목은 쓴 그대로(대소문자 구분, 플래그는 t.flags), 글자 항목은 대소문자 무시
      if (t.regex) re = new RegExp(pat, 'g' + (t.flags ?? ''));
      else {
        const esc = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lead = /^[가-힣]/.test(pat) ? '(?<![가-힣])' : /^[A-Za-z0-9]/.test(pat) ? '(?<![A-Za-z0-9])' : '';
        const tail = /[A-Za-z0-9]$/.test(pat) && t.word ? '(?![A-Za-z0-9])' : '';
        re = new RegExp(lead + esc + tail, 'gi');
      }
    } catch {
      console.error(`[public-guard] 사전 항목 하나를 정규식으로 만들 수 없습니다(종류: ${kind}).`);
      process.exit(2);
    }
    out.push({ kind, re });
  }
  return out;
}

// ---------- 검사 ----------
const MAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const IP_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const PCODE_RE = /(?:projectCode|project_code|프로젝트\s*코드)["'\s]*[:=]?\s*["']?(\d{3,})|[?&/](?:projectCode|project_code)[=/](\d{3,})/gi;
const ID_RE = /(?<![0-9A-Za-z-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9A-Za-z-])/gi;
const USER_PATH_RE = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/(?:Users|home)\/)([^\\/\s"'`$%<>{}]+)/g;
const OK_USER_DIRS = new Set(['user', 'username', 'me', 'public', 'default', 'example', 'runner', 'node']);
// lockfile·바이너리 메타데이터는 메일 검사에서 뺀다(업스트림 패키지 작성자 주소)
const MAIL_SKIP_FILE = /(^|\/)package-lock\.json$/;
const PERSON_RES = [
  /\]\s*\(([가-힣]{3})(?=[/)])/g, // [고객] (이름) · (이름/채널)
  /@AUTHOR[ \t]+([가-힣]{3})(?=\s|$)/gm, // 작성자 줄
  /(?<![가-힣])([가-힣]{3})\s?(?:매니저|책임|선임|수석|과장|대리|차장|부장|팀장|프로|주임|사원)(?:님)?(?![가-힣])/g,
];

function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function scanText(raw, terms, file = '') {
  // 정규식 안의 `\.` 이스케이프를 풀어서 본다(`ops@corp\.example`도 메일 주소로 잡히게). 줄바꿈은 그대로라 줄 번호가 같다.
  const text = raw.replace(/\\(?=\.)/g, '');
  /** @type {Array<{kind:string,line:number}>} */
  const hits = [];
  const add = (kind, idx) => hits.push({ kind, line: lineOf(text, idx) });

  if (!MAIL_SKIP_FILE.test(file))
    for (const m of text.matchAll(MAIL_RE)) {
      const full = m[0];
      const dom = m[1];
      if (ALLOWED_MAIL_EXACT.has(full.toLowerCase()) || ALLOWED_MAIL_SUFFIX.test(full) || ALLOWED_MAIL_DOMAIN.test(dom)) continue;
      add('메일 주소', m.index);
    }
  for (const m of text.matchAll(IP_RE)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) continue;
    if (ipAllowed(o)) continue;
    add('IP 주소', m.index);
  }
  for (const m of text.matchAll(PCODE_RE)) {
    if (placeholderNumber(m[1] ?? m[2])) continue;
    add('프로젝트 코드', m.index);
  }
  for (const m of text.matchAll(ID_RE)) {
    if (placeholderId(m[0])) continue;
    add('외부 서비스 ID(추정)', m.index);
  }
  for (const m of text.matchAll(USER_PATH_RE)) {
    if (OK_USER_DIRS.has(m[1].toLowerCase())) continue;
    add('로컬 사용자 경로', m.index);
  }
  for (const re of PERSON_RES) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!SURNAMES.includes(name[0]) || FAKE_PEOPLE.has(name) || NOT_PEOPLE.has(name)) continue;
      add('사람 이름(추정)', m.index);
    }
  }
  for (const t of terms) {
    t.re.lastIndex = 0;
    for (const m of text.matchAll(t.re)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits && /^[\s()\d]+$/.test(m[0]) && placeholderNumber(digits)) continue;
      add(t.kind, m.index);
    }
  }
  return hits;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function blockedPath(p) {
  return BLOCKED_PATH.some((re) => re.test(p.replace(/\\/g, '/')));
}

// ---------- 보고 ----------
class Report {
  constructor(showLines) {
    this.showLines = showLines;
    /** @type {Map<string, Map<string, number[]>>} kind → where → lines */
    this.map = new Map();
    this.binarySkipped = 0;
    this.scanned = 0;
  }
  addHits(where, hits) {
    for (const h of hits) this.add(h.kind, where, h.line);
  }
  add(kind, where, line = 0) {
    if (!this.map.has(kind)) this.map.set(kind, new Map());
    const m = this.map.get(kind);
    if (!m.has(where)) m.set(where, []);
    m.get(where).push(line);
  }
  total() {
    let n = 0;
    for (const m of this.map.values()) for (const l of m.values()) n += l.length;
    return n;
  }
  print(title) {
    const total = this.total();
    console.log(`[public-guard] ${title} — 검사 ${this.scanned}개${this.binarySkipped ? `(바이너리 ${this.binarySkipped}개 내용 검사 생략)` : ''}, 발견 ${total}건`);
    for (const [kind, m] of [...this.map.entries()].sort()) {
      let k = 0;
      for (const l of m.values()) k += l.length;
      console.log(`  [${kind}] ${k}건 / ${m.size}곳`);
      for (const [where, lines] of [...m.entries()].sort()) {
        const ln = this.showLines && lines.some((x) => x) ? ` (줄 ${[...new Set(lines)].join(', ')})` : '';
        console.log(`    ${where}: ${lines.length}건${ln}`);
      }
    }
    return total;
  }
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
}

function scanBlobs(entries, rep, terms, prefix = '') {
  // entries: [{path, sha}]
  if (!entries.length) return;
  const input = entries.map((e) => e.sha).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], { input, maxBuffer: 1 << 30 });
  let pos = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    const body = out.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    rep.scanned++;
    const where = prefix + e.path;
    if (blockedPath(e.path)) rep.add('차단 경로', where);
    if (isBinary(body)) {
      rep.binarySkipped++;
      continue;
    }
    rep.addHits(where, scanText(body.toString('utf8'), terms, e.path));
  }
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

// ---------- main ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const terms = loadTerms(has('--no-terms'));
const rep = new Report(has('--lines'));
let title = '';

if (has('--staged')) {
  title = '커밋 대기 내용';
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const entries = [];
  for (const p of names) {
    const line = git(['ls-files', '-s', '--', p]).trim();
    const sha = line.split(/\s+/)[1];
    if (sha) entries.push({ path: p, sha });
  }
  scanBlobs(entries, rep, terms);
} else if (has('--msg')) {
  title = '커밋 메시지';
  const text = readFileSync(val('--msg'), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  rep.scanned = 1;
  rep.addHits('(커밋 메시지)', scanText(text, terms));
} else if (has('--history')) {
  title = '전체 이력';
  const revs = git(['rev-list', '--reverse', 'HEAD']).trim().split('\n').filter(Boolean);
  revs.forEach((rev, i) => {
    const tag = `#${String(i + 1).padStart(2, '0')} `;
    const meta = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', rev]);
    rep.addHits(`${tag}(커밋 메시지·작성자)`, scanText(meta, terms));
    const entries = git(['ls-tree', '-r', '-z', rev])
      .split('\0')
      .filter(Boolean)
      .map((l) => {
        const [info, p] = l.split('\t');
        return { path: p, sha: info.split(' ')[2] };
      });
    scanBlobs(entries, rep, terms, tag);
  });
  console.log(`[public-guard] 커밋 ${revs.length}개`);
} else {
  title = '작업 폴더';
  const root = path.resolve(val('--tree') ?? '.');
  for (const rel of walk(root, root, [])) {
    rep.scanned++;
    if (blockedPath(rel)) rep.add('차단 경로', rel);
    const buf = readFileSync(path.join(root, rel));
    if (isBinary(buf)) {
      rep.binarySkipped++;
      continue;
    }
    rep.addHits(rel, scanText(buf.toString('utf8'), terms, rel));
  }
}

const total = rep.print(title);
process.exit(total ? 1 : 0);
