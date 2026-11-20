import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 공개 검사(scripts/public-guard.mjs) — 비공개 용어 사전 없이 돌 수 있는 일반 패턴만 확인한다.
// 실데이터 모양의 값은 이 파일 자체가 검사에 걸리지 않도록 실행 중에 조립한다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'public-guard.mjs');

function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GUARD, '--tree', dir, '--no-terms', '--lines'], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

describe('공개 검사', () => {
  it('저장소 전체가 일반 패턴 검사를 통과한다', () => {
    const r = run(ROOT);
    expect(r.out).toContain('발견 0건');
    expect(r.code).toBe(0);
  }, 30000);

  it('실데이터 모양을 종류·파일·줄로 알리고, 값은 출력하지 않는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-'));
    try {
      const mail = ['kim', 'corp.co.kr'].join('@');
      const ip = ['10', '1', '1', '7'].join('.');
      const code = `projectCode=${4000 + 821}`;
      const home = ['C:', 'Users', 'kim'].join('\\') + '\\work';
      const escaped = ['ops', 'corp\\.co\\.kr'].join('@');
      writeFileSync(path.join(dir, 'a.md'), `담당 ${mail}\n서버 ${ip}\n${code}\n${home}\n/${escaped}/\n`);
      mkdirSync(path.join(dir, 'conf'));
      writeFileSync(path.join(dir, 'conf', '.env'), 'X=1\n');
      const r = run(dir);
      expect(r.code).toBe(1);
      for (const kind of ['메일 주소', 'IP 주소', '프로젝트 코드', '로컬 사용자 경로', '차단 경로']) expect(r.out).toContain(`[${kind}]`);
      expect(r.out).toContain('발견 6건');
      expect(r.out).toContain('a.md: 2건 (줄 1, 5)'); // 메일 주소 — 정규식 이스케이프(\.) 형태 포함
      for (const line of ['a.md: 1건 (줄 2)', 'a.md: 1건 (줄 3)', 'a.md: 1건 (줄 4)', 'conf/.env: 1건']) expect(r.out).toContain(line);
      for (const v of [mail, ip, '4821', 'kim\\work', 'corp']) expect(r.out).not.toContain(v);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('예시 도메인·문서용 IP 대역·예시 번호는 통과시킨다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-'));
    try {
      writeFileSync(
        path.join(dir, 'ok.md'),
        'support@vendor.example a@example.com 192.0.2.10 198.51.100.7 203.0.113.9 127.0.0.1 버전 2.0.6.6\nprojectCode=1234 projectCode=1001 (12345)\n[가나통신] (홍길동/메일)\n',
      );
      const r = run(dir);
      expect(r.out).toContain('발견 0건');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
