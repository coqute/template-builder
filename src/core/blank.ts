/**
 * 빈 골격 판정·제거 단일 소스.
 * 새 주간보고·항목 추가가 만드는 "아직 쓰지 않은 틀"(빈 항목·빈 행·빈 턴)은 .md에는 남겨
 * 비주얼·텍스트 편집의 발판으로 쓰고, 출력(HTML·plain)과 검증에서는 없는 것으로 본다.
 * 그래야 골격을 지우지 않아도 메일에 "[고객사] 제목" 같은 자리 문구가 나가지 않고, 작성 전부터 경고가 쌓이지 않는다.
 */
import type { ClientItem, ContentBlock, DayEntry, LocationBlock, WeekReport } from './types';

const blank = (s: string | undefined): boolean => !s || !s.trim();

export function isBlankContent(c: ContentBlock): boolean {
  switch (c.kind) {
    case 'numbered':
      return blank(c.title) && c.details.every(blank);
    case 'dialog':
      return c.turns.every((t) => blank(t.text));
    case 'bullets':
      return c.items.every(blank);
  }
}

/** 머리(고객사·건물·담당자·채널·제목)와 본문이 모두 비어 있는 항목 */
export function isBlankItem(it: ClientItem): boolean {
  return (
    blank(it.client) &&
    blank(it.workType) &&
    blank(it.site) &&
    blank(it.contact) &&
    blank(it.channel) &&
    it.content.every(isBlankContent)
  );
}

/** 지원장소·고객사|작업구분이 비어 있고 항목도 모두 빈 행 */
export function isBlankBlock(b: LocationBlock): boolean {
  return b.locations.every(blank) && blank(b.customer) && b.items.every(isBlankItem);
}

/** 쓰지 않은 골격만 남은 날 (휴일·반차 표기는 별개) */
export function isBlankDay(d: DayEntry): boolean {
  return !d.holiday && d.blocks.every(isBlankBlock);
}

function pruneContent(c: ContentBlock): ContentBlock | null {
  switch (c.kind) {
    case 'numbered': {
      const details = c.details.filter((d) => !blank(d));
      return blank(c.title) && details.length === 0 ? null : { ...c, details };
    }
    case 'dialog': {
      const turns = c.turns.filter((t) => !blank(t.text));
      return turns.length === 0 ? null : { ...c, turns };
    }
    case 'bullets': {
      const items = c.items.filter((i) => !blank(i));
      return items.length === 0 ? null : { ...c, items };
    }
  }
}

function pruneItem(it: ClientItem): ClientItem {
  return { ...it, content: it.content.map(pruneContent).filter((c): c is ContentBlock => c !== null) };
}

/**
 * 출력용 사본 — 빈 항목·빈 행·빈 턴·빈 세부를 걷어낸다. 원본은 변경하지 않는다.
 * 앞 행이 빠져 장소 상속(inheritLocation)의 기준이 사라진 행은 자기 장소 칸을 갖게 한다.
 */
export function pruneBlank(report: WeekReport): WeekReport {
  return {
    ...report,
    days: report.days.map((day) => {
      if (day.holiday) return day;
      const kept: LocationBlock[] = [];
      let lastKept = -2;
      day.blocks.forEach((b, i) => {
        const block: LocationBlock = { ...b, items: b.items.filter((it) => !isBlankItem(it)).map(pruneItem) };
        if (isBlankBlock(block)) return;
        if (block.inheritLocation && lastKept !== i - 1) {
          const { inheritLocation: _drop, ...rest } = block;
          kept.push(rest);
        } else {
          kept.push(block);
        }
        lastKept = i;
      });
      return kept.length === day.blocks.length && kept.every((b, i) => b === day.blocks[i])
        ? day
        : { ...day, blocks: kept };
    }),
  };
}
