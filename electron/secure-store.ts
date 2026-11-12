/**
 * OS 암호화 저장(safeStorage, Windows DPAPI) 공용 — AI 키(ai-key.bin).
 *
 * Electron 45에서 동기 메서드(isEncryptionAvailable·encryptString·decryptString)의 지원 종료가 예고됐고
 * 46에서 사라진다. 비동기 메서드는 같은 OS 키 저장소를 쓰며, 예전 동기 메서드로 암호화해 둔 파일도 그대로 읽는다
 * (v0.12.2까지 저장한 키가 올린 뒤에도 읽히는 것을 실측으로 확인 — scripts/smoke-packaged.mjs).
 * app 이 ready 된 뒤에만 부른다.
 */
import { safeStorage } from 'electron';

/** 이 PC에서 암호화 저장을 쓸 수 있는가 */
export async function encryptionAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptText(plain: string): Promise<Buffer> {
  return safeStorage.encryptStringAsync(plain);
}

/**
 * 복호화. `stale`은 OS 키가 바뀌어(또는 더 안전한 키가 생겨) 다시 암호화해 저장하는 편이 좋다는 표시 —
 * 호출자가 같은 값을 encryptText로 다시 써 둔다.
 */
export async function decryptText(encrypted: Buffer): Promise<{ text: string; stale: boolean }> {
  const r = await safeStorage.decryptStringAsync(encrypted);
  return { text: r.result, stale: r.shouldReEncrypt };
}
