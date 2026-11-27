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
  /** Google 달력에서 이 달력에 정해 둔 색 `#rrggbb` — 달력 목록에 함께 온다(없거나 모양이 다르면 칸이 없다) */
  color?: string;
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
  /** 그 달력의 색 `#rrggbb` — 누구 일정인지 색으로도 가른다 (남의 달력일 때만) */
  calendarColor?: string;
}

export interface CalendarEventsRequest {
  /** YYYY-MM-DD (포함) */
  from: string;
  /** YYYY-MM-DD (포함) */
  to: string;
  calendars: string[];
  /** 5분 기억을 건너뛰고 다시 읽는다 */
  force?: boolean;
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

/** `fromCache` — main이 기억해 둔 목록을 돌려준 것인가(5분, 홈을 열 때마다 다시 부르지 않게) */
export type CalendarListResult = { ok: true; calendars: CalendarInfo[]; fromCache?: boolean } | { ok: false; code: CalendarErrorCode; message: string };

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

// ── 메일 (읽기만) ────────────────────────────────────────────────────────────
// 할 일을 일지에 기록할 때 그 사안의 메일을 근거로 쓴다. 먼저 제목만 조회해 고르고, 고른 스레드만 본문을 읽는다.
// 메일 내용은 파일로 남기지 않는다. 본문은 메일을 거르는 도구(sanitizer)를 거친 것만 main 밖으로 나온다 — 거르지 못하면 읽지 않는다.

export type MailErrorCode = 'credentials-missing' | 'scope-missing' | 'refresh-failed' | 'network' | 'api-error' | 'sanitizer-missing' | 'sanitizer-failed' | 'unknown';

export interface MailFailure {
  ok: false;
  code: MailErrorCode;
  message: string;
}

/** 토큰의 권한 범위로 본 메일 읽기 가능 여부 */
export interface MailStatus {
  /** 메일을 찾고 읽을 수 있다 — 자격증명·권한 범위가 있고, 거르는 도구도 있다 */
  canRead: boolean;
  reason?: 'credentials-missing' | 'scope-missing' | 'sanitizer-missing';
  message?: string;
}

export interface MailSearchRequest {
  /** 찾을 사람 — 보낸 사람·받는 사람·참조의 이름이나 주소 (할 일의 요청자). 쉼표로 여럿을 적으면 그중 누구든 */
  who: string;
  /** 함께 찾을 낱말 (선택) */
  words?: string;
  /** 이 날 이후의 메일 YYYY-MM-DD */
  since: string;
  /** 5분 기억을 건너뛰고 다시 찾는다 */
  force?: boolean;
}

/** 메일 스레드 한 줄 — 제목·보낸 사람·날짜만 (본문은 읽지 않는다) */
export interface MailThreadInfo {
  threadId: string;
  subject: string;
  /** 첫 메일을 보낸 사람의 이름 (이름이 없으면 주소) */
  from: string;
  /** 마지막 메일의 날짜 YYYY-MM-DD (이 컴퓨터의 시간대) */
  date: string;
  /** 메일이 오간 날들 YYYY-MM-DD (겹치지 않게, 오래된 것부터) — 사안이 일지에 적힌 날과 견준다 */
  days: string[];
  /** 주고받은 사람들의 이름 (보낸 사람·받는 사람·참조, 이름이 없으면 주소) — 화면에만 쓴다 */
  people: string[];
  /** 스레드의 메일 수 */
  count: number;
  /** 내가 보낸 메일이 들어 있다 */
  mine: boolean;
}

export type MailSearchResult =
  | {
      ok: true;
      threads: MailThreadInfo[];
      /** 찾은 조건(Gmail 검색식) */
      query: string;
      /** 더 있다 (최근 것부터 한도까지만 가져왔다) */
      more: boolean;
      readAt: number;
      fromCache: boolean;
    }
  | MailFailure;

/** 스레드의 메일 하나 — 인용된 이전 회신은 걷어 내고, 거르는 도구를 거친 글(IP·주소의 앞부분·전화번호 등은 `[IP주소]` 같은 표식으로 바뀌어 있다) */
export interface MailMessage {
  /** 보낸 사람 `이름 <주소>` */
  from: string;
  /** 받는 사람·참조 (헤더 그대로, 쉼표로 이음) */
  to: string;
  /** 보낸 날 YYYY-MM-DD (이 컴퓨터의 시간대) */
  date: string;
  /** 내가 보낸 메일이다 */
  mine: boolean;
  body: string;
}

export type MailThreadResult =
  | {
      ok: true;
      threadId: string;
      subject: string;
      /** 오래된 것부터 */
      messages: MailMessage[];
      /** 메일이 많거나 길어 일부만 담았다 */
      truncated: boolean;
      /** 거르는 도구를 거쳤다 — 이 값이 없는 글은 앱 밖으로 보내지 않는다 */
      sanitized: true;
    }
  | MailFailure;
