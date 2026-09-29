/**
 * 지난주 미결 이월 — 새 주간보고를 만들 때 지난주 보고서에서 아직 끝나지 않은 건을 찾아낸다.
 * 이월 목록은 .md에 쓰지 않는다(출력 오염 방지). 사용자가 날짜를 고르면 그날 항목으로 이어 쓴다 (edit.placeItem).
 */
import type { ClientItem, LocationBlock, WeekReport } from './types';
import { formatItemHeader } from './item-header';
import { isBlankItem } from './blank';

export interface CarryItem {
  /** 원래 행 — 같은 지원장소·고객사 행으로 이어 쓰기 위해 */
  locations: string[];
  customer: string;
  header: Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>;
  /** 남은 미결 턴 — 목록에 보여 줄 내용 (`*<-` 내 후속 조치 · `*->` 상대 회신 대기) */
  pending: Array<{ kind: 'in' | 'out'; text: string }>;
  /** 지난주 보고에서 마지막으로 기록된 날 */
  lastDate: string;
}

/** 같은 건 판별 — 항목 머리 전체(고객사·건물·담당자·채널·제목), 공백·대소문자 무시 */
function headerKey(it: Pick<ClientItem, 'client' | 'site' | 'contact' | 'channel' | 'workType'>): string {
  return formatItemHeader(it).replace(/\s+/g, '').toLowerCase();
}

/**
 * 끝나지 않은 건 — 같은 건(항목 머리)이 여러 날에 이어 쓰였으면 마지막 기록만 본다.
 * 마지막 기록에 내용이 있는 미결 턴이 남아 있으면 미결. 이어 쓴 뒤 미결을 풀었으면 제외된다.
 */
export function collectOpenItems(report: WeekReport): CarryItem[] {
  const latest = new Map<string, { item: ClientItem; block: LocationBlock; date: string }>();
  for (const day of report.days) {
    if (day.holiday) continue;
    for (const block of day.blocks) {
      for (const item of block.items) {
        if (isBlankItem(item)) continue;
        latest.set(headerKey(item), { item, block, date: day.date });
      }
    }
  }
  const out: CarryItem[] = [];
  for (const { item, block, date } of latest.values()) {
    const pending = item.content.flatMap((c) =>
      c.kind === 'dialog'
        ? c.turns
            .filter((t) => t.pending && t.text.trim() && (t.kind === 'in' || t.kind === 'out'))
            .map((t) => ({ kind: t.kind as 'in' | 'out', text: t.text.trim() }))
        : [],
    );
    if (pending.length === 0) continue;
    out.push({
      locations: [...block.locations],
      customer: block.customer,
      header: {
        client: item.client,
        ...(item.site ? { site: item.site } : {}),
        ...(item.contact ? { contact: item.contact } : {}),
        ...(item.channel ? { channel: item.channel } : {}),
        workType: item.workType,
      },
      pending,
      lastDate: date,
    });
  }
  return out.sort((a, b) => a.lastDate.localeCompare(b.lastDate));
}

/** 후보 보고서 중 새 보고 주(prevStart)보다 앞선 가장 최근 주 — 없으면 undefined */
export function pickPreviousReport<T extends { report: WeekReport }>(
  candidates: readonly T[],
  prevStart: string,
): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    const start = c.report.prevWeekRange.start;
    if (!start || start >= prevStart) continue;
    if (!best || start > best.report.prevWeekRange.start) best = c;
  }
  return best;
}
