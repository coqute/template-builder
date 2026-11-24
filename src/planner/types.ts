/**
 * 플래너 — 홈 화면(남은 작업·확정 일정)의 저장 모양과 renderer ↔ main 계약. 설계: docs/home-schedule-design.md
 *
 * - 저장소는 `사용자 폴더/.template-builder/planner.json` 하나다(앱 데이터 폴더가 아니다 — 설계 §1.5·§8).
 * - 저장소를 고치는 길은 `ops.ts`의 동작(PlannerOp)뿐이다. 앱 화면과 나중의 명령줄·MCP 도구가 같은 동작을 쓴다.
 * - main(electron)도 이 파일을 읽으므로 다른 모듈을 import하지 않는다.
 */

/** 작업일지의 ■ 사안 하나를 가리키는 닻 — 줄이 밀려도 사안 키로 다시 찾는다 (설계 §4.5) */
export interface WorklogAnchor {
  folder: string;
  /** 파일 이름 `[YYYY-MM-DD] 제목.txt` */
  name: string;
  /** 파일 날짜 YYYY-MM-DD */
  date: string;
  /** caseKey(사안 제목) — 공백·후속 표시를 뗀 것 */
  caseKey: string;
  /** 같은 키의 사안 중 몇 번째인가 (0부터) */
  nth: number;
  /** ■ 줄 번호 (1부터) — 키로 못 찾을 때의 힌트 */
  line: number;
  /** 사안 제목 (표시용) */
  title: string;
  /** 출처 괄호 원문 `요청자/채널` (없으면 '') */
  source: string;
}

export type TaskState = 'todo' | 'waiting';

export type TaskOrigin =
  | { kind: 'manual' }
  | { kind: 'worklog'; anchor: WorklogAnchor }
  | { kind: 'weekly'; file: string; line: number };

/** 달력 일정 하나 */
export interface EventRef {
  calendarId: string;
  eventId: string;
}

export interface Task {
  id: string;
  title: string;
  /** 고객사·구분 (없으면 '') */
  client: string;
  /** 요청자 (없으면 '') */
  who: string;
  /** 기한 YYYY-MM-DD */
  due: string | null;
  state: TaskState;
  /** 기다리는 대상 (기다리는 중일 때, 없으면 '') */
  waitingOn: string;
  /** 기다리기 시작한 날 YYYY-MM-DD */
  waitingSince: string | null;
  note: string;
  origin: TaskOrigin;
  /** 이어진 달력 일정 (기한을 달력에 올렸거나 이 일정의 준비 작업) */
  event: EventRef | null;
  createdAt: string;
  updatedAt: string;
  /** 끝낸 때 — 끝낸 할 일은 지우지 않고 이 값만 남긴다 */
  doneAt: string | null;
  /** 마지막으로 고친 쪽 */
  by: 'app' | 'claude';
}

/** 달력 일정 ↔ 일지 사안 */
export interface EventLink extends EventRef {
  anchor: WorklogAnchor;
}

export interface PlannerSettings {
  /** 작업일지에서 후보를 찾는 기간(일) */
  lookbackDays: number;
  /** 읽을 달력 ID — 'primary'는 본인 달력 */
  calendars: string[];
  /** 구독 중인 공휴일 달력도 함께 읽는다 (달력 목록을 읽을 수 있을 때) */
  holidays: boolean;
  /** Notion에서 읽을 것 — 키는 여기에 두지 않는다(앱 데이터 폴더의 암호화 파일) */
  notion: NotionSettings;
}

/** Notion의 DB 하나(데이터 소스) */
export interface NotionSource {
  id: string;
  name: string;
  url: string;
}

export interface NotionSettings {
  /** 홈의 "최근 바뀐 것"에 보일 DB — [DB 찾기]로 찾은 것 가운데 고른 것 */
  sources: NotionSource[];
  /** 회의록 DB의 ID — 그 DB의 페이지를 본인 달력 일정에 잇는다 (없으면 '') */
  meetings: string;
  /** DB에 들어 있지 않은 페이지도 보인다 */
  loose: boolean;
  /** 최근 바뀐 것을 보이는 기간(일) */
  days: number;
}

export interface PlannerState {
  version: 1;
  /** 고칠 때마다 1씩 오른다 */
  rev: number;
  tasks: Task[];
  links: EventLink[];
  /** 무시한 후보의 키 */
  hiddenCandidates: string[];
  /** 숨긴 일정 `달력ID/일정ID` */
  hiddenEvents: string[];
  /** 늘 숨기는 일정 제목 */
  hiddenTitles: string[];
  settings: PlannerSettings;
}

