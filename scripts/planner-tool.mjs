#!/usr/bin/env node
/**
 * 플래너 도구 실행기 — electron/planner-tool.ts 를 한 파일로 묶어 돌린다.
 *
 *   node scripts/planner-tool.mjs mcp                       MCP 서버(stdio) — Claude Code 등에 등록해 쓴다
 *   node scripts/planner-tool.mjs tools                     도구 목록
 *   node scripts/planner-tool.mjs call <도구> [JSON|@파일|-]  도구 하나 실행
 *
 * 묶은 파일은 node_modules/.cache/tb-planner/ 에 두고, 원본이 바뀌었을 때만 다시 묶는다(esbuild).
 * 표준 출력은 MCP 메시지 전용이다 — 여기서는 아무것도 찍지 않는다(알림은 표준 오류로).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'electron', 'planner-tool.ts');
const OUT_DIR = path.join(ROOT, 'node_modules', '.cache', 'tb-planner');
const OUT = path.join(OUT_DIR, 'planner-tool.mjs');
const INPUTS = path.join(OUT_DIR, 'inputs.json');

/** 묶은 파일이 원본보다 새것인가 — 묶을 때 적어 둔 원본 목록의 시각과 견준다 */
async function fresh() {
  try {
    const built = (await fs.stat(OUT)).mtimeMs;
    const inputs = JSON.parse(await fs.readFile(INPUTS, 'utf8'));
    if (!Array.isArray(inputs) || inputs.length === 0) return false;
    for (const rel of inputs) if ((await fs.stat(path.join(ROOT, rel))).mtimeMs > built) return false;
    return true;
  } catch {
    return false; // 묶은 적이 없거나 원본이 사라졌다
  }
}

async function bundle() {
  const { build } = await import('esbuild');
  await fs.mkdir(OUT_DIR, { recursive: true });
  // 임시 파일에 묶은 뒤 바꿔치기 — 두 프로세스가 동시에 묶어도 반쪽 파일을 읽지 않는다
  const tmp = path.join(OUT_DIR, `planner-tool.${process.pid}.tmp.mjs`);
  try {
    const r = await build({
      absWorkingDir: ROOT,
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: tmp,
      metafile: true,
      logLevel: 'silent',
      alias: { '@core': path.join(ROOT, 'src', 'core') },
    });
    await fs.rename(tmp, OUT);
    await fs.writeFile(INPUTS, JSON.stringify(Object.keys(r.metafile.inputs)));
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

try {
  if (!(await fresh())) await bundle();
  const { main } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`플래너 도구를 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
