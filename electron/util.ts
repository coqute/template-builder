/**
 * main과 플래너 도구가 함께 쓰는 작은 도우미 — 같은 함수가 파일마다 따로 있던 것을 모았다(v0.27.0).
 * Electron을 import하지 않는다(플래너 도구·AI 호출 코어는 Node만으로 돈다).
 */
import { promises as fs } from 'node:fs';

/** 오류 → 사람이 읽을 글 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 지금 있는 폴더인가 (없거나 읽지 못하면 false) */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
