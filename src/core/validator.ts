import type { ValidationIssue, ValidationResult, WeekReport } from './types';
import { getWeekday } from './types';

export function validate(report: WeekReport): ValidationResult {
  const issues: ValidationIssue[] = [];
  let locations = 0;
  let clientItems = 0;
  let contentBlocks = 0;

  if (!isIsoDate(report.prevWeekRange.start) || !isIsoDate(report.prevWeekRange.end)) {
    issues.push({
      severity: 'error',
      message: '@PREV 일자 형식이 YYYY-MM-DD가 아닙니다.',
    });
  }
  if (!isIsoDate(report.currentWeekRange.start) || !isIsoDate(report.currentWeekRange.end)) {
    issues.push({
      severity: 'error',
      message: '@CURRENT 일자 형식이 YYYY-MM-DD가 아닙니다.',
    });
  }
  if (
    isIsoDate(report.prevWeekRange.start) &&
    isIsoDate(report.prevWeekRange.end) &&
    report.prevWeekRange.start > report.prevWeekRange.end
  ) {
    issues.push({
      severity: 'error',
      message: '@PREV 시작 일자가 종료 일자보다 늦습니다.',
    });
  }

  if (report.days.length === 0) {
    issues.push({
      severity: 'error',
      message: '일자(`# YYYY-MM-DD(요일)`)가 하나도 없습니다.',
      hint: '예: # 2026-04-27(월)',
    });
  }

  const seen = new Set<string>();
  for (const day of report.days) {
    if (!isIsoDate(day.date)) {
      issues.push({
        severity: 'error',
        line: day.srcLine,
        message: `일자 "${day.date}" 형식이 잘못되었습니다.`,
      });
      continue;
    }
    if (seen.has(day.date)) {
      issues.push({
        severity: 'warning',
        line: day.srcLine,
        message: `일자 ${day.date}가 중복되었습니다.`,
      });
    }
    seen.add(day.date);

    try {
      const expected = getWeekday(day.date);
      if (expected !== day.weekday) {
        issues.push({
          severity: 'warning',
          line: day.srcLine,
          message: `${day.date}는 ${expected}요일인데 (${day.weekday})로 기재되어 있습니다.`,
        });
      }
    } catch {
      // ignore — 위에서 형식 검증
    }

    if (day.holiday) {
      // 휴무일 — 의도적 빈 행, 경고/오류 면제
      continue;
    }

    if (day.blocks.length === 0) {
      issues.push({
        severity: 'warning',
        line: day.srcLine,
        message: `${day.date}에 @LOC/## 블록이 없습니다.`,
        hint: '@LOC 또는 ##로 본문을 추가하거나, 휴무일이라면 @HOLIDAY 사유를 표기하세요.',
      });
      continue;
    }

    for (const block of day.blocks) {
      locations += 1;
      if (block.locations.length === 0) {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: @LOC 지원장소가 비어 있습니다.`,
        });
      }
      if (!block.customer || !block.customer.trim()) {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: @CUS 고객사/작업구분이 비어 있습니다.`,
        });
      }
      if (block.items.length === 0) {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: ${block.locations.join(' / ') || '(LOC 미지정)'} 블록에 @SUM 행이 없습니다.`,
        });
        continue;
      }
      for (const item of block.items) {
        clientItems += 1;
        if (!item.client.trim()) {
          issues.push({
            severity: 'error',
            line: item.srcLine ?? block.srcLine ?? day.srcLine,
            message: `${day.date}: 고객사 [...] 부분이 비어 있습니다.`,
          });
        }
        if (!item.workType.trim()) {
          issues.push({
            severity: 'warning',
            line: item.srcLine ?? block.srcLine ?? day.srcLine,
            message: `${day.date} [${item.client}]: 작업 설명이 비어 있습니다.`,
          });
        }
        if (item.content.length === 0) {
          issues.push({
            severity: 'warning',
            line: item.srcLine ?? block.srcLine ?? day.srcLine,
            message: `${day.date} [${item.client}]: 내용(1) / - / <- / ->)이 비어 있습니다.`,
          });
        }
        contentBlocks += item.content.length;
      }
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return {
    ok: !hasError,
    issues,
    stats: {
      days: report.days.length,
      locations,
      clientItems,
      contentBlocks,
    },
  };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime());
}
