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
import type {
  CalendarDeleteResult,
  CalendarEventsRequest,
  CalendarEventsResult,
  CalendarListResult,
  CalendarStatus,
  CalendarWriteResult,
  EventInput,
  EventRef,
  PlannerOp,
  PlannerResult,
  PlannerLogResult,
  PlannerStatResult,
} from '../src/planner/types';

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
  // 플래너 — 홈 화면의 할 일 저장소. 고치는 길은 plannerApply(동작 하나)뿐이다
  plannerGet: () => ipcRenderer.invoke('planner:get') as Promise<PlannerResult>,
  plannerApply: (op: PlannerOp) => ipcRenderer.invoke('planner:apply', op) as Promise<PlannerResult>,
  plannerStat: () => ipcRenderer.invoke('planner:stat') as Promise<PlannerStatResult>,
  plannerLog: (limit?: number) => ipcRenderer.invoke('planner:log', limit) as Promise<PlannerLogResult>,
  plannerReveal: () => ipcRenderer.invoke('planner:reveal') as Promise<{ ok: boolean; error?: string }>,
  // Google 달력 — 토큰의 권한 범위 안에서 읽기·쓰기 (일정의 설명은 받지 않는다)
  calendarStatus: () => ipcRenderer.invoke('calendar:status') as Promise<CalendarStatus>,
  calendarList: () => ipcRenderer.invoke('calendar:list') as Promise<CalendarListResult>,
  calendarEvents: (req: CalendarEventsRequest) => ipcRenderer.invoke('calendar:events', req) as Promise<CalendarEventsResult>,
  // [확인] — 바뀐 일정을 견주는 기준을 마지막으로 읽은 일정으로 바꾼다
  calendarAck: () => ipcRenderer.invoke('calendar:ack') as Promise<{ ok: boolean }>,
  calendarInsert: (input: EventInput) => ipcRenderer.invoke('calendar:insert', input) as Promise<CalendarWriteResult>,
  calendarPatch: (req: { ref: EventRef; patch: Partial<EventInput> }) =>
    ipcRenderer.invoke('calendar:patch', req) as Promise<CalendarWriteResult>,
  calendarDelete: (ref: EventRef) => ipcRenderer.invoke('calendar:delete', ref) as Promise<CalendarDeleteResult>,
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
