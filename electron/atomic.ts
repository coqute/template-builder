/**
 * 파일을 "임시 파일에 쓴 뒤 바꿔치기"로 저장한다 (main 전용).
 *
 * fs.writeFile 은 대상을 먼저 0바이트로 만든 뒤 쓴다. 쓰는 도중 디스크가 차거나 프로세스가 끝나면
 * 원본이 빈 파일·반쪽 파일로 남는다. 같은 폴더의 임시 파일에 다 쓴 뒤 이름을 바꾸면 원본은
 * "옛 내용 그대로"이거나 "새 내용 전부" 둘 중 하나다.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

let seq = 0;

export interface AtomicOptions {
  /** 임시 파일 이름 머리 (기본 `.tb-`) */
  prefix?: string;
  /**
   * 바꿔치기가 막히면(다른 프로그램이 파일을 잡고 있음) 대상에 바로 쓴다.
   * 임시 파일을 만들 권한이 없는 폴더(EACCES·EPERM)도 바로 쓴다. 디스크 부족 같은 다른 오류는 그대로 던진다.
   */
  fallbackDirect?: boolean;
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? '';
}

export async function writeFileAtomic(file: string, data: string | Buffer, opts: AtomicOptions = {}): Promise<void> {
  // 호출마다 다른 이름 — 같은 파일을 겹쳐 저장해도 서로의 임시 파일을 덮지 않는다
  const tmp = path.join(path.dirname(file), `${opts.prefix ?? '.tb-'}${process.pid}-${Date.now()}-${seq++}.tmp`);
  const enc = typeof data === 'string' ? 'utf8' : undefined;
  try {
    try {
      await fs.writeFile(tmp, data, enc);
    } catch (err) {
      if (opts.fallbackDirect && (code(err) === 'EACCES' || code(err) === 'EPERM')) {
        await fs.writeFile(file, data, enc);
        return;
      }
      throw err;
    }
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      if (!opts.fallbackDirect) throw err;
      // 임시 파일을 먼저 지워 자리를 낸 뒤 바로 쓴다
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      await fs.writeFile(file, data, enc);
    }
  } finally {
    // 어느 경로로 끝나든 임시 파일을 남기지 않는다 (바꿔치기에 성공했으면 이미 없다)
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
