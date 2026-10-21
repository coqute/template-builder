/** 작업일지 — renderer ↔ main IPC 계약. 파일은 사용자가 고른 작업일지 폴더 안의 `[YYYY-MM-DD] 제목.txt`만 다룬다. */

export interface WorklogFolder {
  /** 작업일지 폴더 아래 하위 폴더 이름 ('' = 작업일지 폴더 자체) */
  name: string;
  /** 그 폴더의 `[YYYY-MM-DD]…txt` 개수 */
  count: number;
}

export interface WorklogConfig {
  /** 작업일지 폴더 (비어 있으면 아직 고르지 않음) */
  root: string;
  /** 날짜 파일이 있는 폴더 — 파일이 많은 순 */
  folders: WorklogFolder[];
  error?: string;
}

export interface WorklogFileRef {
  folder: string;
  name: string;
}

export interface WorklogEntry extends WorklogFileRef {
  date: string;
  /** 파일명에서 날짜·확장자를 뺀 제목 */
  title: string;
  size: number;
  mtimeMs: number;
}

export interface WorklogFileText extends WorklogEntry {
  /** 줄바꿈 LF, BOM 뗀 본문 */
  text: string;
}

export interface WorklogReadOk {
  ok: true;
  text: string;
  mtimeMs: number;
  size: number;
  /** 원본 형식 — 저장할 때 그대로 되살린다 */
  bom: boolean;
  crlf: boolean;
  /** UTF-8이 아니어서 EUC-KR로 읽음 — 저장하면 UTF-8이 된다 */
  legacyEncoding: boolean;
}

export type WorklogReadResult = WorklogReadOk | { ok: false; error: string };

export interface WorklogSaveRequest extends WorklogFileRef {
  text: string;
  /** 마지막으로 읽거나 저장한 본문 — 디스크가 이것과 다르면 저장하지 않고 알린다 */
  base: string;
  bom: boolean;
  crlf: boolean;
  /** 디스크가 바뀌었어도 덮어쓴다 (백업 후) */
  force?: boolean;
}

export type WorklogSaveResult =
  | { ok: true; mtimeMs: number; size: number; backup?: string }
  | { ok: false; code: 'changed'; disk: string; mtimeMs: number; size: number }
  | { ok: false; code: 'error'; error: string };

export interface WorklogCreateRequest {
  folder: string;
  date: string;
  title: string;
  text: string;
}

export type WorklogCreateResult =
  | { ok: true; name: string; mtimeMs: number; size: number }
  | { ok: false; code: 'exists'; name: string }
  | { ok: false; code: 'error'; error: string };

export type WorklogRenameResult = { ok: true; name: string } | { ok: false; error: string };

export type WorklogStatResult = { ok: true; mtimeMs: number; size: number } | { ok: false; error: string };

/** 파일명 제목에 쓸 수 없는 글자 (Windows) */
export const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;

/** `[YYYY-MM-DD] 제목.txt` — 제목은 비어 있을 수 있다 */
export const WORKLOG_NAME_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s*(.*?)\.txt$/i;

/** 파일명 최대 길이 — NTFS 255자 안에서 여유 */
export const MAX_NAME_CHARS = 240;
