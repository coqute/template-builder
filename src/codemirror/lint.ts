import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { parseTolerant, validate } from '@core/index';

/**
 * 보고서 문법 린터 — 에디터 doc을 직접 파싱해 gutter 마커 + 밑줄 진단 표시.
 * React 디바운스 상태와 별개로 doc 기준 동기 실행이라 라인 불일치가 없다.
 * (라인 정규식 파서라 수백 라인에 ~1ms 미만 — delay 300ms로 충분히 완충)
 */
export function reportLinter(): Extension {
  return linter(
    (view) => {
      const doc = view.state.doc;
      const text = doc.toString();
      if (!text.trim()) return [];
      const out: CmDiagnostic[] = [];
      try {
        const { report, diagnostics } = parseTolerant(text);
        const validation = validate(report);
        const all = [
          ...diagnostics,
          ...validation.issues.map((i) => ({
            line: i.line ?? 0,
            severity: i.severity,
            message: i.message,
            hint: i.hint,
          })),
        ];
        for (const d of all) {
          const lineNo = Math.min(Math.max(d.line, 1), doc.lines);
          const l = doc.line(lineNo);
          out.push({
            from: l.from,
            to: l.to,
            severity: d.severity,
            message: d.hint ? `${d.message}\n힌트: ${d.hint}` : d.message,
          });
        }
      } catch {
        // 린터가 에디터를 죽이면 안 됨 — 예외 시 진단 생략
      }
      return out;
    },
    { delay: 300 },
  );
}
