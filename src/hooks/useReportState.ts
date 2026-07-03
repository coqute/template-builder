import { useEffect, useMemo, useRef } from 'react';
import {
  parseTolerant,
  validate,
  render,
  buildSubject,
  type Diagnostic,
  type RenderResult,
  type ValidationResult,
  type WeekReport,
} from '@core/index';

export interface ReportState {
  report?: WeekReport;
  rendered?: RenderResult;
  validation?: ValidationResult;
  /** 파서 + 검증기 진단 병합 (라인 순 정렬) */
  diagnostics: Diagnostic[];
  subject?: string;
  /** rendered가 이전 성공본(현재 입력과 불일치)일 때 true */
  stale?: boolean;
  /** 예기치 못한 내부 예외 — 진단으로 표현 불가한 치명 오류 */
  fatalError?: { message: string };
}

export function useReportState(md: string): ReportState {
  // 예외 시에도 미리보기를 유지하기 위한 마지막 성공 렌더 캐시
  const lastGoodRef = useRef<RenderResult | undefined>(undefined);

  const state = useMemo<ReportState>(() => {
    if (!md.trim()) return { diagnostics: [] };
    try {
      const { report, diagnostics: parseDiags } = parseTolerant(md);
      const validation = validate(report);
      // 진단이 있어도 렌더는 항상 best-effort 실행 — 미리보기 빈 화면 방지
      const rendered = render(report);
      const subject = buildSubject(report.prevWeekRange, report.authorName);
      const diagnostics: Diagnostic[] = [
        ...parseDiags,
        ...validation.issues.map((i) => ({
          line: i.line ?? 0,
          severity: i.severity,
          message: i.message,
          hint: i.hint,
          source: 'validator' as const,
        })),
      ].sort((a, b) => a.line - b.line);
      return { report, rendered, validation, diagnostics, subject };
    } catch (err) {
      return {
        diagnostics: [],
        rendered: lastGoodRef.current,
        stale: true,
        fatalError: {
          message: err instanceof Error ? err.message : '알 수 없는 오류',
        },
      };
    }
  }, [md]);

  // 렌더 중 부수효과 방지 — 성공 렌더 캐시는 commit 후 저장 (React 규칙 준수)
  useEffect(() => {
    if (state.rendered && !state.stale) {
      lastGoodRef.current = state.rendered;
    }
  }, [state]);

  return state;
}
