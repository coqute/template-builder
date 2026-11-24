/**
 * 홈이 쓰는 main 쪽 통로. 앱에서는 preload가 내놓은 `window.reportApi`, 웹 미리보기(vite dev)처럼 그것이 없으면
 * 합성 데이터로 도는 가짜 통로(sources/preview.ts)를 쓴다 — 화면 확인용이라 저장되지 않는다.
 */
import type {
  WorklogConfig,
  WorklogCreateRequest,
  WorklogCreateResult,
  WorklogEntry,
  WorklogFileRef,
  WorklogFileText,
  WorklogReadResult,
  WorklogSaveRequest,
  WorklogSaveResult,
} from '../../electron/worklog-types';
import { createPreviewApi } from './sources/preview';
import type {
  CalendarDeleteResult,
  CalendarEventsRequest,
  CalendarEventsResult,
  CalendarListResult,
  CalendarStatus,
  CalendarWriteResult,
  EventInput,
  EventRef,
  NotionRecentRequest,
  NotionRecentResult,
  NotionSourcesResult,
  NotionStatus,
  PlannerLogResult,
  PlannerOp,
  PlannerResult,
  PlannerStatResult,
} from './types';

export interface PlannerApi {
  /** 가짜 통로인가 (웹 미리보기) */
  preview: boolean;
  plannerGet(): Promise<PlannerResult>;
  plannerApply(op: PlannerOp): Promise<PlannerResult>;
  /** 저장 파일의 시각 — 바깥(명령줄·MCP 도구)에서 바뀌었는지 본다 */
  plannerStat(): Promise<PlannerStatResult>;
  /** 바뀐 기록 — 최근 것부터 */
  plannerLog(limit?: number): Promise<PlannerLogResult>;
  plannerReveal(): Promise<{ ok: boolean; error?: string }>;
  calendarStatus(): Promise<CalendarStatus>;
  calendarList(): Promise<CalendarListResult>;
  calendarEvents(req: CalendarEventsRequest): Promise<CalendarEventsResult>;
  calendarAck(): Promise<{ ok: boolean }>;
  calendarInsert(input: EventInput): Promise<CalendarWriteResult>;
  calendarPatch(req: { ref: EventRef; patch: Partial<EventInput> }): Promise<CalendarWriteResult>;
  calendarDelete(ref: EventRef): Promise<CalendarDeleteResult>;
  /** Notion — 읽기만. 키는 main에만 있다 */
  notionStatus(): Promise<NotionStatus>;
  notionSetKey(key: string): Promise<{ ok: true } | { ok: false; error: string }>;
  notionClearKey(): Promise<{ ok: boolean }>;
  notionSources(): Promise<NotionSourcesResult>;
  notionResolve(input: string): Promise<NotionSourcesResult>;
  notionRecent(req: NotionRecentRequest): Promise<NotionRecentResult>;
  worklogConfig(): Promise<WorklogConfig>;
  worklogList(): Promise<{ ok: true; files: WorklogEntry[] } | { ok: false; error: string }>;
  worklogRead(ref: WorklogFileRef): Promise<WorklogReadResult>;
  worklogSave(req: WorklogSaveRequest): Promise<WorklogSaveResult>;
  worklogCreate(req: WorklogCreateRequest): Promise<WorklogCreateResult>;
  worklogReadAll(range?: { from?: string; to?: string }): Promise<{ ok: true; files: WorklogFileText[] } | { ok: false; error: string }>;
  worklogWeeklyHistory(dirs: string[]): Promise<Array<{ name: string; text: string }>>;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
}

let preview: PlannerApi | null = null;

export function plannerApi(): PlannerApi {
  const real = typeof window !== 'undefined' ? (window.reportApi as unknown as Partial<PlannerApi> | undefined) : undefined;
  if (real?.plannerGet && real.calendarStatus) return { ...(real as PlannerApi), preview: false };
  preview ??= createPreviewApi();
  return preview;
}
