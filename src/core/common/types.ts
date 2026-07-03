/**
 * 공용 타입 — 모든 format 모듈이 재사용 가능
 *  - ContentBlock: numbered/qa/bullets 3가지 본문 패턴
 *  - ValidationIssue/Result: 검증 공통 인터페이스
 *  - Weekday/getWeekday: 날짜 유틸
 *  - FormatModule: format 모듈이 구현해야 할 인터페이스
 */

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  line?: number;
  message: string;
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: Record<string, number>;
}

export interface DateRange {
  start: string;
  end: string;
}

export type Weekday = '월' | '화' | '수' | '목' | '금' | '토' | '일';
export const WEEKDAYS: readonly Weekday[] = ['월', '화', '수', '목', '금', '토', '일'] as const;

export function getWeekday(date: string): Weekday {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return WEEKDAYS[(d.getDay() + 6) % 7];
}

/** 본문 블록 — 모든 format이 공유하는 3가지 패턴 */
export type ContentBlock = NumberedBlock | QaBlock | BulletsBlock;

export interface NumberedBlock {
  kind: 'numbered';
  index: number;
  title: string;
  details: string[];
}

export interface QaBlock {
  kind: 'qa';
  question?: string;
  answers: string[];
}

export interface BulletsBlock {
  kind: 'bullets';
  items: string[];
}

/** 렌더 결과 — 모든 format 공통 */
export interface RenderResult {
  html: string;
  plain: string;
}

export interface RenderOptions {
  width?: number;
}

/** Import 입력 — Gmail 본문 등 외부 텍스트 → AST 변환용 */
export interface ImportInput {
  html?: string;
  plain?: string;
}

/** HelpDrawer에 표시할 키워드 가이드 행 */
export interface HelpRow {
  token: string;
  tone: string;
  description: string;
  example: string;
}

/**
 * Format 모듈이 구현해야 할 인터페이스
 *  - 모든 format(weekly-report, file-transfer, tech-guide, license-inquiry)은 이걸 export
 */
export interface FormatModule<TReport> {
  id: string;
  label: string;
  description: string;

  parse(md: string): TReport;
  serialize(report: TReport): string;
  render(report: TReport, options?: RenderOptions): RenderResult;
  validate(report: TReport): ValidationResult;

  importFromInput?(input: ImportInput): { report: TReport; warnings: string[] };
  buildSubject?(report: TReport): string;

  /** 내장 샘플 .md (모든 패턴 노출) */
  sample: string;

  /** 빈 템플릿 생성 (오늘 날짜 기준 등 동적) — 선택 */
  emptyTemplate?(options?: { authorName?: string; baseDate?: Date }): string;

  /** HelpDrawer 키워드 가이드 */
  helpRows: HelpRow[];

  /** 미리보기 캔버스 권장 폭 (px) — 형식별로 다름 */
  previewWidth: number;
}
