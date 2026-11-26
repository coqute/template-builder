/**
 * OS 암호화 저장(safeStorage, Windows DPAPI) 공용 — AI 키(ai-key.bin)·Notion 키(notion-key.bin).
 *
 * Electron 45에서 동기 메서드(isEncryptionAvailable·encryptString·decryptString)의 지원 종료가 예고됐고
 * 46에서 사라진다. 비동기 메서드는 같은 OS 키 저장소를 쓰며, 예전 동기 메서드로 암호화해 둔 파일도 그대로 읽는다
 * (v0.12.2까지 저장한 키가 올린 뒤에도 읽히는 것을 실측으로 확인 — scripts/smoke-packaged.mjs).
 * app 이 ready 된 뒤에만 부른다.
 */
import { app, safeStorage } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';

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

/**
 * 암호화한 키 파일 하나(앱 데이터 폴더) — 읽기·환경 변수 대체·쓰기·지우기.
 * AI 키와 Notion 키가 같은 코드를 따로 갖고 있던 것을 모았다(v0.27.0). 키의 모양 검사·오류 문구·상태 응답은 쓰는 쪽이 정한다.
 */
export function makeKeyStore(fileName: string, envVar: string) {
  const file = () => path.join(app.getPath('userData'), fileName);
  const env = (): string | null => process.env[envVar]?.trim() || null;
  /** 저장된 키 — 없거나 읽지 못하면 null. OS 키가 바뀌었으면 새 키로 다시 써 둔다(못 써도 이번 호출에는 지장 없음) */
  async function read(): Promise<string | null> {
    if (!(await encryptionAvailable())) return null;
    try {
      const { text, stale } = await decryptText(await fs.readFile(file()));
      const key = text.trim();
      if (key && stale) void encryptText(key).then((b) => fs.writeFile(file(), b, { mode: 0o600 })).catch(() => undefined);
      return key || null;
    } catch {
      return null;
    }
  }
  return {
    read,
    /** 환경 변수에 든 키 (저장된 키가 없을 때 쓴다) */
    env,
    /** 쓸 키 — 저장된 것 먼저, 없으면 환경 변수 */
    resolve: async (): Promise<string | null> => (await read()) ?? env(),
    /** 암호화해 저장한다 — 암호화를 쓸 수 있는지는 부르는 쪽이 먼저 확인한다 */
    write: async (key: string): Promise<void> => {
      await fs.mkdir(path.dirname(file()), { recursive: true });
      await fs.writeFile(file(), await encryptText(key), { mode: 0o600 });
    },
    clear: (): Promise<void> => fs.rm(file(), { force: true }),
  };
}
