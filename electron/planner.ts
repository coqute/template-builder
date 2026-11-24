/**
 * 플래너 IPC (main 전용) — 홈 화면의 할 일 저장소를 renderer에 내놓는다.
 * 읽기·쓰기·잠금·백업은 planner-store.ts, 동작과 입력 검사는 src/planner/ops.ts. 설계: docs/home-schedule-design.md §8·§9
 *
 * - renderer가 저장소를 고치는 길은 `planner:apply`(동작 하나)뿐이다. 경로를 받지 않으므로 밖으로 나갈 길이 없다.
 * - 바깥에서 파일이 바뀌었는지는 renderer가 `planner:stat`으로 파일 시각을 보고 안다.
 */
import { ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { applyToStore, plannerDir, readLog, readStore, statStore } from './planner-store';
import type { PlannerLogResult, PlannerOp, PlannerResult, PlannerStatResult } from '../src/planner/types';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerPlannerIpc(): void {
  ipcMain.handle('planner:get', (): Promise<PlannerResult> => readStore(plannerDir()));

  ipcMain.handle('planner:apply', (_evt, op: PlannerOp): Promise<PlannerResult> => applyToStore(plannerDir(), op, 'app'));

  ipcMain.handle('planner:stat', (): Promise<PlannerStatResult> => statStore(plannerDir()));

  /** 바뀐 기록 — 최근 것부터 (앱·명령줄·MCP 도구가 고친 것이 모두 여기에 남는다) */
  ipcMain.handle('planner:log', async (_evt, limit?: unknown): Promise<PlannerLogResult> => {
    try {
      const n = typeof limit === 'number' && limit > 0 ? Math.min(200, Math.round(limit)) : 50;
      return { ok: true, entries: await readLog(plannerDir(), n) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  /** 저장 폴더를 탐색기로 — 아직 아무것도 저장하지 않았으면 폴더부터 만든다 */
  ipcMain.handle('planner:reveal', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const dir = plannerDir();
      await fs.mkdir(dir, { recursive: true });
      const e = await shell.openPath(dir);
      return e ? { ok: false, error: e } : { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
