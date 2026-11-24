import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXAMPLE_SITE, realSite } from '../src/core/site-config';

// 실제 값(회사·고객사 표기·Gmail 자격증명 폴더·서식의 실제 받는 사람)은 site-config.ts와 기술 문의 서식에만 둔다.
// 예시·테스트·문서·샘플에 다시 들어오면 실패한다. 찾을 값은 설정 파일에서 읽는다 — 이 테스트에 실제 값을 쓰지 않는다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['src/core/site-config.ts', 'src/email/builtin/tech-inquiry.json']);
const DIRS = ['src', 'electron', 'scripts', 'assets', 'tests', 'docs'];
const FILES = ['README.md', 'README.public.md', 'index.html'];
// 경로 조각 가운데 흔한 폴더 이름은 실제 값으로 보지 않는다
const GENERIC_DIRS = new Set(['.claude', 'tools', 'credentials', '.template-builder', 'gmail-credentials']);
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.md', '.html', '.css', '.cmd', '.ps1', '.snap']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(p))) out.push(p);
  }
  return out;
}

function realValues(): string[] {
  const s = realSite();
  const vals = [s.company, s.legacyCompany, ...s.gmailCredDir.split('/').filter((seg) => !GENERIC_DIRS.has(seg))];
  for (const c of s.customers) vals.push(c.canonical, ...c.oldTokens.filter((t) => t.length >= 3));
  const tech = JSON.parse(readFileSync(path.join(ROOT, 'src/email/builtin/tech-inquiry.json'), 'utf8')) as {
    recipientHint?: string;
    recipientCc?: string[];
  };
  for (const m of [tech.recipientHint, ...(tech.recipientCc ?? [])]) if (m) vals.push(m, m.split('@')[1]);
  return [...new Set(vals.filter(Boolean))];
}

describe('실제 값은 설정 파일에만', () => {
  it.skipIf(realSite() === EXAMPLE_SITE)('예시·테스트·문서·샘플에 실제 회사·고객사 표기·자격증명 폴더 이름·실제 메일 주소가 없다', () => {
    const vals = realValues();
    const files = [...DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...FILES.map((f) => path.join(ROOT, f)).filter(existsSync)];
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      const n = vals.filter((v) => text.includes(v)).length;
      if (n) offenders.push(`${rel} (${n}종)`); // 값은 출력하지 않는다
    }
    expect(offenders).toEqual([]);
  });
});
