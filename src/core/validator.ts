import type { ValidationIssue, ValidationResult, WeekReport } from './types';
import { datesInRange, getWeekday, isLeaveBlock, isRealIsoDate } from './types';
import { isBlankBlock, isBlankContent, isBlankItem } from './blank';
import { checkRowCustomer, knownClients } from './customer';

/** 검증 규칙 — 주간보고 형식 명세 §5 */
export function validate(report: WeekReport): ValidationResult {
  const issues: ValidationIssue[] = [];
  let locations = 0;
  let clientItems = 0;
  let contentBlocks = 0;
  let pending = 0;
  // 이 보고서의 항목 [고객사] — 고객사|작업구분 칸 값이 고객사 이름인지 가르는 기준
  const known = knownClients(report);

  if (!isIsoDate(report.prevWeekRange.start) || !isIsoDate(report.prevWeekRange.end)) {
    issues.push({ severity: 'error', message: '@PREV 일자 형식이 YYYY-MM-DD가 아닙니다.' });
  }
  if (!isIsoDate(report.currentWeekRange.start) || !isIsoDate(report.currentWeekRange.end)) {
    issues.push({ severity: 'error', message: '@CURRENT 일자 형식이 YYYY-MM-DD가 아닙니다.' });
  }
  if (
    isIsoDate(report.prevWeekRange.start) &&
    isIsoDate(report.prevWeekRange.end) &&
    report.prevWeekRange.start > report.prevWeekRange.end
  ) {
    issues.push({ severity: 'error', message: '@PREV 시작 일자가 종료 일자보다 늦습니다.' });
  }

  if (report.days.length === 0) {
    issues.push({
      severity: 'error',
      message: '일자(`# YYYY-MM-DD(요일)`)가 하나도 없습니다.',
      hint: '예: # 2026-04-27(월)',
    });
  }

  const rangeDates = datesInRange(report.prevWeekRange);
  const inRange = new Set(rangeDates);

  const seen = new Set<string>();
  for (const day of report.days) {
    if (!isIsoDate(day.date)) {
      issues.push({ severity: 'error', line: day.srcLine, message: `일자 "${day.date}" 형식이 잘못되었습니다.`, hint: 'YYYY-MM-DD 형식의, 달력에 있는 날짜여야 합니다.' });
      continue;
    }
    if (seen.has(day.date)) {
      issues.push({ severity: 'warning', line: day.srcLine, message: `일자 ${day.date}가 중복되었습니다.` });
    }
    seen.add(day.date);

    if (rangeDates.length > 0 && !inRange.has(day.date)) {
      issues.push({
        severity: 'warning',
        line: day.srcLine,
        message: `일자 ${day.date}가 보고 주(${report.prevWeekRange.start} ~ ${report.prevWeekRange.end}) 범위 밖입니다.`,
        hint: '@PREV 범위를 확인하거나 해당 일자를 다음 주 보고서로 옮기세요.',
      });
    }

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

    // 쓰지 않은 골격 행·항목은 없는 것으로 본다 — 새 주간보고를 열자마자 경고가 쌓이지 않게 (출력에서도 빠짐)
    const blocks = day.blocks.filter((b) => !isBlankBlock(b));
    if (blocks.length === 0) {
      // 반차만 기록된 날·토/일 빈 행은 의도된 형태 — 안내 면제 (docs §5.5).
      // 작성 중에는 아직 비어 있는 날이 당연하므로 경고가 아닌 정보로 알린다
      const weekend = day.weekday === '토' || day.weekday === '일';
      if (!day.partial && !weekend) {
        issues.push({
          severity: 'info',
          line: day.srcLine,
          message: `${day.date}: 아직 작성하지 않은 날입니다.`,
          hint: '작업을 쓰거나, 휴가면 [휴가], 공휴일이면 [휴일]로 표시하세요.',
        });
      }
      continue;
    }

    for (const block of blocks) {
      locations += 1;
      const leave = isLeaveBlock(block);
      if (block.locations.length === 0) {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: @LOC 지원장소가 비어 있습니다.`,
          hint: '방문한 건물(예: MX(누리사옥)) 또는 근무 위치(파트너사·회사·외부·휴가)를 적으세요.',
        });
      }
      if (!leave && (!block.customer || !block.customer.trim())) {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: @CUS 고객사|작업구분이 비어 있습니다.`,
        });
      }
      const items = block.items.filter((it) => !isBlankItem(it));
      if (items.length === 0) {
        if (!leave) {
          issues.push({
            severity: 'warning',
            line: block.srcLine ?? day.srcLine,
            message: `${day.date}: ${block.locations.join(' / ') || '(LOC 미지정)'} 블록에 @SUM 항목이 없습니다.`,
          });
        }
        continue;
      }

      // 행의 고객사|작업구분 ↔ 항목의 [고객사] — 칸 값이 고객사 이름일 때만 비교, 블록당 1건 (docs §3.2, §5.2).
      // 팀·부서명(`한강 SRE`)은 고객사 안의 구분이라 비교하지 않는다. 아는 값과 한 글자 차이면 오타로 알린다.
      const rowCheck = checkRowCustomer(block, items.map((it) => it.client), known);
      if (rowCheck.kind === 'mismatch') {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: 고객사|작업구분 "${block.customer}"와 항목 ${rowCheck.clients.map((c) => `[${c}]`).join(' ')}가 다릅니다.`,
          hint: '고객사 이름을 쓸 때는 항목의 [고객사]와 같게 쓰세요. 팀·부서명(예: 한강 SRE)은 비교하지 않습니다.',
        });
      } else if (rowCheck.kind === 'typo') {
        issues.push({
          severity: 'warning',
          line: block.srcLine ?? day.srcLine,
          message: `${day.date}: 고객사|작업구분 "${block.customer}"가 "${rowCheck.near}"와 한 글자 다릅니다.`,
          hint: '오타면 고쳐 주세요. 일부러 쓴 팀·부서명이면 그대로 두어도 됩니다.',
        });
      }

      for (const item of items) {
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
            message: `${day.date} [${item.client}]: 제목(작업 설명)이 비어 있습니다.`,
          });
        }
        if (item.content.every(isBlankContent) && !leave) {
          // 괄호·제목만으로 끝나는 짧은 항목(정기점검 등)도 흔해 info로 안내
          issues.push({
            severity: 'info',
            line: item.srcLine ?? block.srcLine ?? day.srcLine,
            message: `${day.date} [${item.client}]: 본문(1) / -> / <- / -)이 없습니다.`,
          });
        }
        contentBlocks += item.content.filter((c) => !isBlankContent(c)).length;
        for (const c of item.content) {
          if (c.kind === 'dialog') pending += c.turns.filter((t) => t.pending && t.text.trim()).length;
        }
      }
    }
  }

  // 월~일 중 빠진 요일 — 7일 모두 표기 권장 (docs §3, §5.3)
  if (rangeDates.length > 0 && rangeDates.length <= 14 && report.days.length > 0) {
    const missing = rangeDates.filter((d) => !seen.has(d));
    if (missing.length > 0) {
      const label = missing
        .map((d) => {
          try {
            return `${d.slice(5)}(${getWeekday(d)})`;
          } catch {
            return d;
          }
        })
        .join(', ');
      issues.push({
        severity: 'info',
        message: `빠진 일자 ${missing.length}일: ${label} — 일이 없던 날도 빈 행으로 표기합니다.`,
        hint: '비주얼 모드 하단 [빠진 일자 채우기]로 한 번에 추가할 수 있습니다.',
      });
    }
  }

  // @PLAN — 다음 주(@CURRENT) 범위 안
  const planRange = new Set(datesInRange(report.currentWeekRange));
  for (const plan of report.plans ?? []) {
    if (planRange.size > 0 && !planRange.has(plan.date)) {
      issues.push({
        severity: 'warning',
        line: plan.srcLine,
        message: `@PLAN ${plan.date}가 일정 예정 범위(${report.currentWeekRange.start} ~ ${report.currentWeekRange.end}) 밖입니다.`,
      });
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
      pending,
    },
  };
}

function isIsoDate(s: string): boolean {
  return isRealIsoDate(s);
}
