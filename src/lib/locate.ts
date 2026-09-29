import type { WeekReport } from '@core/index';

/**
 * .md 줄 번호 → 비주얼 편집기 위치. 그 줄이 속한 일자 안에서 줄 앞에 있는 마지막 항목(`di-bi-ii`),
 * 항목이 없으면 일자만. 파싱 결과의 srcLine 기준이라 직렬화 왕복과 인덱스가 맞는다.
 */
export function locateLine(report: WeekReport | undefined, line: number): { key?: string; date?: string } {
  if (!report || line <= 0) return {};
  let found: { key?: string; date?: string } = {};
  report.days.forEach((day, di) => {
    if ((day.srcLine ?? Infinity) > line) return;
    found = { date: day.date };
    day.blocks.forEach((b, bi) =>
      b.items.forEach((it, ii) => {
        if ((it.srcLine ?? Infinity) <= line) found = { key: `${di}-${bi}-${ii}`, date: day.date };
      }),
    );
  });
  return found;
}

/** 항목 키 → .md 줄 번호 (없으면 0) */
export function lineOfKey(report: WeekReport | undefined, key: string | null): number {
  if (!report || !key) return 0;
  const [di, bi, ii] = key.split('-').map(Number);
  return report.days[di]?.blocks[bi]?.items[ii]?.srcLine ?? 0;
}