export type TaskDraft = { title: string } & Partial<
  Pick<Task, 'client' | 'who' | 'due' | 'state' | 'waitingOn' | 'note' | 'origin' | 'event'>
>;
export type TaskPatch = Partial<Pick<Task, 'title' | 'client' | 'who' | 'due' | 'state' | 'waitingOn' | 'note' | 'event'>>;

/** 저장소를 고치는 동작 — 항목 단위라 서로 다른 항목끼리는 겹치지 않는다 */
export type PlannerOp =
  | { type: 'task.add'; draft: TaskDraft; id?: string }
  | { type: 'task.update'; id: string; patch: TaskPatch }
  | { type: 'task.done'; id: string; done: boolean }
  | { type: 'task.remove'; id: string }
  | { type: 'task.restore'; task: Task }
  | { type: 'candidate.hide'; key: string; hidden: boolean }
  | { type: 'event.hide'; ref: EventRef; hidden: boolean }
  | { type: 'title.hide'; title: string; hidden: boolean }
  | { type: 'link.set'; link: EventLink }
  | { type: 'link.remove'; ref: EventRef }
  | { type: 'settings'; patch: Partial<PlannerSettings> };

/** 바뀐 기록 한 줄 (planner-log.jsonl) */
export interface PlannerLogEntry {
  at: string;
  by: 'app' | 'claude';
  rev: number;
  op: PlannerOp['type'];
  /** 바뀐 할 일 ID (할 일 동작일 때) */
  id?: string;
  before?: unknown;
  after?: unknown;
}

export type PlannerResult =
  | {
      ok: true;
      state: PlannerState;
      /** 저장 파일 경로 */
      path: string;
      /** 깨진 파일을 옆으로 옮기고 백업·빈 상태로 열었을 때의 안내 */
      warning?: string;
    }
  | { ok: false; error: string };
export type PlannerStatResult = { ok: true; mtimeMs: number; size: number } | { ok: false; error: string };
/** 바뀐 기록 — 최근 것부터 */
export type PlannerLogResult = { ok: true; entries: PlannerLogEntry[] } | { ok: false; error: string };

// ── Google 달력 ─────────────────────────────────────────────────────────────

export type CalendarErrorCode = 'credentials-missing' | 'scope-missing' | 'refresh-failed' | 'network' | 'api-error' | 'unknown';

/** 토큰의 권한 범위로 본 달력 연결 상태 */
export interface CalendarStatus {
  /** 자격증명이 있고 일정 읽기 범위가 있다 */
  connected: boolean;
  canRead: boolean;
  /** 달력 목록을 읽을 수 있다 (없으면 본인 달력만 읽는다) */
  canList: boolean;
  /** 본인 달력에 일정을 만들고 고치고 지울 수 있다 */
  canWrite: boolean;
  reason?: 'credentials-missing' | 'scope-missing';
  message?: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  /** 이 달력에 쓸 수 있는가 (소유·편집 권한) */
  canWrite: boolean;
  /** 공휴일 달력인가 */
  holiday: boolean;
  /** 내 달력인가 — 본인 달력이거나 내가 만든 달력. 아니면 남의 달력(동료 등)이다 */
  mine: boolean;
}

/** 달력에서 읽은 일정 — 분류(회의·작업·휴가…)는 renderer의 classify.ts가 한다 */
export interface RawEvent {
  calendarId: string;
  id: string;
  summary: string;
  location: string;
  allDay: boolean;
  /** 종일: YYYY-MM-DD / 시각: 시간대가 붙은 ISO */
  start: string;
  /** 종일: 끝난 다음 날 YYYY-MM-DD (포함하지 않음) / 시각: ISO */
  end: string;
  /** confirmed · tentative · cancelled */
  status: string;
  /** default · outOfOffice · focusTime · workingLocation · birthday · fromGmail */
  eventType: string;
  htmlLink: string;
  /** 화상 회의 링크가 있다 */
  meet: boolean;
  /** 내가 거절했다 */
  declined: boolean;
  /** 공휴일 달력의 일정이다 */
  holiday: boolean;
  /** 이 일정을 고칠 수 있다 (쓸 수 있는 달력에 있고 내가 만든 일정) */
  canWrite: boolean;
  updated: string;
  /** 반복 일정의 한 회차다 — 고치거나 지우면 그 회차만 바뀐다 (아니면 칸이 없다) */
  recurring?: boolean;
  /** 남의 달력(동료 등)의 일정이다 — 2주 띠에만 옅게 보이고 내 일정 수·다음 일정·목록에는 넣지 않는다 (아니면 칸이 없다) */
  other?: boolean;
  /** 그 달력의 이름 — 누구 일정인지 보이는 데 쓴다 (남의 달력일 때만) */
  calendarName?: string;
}

