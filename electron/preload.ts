import { contextBridge, ipcRenderer } from 'electron';
import type { DraftPayload, GmailDraftResult } from './gmail/types';
import type { AiCompleteRequest, AiCompleteResult, AiKeyStatus, AiModelsResult, AiProgress } from './ai-types';
import type {
  WorklogConfig,
  WorklogCreateRequest,
  WorklogCreateResult,
  WorklogEntry,
  WorklogFileRef,
  WorklogFileText,
  WorklogReadResult,
  WorklogRenameResult,
  WorklogSaveRequest,
  WorklogSaveResult,
  WorklogStatResult,
} from './worklog-types';

type SaveKind = 'md' | 'html' | 'json';

const api = {
  // canceled:true 배리언트의 error — 사용자 취소가 아닌 I/O 실패(권한·잠금·삭제). 호출부가 toast로 안내
  openMd: () =>
    ipcRenderer.invoke('dialog:open-md') as Promise<
      | { canceled: true; error?: string }
      | { canceled: false; filePath: string; content: string }
    >,
  openMdMulti: () =>
    ipcRenderer.invoke('dialog:open-md-multi') as Promise<
      | { canceled: true; error?: string }
      | { canceled: false; files: Array<{ filePath: string; content: string }>; errors: string[] }
    >,
  openJson: () =>
    ipcRenderer.invoke('dialog:open-json') as Promise<
      | { canceled: true; error?: string }
      | { canceled: false; filePath: string; content: string }
    >,
  save: (payload: { defaultName: string; content: string; kind: SaveKind }) =>
    ipcRenderer.invoke('dialog:save', payload) as Promise<
      { canceled: true; error?: string } | { canceled: false; filePath: string }
    >,
  saveToPath: (filePath: string, content: string) =>
    ipcRenderer.invoke('file:save-to-path', { filePath, content }) as Promise<
      { ok: true; filePath: string } | { ok: false; error: string }
    >,
  readPath: (filePath: string) =>
    ipcRenderer.invoke('file:read-path', filePath) as Promise<
      { ok: true; content: string } | { ok: false; error: string }
    >,
  setDirty: (dirty: boolean) => {
    ipcRenderer.send('app:set-dirty', dirty);
  },
  copyHtml: (html: string, plain: string) =>
    ipcRenderer.invoke('clipboard:write-html', { html, plain }) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  loadTemplates: (teamDir?: string) =>
    ipcRenderer.invoke('templates:load', teamDir) as Promise<{
      team: Array<{ name: string; raw: unknown }>;
      personal: Array<{ name: string; raw: unknown }>;
      errors: string[];
    }>,
  openTemplatesDir: () =>
    ipcRenderer.invoke('templates:open-dir') as Promise<{ ok: boolean; dir: string; error?: string }>,
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url) as Promise<{ ok: boolean; error?: string }>,
  createGmailDraft: (payload: DraftPayload) =>
    ipcRenderer.invoke('gmail:create-draft', payload) as Promise<GmailDraftResult>,
  loadSample: () => ipcRenderer.invoke('asset:load-sample') as Promise<string | null>,
  // AI 정돈 — 키는 main에만 저장되고 다시 읽어 오지 않는다(상태만)
  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status') as Promise<AiKeyStatus>,
  aiSetKey: (key: string) =>
    ipcRenderer.invoke('ai:key-set', key) as Promise<{ ok: true } | { ok: false; error: string }>,
  aiClearKey: () => ipcRenderer.invoke('ai:key-clear') as Promise<{ ok: boolean }>,
  // 연결 확인 겸 모델 목록 — 이 키에서 열린 모델(Models API, 토큰 비용 없음)
  aiModels: () => ipcRenderer.invoke('ai:models') as Promise<AiModelsResult>,
  aiComplete: (req: AiCompleteRequest) => ipcRenderer.invoke('ai:complete', req) as Promise<AiCompleteResult>,
  // req.id로 묶인 요청을 멈춘다 — 스트림을 끊으므로 그 뒤 생성분은 과금되지 않는다
  aiCancel: (id: string) => ipcRenderer.invoke('ai:cancel', id) as Promise<{ ok: boolean }>,
  onAiProgress: (handler: (p: AiProgress) => void): (() => void) => {
    const fn = (_evt: unknown, p: AiProgress) => handler(p);
    ipcRenderer.on('ai:progress', fn);
    return () => {
      ipcRenderer.removeListener('ai:progress', fn);
    };
  },
  // 작업일지 — 작업일지 폴더 안의 [YYYY-MM-DD] 제목.txt만 (main이 경로를 검증)
  worklogConfig: () => ipcRenderer.invoke('worklog:config') as Promise<WorklogConfig>,
  worklogPickRoot: () => ipcRenderer.invoke('worklog:pick-root') as Promise<WorklogConfig>,
  worklogList: () =>
    ipcRenderer.invoke('worklog:list') as Promise<{ ok: true; files: WorklogEntry[] } | { ok: false; error: string }>,
  worklogRead: (ref: WorklogFileRef) => ipcRenderer.invoke('worklog:read', ref) as Promise<WorklogReadResult>,
  worklogStat: (ref: WorklogFileRef) => ipcRenderer.invoke('worklog:stat', ref) as Promise<WorklogStatResult>,
  worklogSave: (req: WorklogSaveRequest) => ipcRenderer.invoke('worklog:save', req) as Promise<WorklogSaveResult>,
  worklogCreate: (req: WorklogCreateRequest) => ipcRenderer.invoke('worklog:create', req) as Promise<WorklogCreateResult>,
  worklogRename: (req: WorklogFileRef & { title: string }) =>
    ipcRenderer.invoke('worklog:rename', req) as Promise<WorklogRenameResult>,
  worklogReadAll: (range?: { from?: string; to?: string }) =>
    ipcRenderer.invoke('worklog:read-all', range) as Promise<
      { ok: true; files: WorklogFileText[] } | { ok: false; error: string }
    >,
  worklogWeeklyHistory: (dirs: string[]) =>
    ipcRenderer.invoke('worklog:weekly-history', dirs) as Promise<Array<{ name: string; text: string }>>,
  worklogReveal: (ref?: WorklogFileRef) =>
    ipcRenderer.invoke('worklog:reveal', ref) as Promise<{ ok: boolean; error?: string }>,
  onMenu: (handler: (channel: string) => void) => {
    const events = [
      'menu:new',
      'menu:load-sample',
      'menu:open',
      'menu:save',
      'menu:import-gmail',
      'menu:copy-html',
      'menu:draft',
      'menu:help',
    ] as const;
    const listeners: Array<{ ch: string; fn: () => void }> = [];
    events.forEach((ch) => {
      const fn = () => handler(ch);
      ipcRenderer.on(ch, fn);
      listeners.push({ ch, fn });
    });
    return () => {
      listeners.forEach(({ ch, fn }) => ipcRenderer.removeListener(ch, fn));
    };
  },
};

contextBridge.exposeInMainWorld('reportApi', api);

export type ReportApi = typeof api;
