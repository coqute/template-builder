/** 오류 → 사람이 읽을 글 (알림 문구에 붙인다) */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