export interface CalendarEventsRequest {
  /** YYYY-MM-DD (포함) */
  from: string;
  /** YYYY-MM-DD (포함) */
  to: string;
  calendars: string[];
  /** 5분 기억을 건너뛰고 다시 읽는다 */
  force?: boolean;
  /**
   * 한 번 쓰고 버릴 읽기 — 마지막으로 읽은 일정(calendar-cache.json)과 견줄 기준을 건드리지 않는다.
   * 홈이 아닌 곳에서 다른 기간을 읽을 때 쓴다(주간보고의 다음 주 일정 가져오기).
   */
  transient?: boolean;
}

export type CalendarEventsResult =
  | {
      ok: true;
      events: RawEvent[];
      /** 읽은 시각 (ms) */
      readAt: number;
      /** 5분 기억에서 돌려준 것인가 */
      fromCache: boolean;
      /** 사용자가 마지막으로 [확인]한 때의 일정 — 바뀐 것을 견주는 기준. 처음이면 null */
      baseline: RawEvent[] | null;
    }
  | {
      ok: false;
      code: CalendarErrorCode;
      message: string;
      /** 마지막으로 읽은 결과가 있으면 함께 준다 */
      cached?: { events: RawEvent[]; readAt: number };
    };

export type CalendarListResult = { ok: true; calendars: CalendarInfo[] } | { ok: false; code: CalendarErrorCode; message: string };

export interface EventInput {
  /** 없으면 본인 달력 */
  calendarId?: string;
  summary: string;
  allDay: boolean;
  /** 종일: YYYY-MM-DD / 시각: `YYYY-MM-DDTHH:MM` (이 컴퓨터의 시간대로 해석) */
  start: string;
  /** 종일: 마지막 날 YYYY-MM-DD (포함 — main이 다음 날로 바꿔 보낸다) / 시각: `YYYY-MM-DDTHH:MM` */
  end: string;
  location?: string;
  description?: string;
}

export type CalendarWriteResult = { ok: true; event: RawEvent } | { ok: false; code: CalendarErrorCode; message: string };
export type CalendarDeleteResult = { ok: true } | { ok: false; code: CalendarErrorCode; message: string };

// ── Notion (읽기만) ──────────────────────────────────────────────────────────

export type NotionErrorCode = 'no-key' | 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'network' | 'api-error' | 'unknown';

export interface NotionStatus {
  /** 키가 있다 (앱에 저장했거나 환경 변수) */
  connected: boolean;
  /** 앱에 저장한 키가 있다 */
  stored: boolean;
  /** 이 PC에서 키를 암호화해 저장할 수 있다 */
  encryption: boolean;
}

/** Notion 페이지 한 줄 — 제목·시각·주소만 받는다(본문은 읽지 않는다) */
export interface NotionPage {
  id: string;
  /** 속한 DB(데이터 소스)의 ID — DB 밖의 페이지면 '' */
  sourceId: string;
  title: string;
  /** 만든 때 (ISO) */
  createdAt: string;
  /** 마지막으로 고친 때 (ISO) */
  editedAt: string;
  url: string;
}

export interface NotionFailure {
  ok: false;
  code: NotionErrorCode;
  message: string;
}

export type NotionSourcesResult = { ok: true; sources: NotionSource[] } | NotionFailure;

export interface NotionRecentRequest {
  /** 읽을 DB(데이터 소스) ID */
  sources: string[];
  /** 이때 이후에 고친 페이지 (ISO) */
  since: string;
  /** DB 밖의 페이지도 찾는다 */
  loose?: boolean;
  /** 5분 기억을 건너뛰고 다시 읽는다 */
  force?: boolean;
}

export type NotionRecentResult =
  | {
      ok: true;
      pages: NotionPage[];
      /** 읽은 시각 (ms) */
      readAt: number;
      fromCache: boolean;
      /** 읽지 못한 DB의 ID — 나머지는 읽었다 */
      failed: string[];
    }
  | NotionFailure;
