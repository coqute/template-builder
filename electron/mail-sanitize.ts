/**
 * 메일을 거르는 도구(sanitizer) 부르기 — main 전용.
 *
 * 메일 본문에는 IP·비밀번호·전화번호·라이선스·내부 주소 같은 값이 들어 있다. 앱은 이 값을 가리는 규칙을 스스로 갖지 않고,
 * 메일을 읽는 도구가 쓰는 sanitizer를 **그 코드 그대로** 불러 쓴다(위치는 site-config.ts의 mailSanitizer).
 * - 규칙을 옮겨 적으면 도구의 규칙이 바뀔 때마다 어긋난다 — 같은 코드를 부르면 늘 같은 결과다.
 * - 도구가 도는 방식 그대로 자식 프로세스로 부른다: `node --import tsx` + 도구 폴더를 작업 폴더로. 글은 표준 입력으로 주고 표준 출력으로 받는다.
 * - **거르지 못하면 읽지 않는다.** 도구가 없거나 실패하면 걸러지지 않은 글을 돌려주지 않고 실패를 알린다.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { site } from '../src/core/site-config';
import type { MailFailure } from '../src/planner/types';

/** 거를 글 — 제목과 메일마다 보낸 사람·받는 사람·본문 */
export interface SanitizeInput {
  subject: string;
  messages: Array<{ from: string; to: string; body: string }>;
}

export type SanitizeResult = { ok: true; value: SanitizeInput } | MailFailure;
export type Sanitize = (input: SanitizeInput) => Promise<SanitizeResult>;

const TIMEOUT_MS = 20_000;
const MAX_OUT = 4_000_000;

/** 자식 프로세스에서 도는 글 — 표준 입력의 JSON을 도구의 sanitizeDeep에 넣고 결과를 표준 출력으로 */
const RUNNER = [
  "import { pathToFileURL } from 'node:url';",
  'const chunks = [];',
  'for await (const c of process.stdin) chunks.push(c);',
  "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
  'const mod = await import(pathToFileURL(process.argv[1]).href);',
  "if (typeof mod.sanitizeDeep !== 'function') throw new Error('sanitizeDeep 없음');",
  'process.stdout.write(JSON.stringify(await mod.sanitizeDeep(input)));',
].join('\n');

export function sanitizerPaths(): { root: string; entry: string } {
  const cfg = site().mailSanitizer;
  const root = path.join(os.homedir(), ...cfg.root.split('/'));
  return { root, entry: path.join(root, ...cfg.entry.split('/')) };
}

/** 거르는 도구가 있는가 — 파일이 있는지만 본다(부르지 않는다) */
export async function sanitizerAvailable(): Promise<boolean> {
  try {
    await fs.access(sanitizerPaths().entry);
    return true;
  } catch {
    return false;
  }
}

const missing = (): MailFailure => ({ ok: false, code: 'sanitizer-missing', message: '메일을 거르는 도구(sanitizer)를 찾지 못해 메일 본문을 읽지 않았습니다.' });
const failed = (why: string): MailFailure => ({ ok: false, code: 'sanitizer-failed', message: `메일을 거르지 못해 본문을 읽지 않았습니다 — ${why}` });

/** 돌아온 값이 넣은 것과 같은 모양인가 — 메일 수와 칸이 같아야 한다 */
function sameShape(input: SanitizeInput, out: unknown): out is SanitizeInput {
  const o = out as SanitizeInput | null;
  if (!o || typeof o.subject !== 'string' || !Array.isArray(o.messages) || o.messages.length !== input.messages.length) return false;
  return o.messages.every((m) => m && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.body === 'string');
}

/** 도구의 sanitizer로 거른다. 실패하면 걸러지지 않은 글 대신 실패를 돌려준다 */
export const sanitizeWithTool: Sanitize = async (input) => {
  const { root, entry } = sanitizerPaths();
  if (!(await sanitizerAvailable())) return missing();
  return new Promise<SanitizeResult>((resolve) => {
    let done = false;
    const finish = (r: SanitizeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(process.env.TB_NODE || 'node', ['--import', 'tsx', '--input-type=module', '-e', RUNNER, entry], { cwd: root, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(failed('시간 안에 끝나지 않았습니다.'));
    }, TIMEOUT_MS);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_OUT) {
        child.kill();
        finish(failed('돌아온 글이 너무 깁니다.'));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 2000) err += d.toString('utf8');
    });
    // node를 찾지 못하면(ENOENT) 여기로 온다
    child.on('error', (e) => finish(failed(e.message)));
    child.on('close', (code) => {
      if (code !== 0) return finish(failed(`도구가 오류로 끝났습니다(${code}). ${err.trim().split('\n').pop()?.slice(0, 160) ?? ''}`.trim()));
      try {
        const value = JSON.parse(out) as unknown;
        finish(sameShape(input, value) ? { ok: true, value } : failed('돌아온 글의 모양이 다릅니다.'));
      } catch {
        finish(failed('돌아온 글을 읽지 못했습니다.'));
      }
    });
    child.stdin.on('error', () => undefined); // 자식이 먼저 끝났을 때의 EPIPE — close에서 알린다
    child.stdin.end(JSON.stringify(input));
  });
};
