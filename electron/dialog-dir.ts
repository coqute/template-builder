/**
 * 열기·저장 창이 처음 보여 줄 폴더 — 파일 종류별로 마지막에 쓴 폴더를 기억한다 (main 전용).
 *
 * Electron 43부터 `defaultPath`를 주지 않은 열기·저장 창은 항상 다운로드 폴더에서 열린다.
 * 전에는 OS가 그 앱에서 마지막으로 쓴 폴더를 기억했다. 같은 동작을 유지하려면 앱이 직접 기억해 넘겨야 한다.
 * 기억은 앱 설정 폴더의 dialog-dirs.json에 둔다(지워져도 동작에는 지장이 없다 — 문서 폴더에서 열릴 뿐).
 */
import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic';

export type DialogKind = 'md' | 'html' | 'json';
type Saved = Partial<Record<DialogKind | 'last', string>>;

let cache: Saved | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'dialog-dirs.json');
}

async function load(): Promise<Saved> {
  if (cache) return cache;
  const out: Saved = {};
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>;
    for (const k of ['md', 'html', 'json', 'last'] as const) {
      const v = raw?.[k];
      if (typeof v === 'string' && path.isAbsolute(v)) out[k] = v;
    }
  } catch {
    // 처음이거나 읽지 못함 — 빈 기억으로 시작
  }
  cache = out;
  return out;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 창을 열 폴더 — 이 종류에서 마지막에 쓴 폴더 → 다른 종류에서 마지막에 쓴 폴더 → 문서 폴더 (지금 있는 폴더만) */
export async function startDir(kind: DialogKind): Promise<string> {
  const saved = await load();
  const documents = app.getPath('documents');
  for (const c of [saved[kind], saved.last, documents]) {
    if (c && (await isDir(c))) return c;
  }
  return documents;
}

/** 방금 열거나 저장한 파일의 폴더를 기억한다 — 바뀌었을 때만 기록 */
export async function rememberDir(kind: DialogKind, filePath: string): Promise<void> {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return;
  const dir = path.dirname(filePath);
  const saved = await load();
  if (saved[kind] === dir && saved.last === dir) return;
  cache = { ...saved, [kind]: dir, last: dir };
  try {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await writeFileAtomic(file(), JSON.stringify(cache, null, 1));
  } catch {
    // 기억하지 못해도 열기·저장 자체는 끝났다 — 이번 실행 동안은 메모리의 값으로 동작한다
  }
}

/** 파일 확장자 → 종류 (기억하지 않는 확장자는 null) */
export function kindOf(filePath: string): DialogKind | null {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.md' ? 'md' : ext === '.html' ? 'html' : ext === '.json' ? 'json' : null;
}
