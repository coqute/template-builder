import type { ContentBlock, DialogTurn, WeekReport } from './types';
import { isNoteLine } from './types';
import { escapeContinuation, turnMarker } from './content';
import { formatItemHeader } from './item-header';
import { isBlankBlock } from './blank';

export interface SerializeOptions {
  includeAuthor?: boolean;
}

export function serialize(report: WeekReport, options: SerializeOptions = {}): string {
  const out: string[] = [];

  out.push(`@PREV ${report.prevWeekRange.start} ~ ${report.prevWeekRange.end}`);
  out.push(`@CURRENT ${report.currentWeekRange.start} ~ ${report.currentWeekRange.end}`);
  if (options.includeAuthor !== false && report.authorName) {
    out.push(`@AUTHOR ${report.authorName}`);
  }
  for (const plan of report.plans ?? []) {
    if (plan.text.trim()) out.push(`@PLAN ${plan.date} ${plan.text.trim()}`);
  }
  out.push('');

  for (const day of report.days) {
    out.push(`# ${day.date}(${day.weekday})`);

    if (day.holiday) {
      out.push(day.holiday.reason ? `@HOLIDAY ${day.holiday.reason}` : '@HOLIDAY');
      out.push('');
      continue;
    }

    if (day.partial) {
      out.push(day.partial.label ? `@HALFDAY ${day.partial.label}` : '@HALFDAY');
    }

    if (day.blocks.length === 0) {
      out.push('');
      continue;
    }

    day.blocks.forEach((block, blockIdx) => {
      // 빈 골격 행 — 텍스트 모드에서도 채울 자리가 보이도록 빈 @LOC·@CUS를 남긴다 (출력·검증은 무시)
      const scaffold = isBlankBlock(block);
      // inheritLocation=true이면 @LOC 생략 (직전 block과 장소 공유)
      if (!block.inheritLocation) {
        if (block.locations.length > 0) {
          out.push(`@LOC ${block.locations.join(' / ')}`);
        } else if (blockIdx > 0 || scaffold) {
          // 두 번째 이후 블록의 빈 장소 — 빈 @LOC 마커로 "새 블록"임을 명시.
          // 생략하면 파서가 직전 @LOC 아래 두 번째 @CUS로 해석해 장소를 상속시켜 표에 없던 지원장소가 표기된다.
          out.push('@LOC');
        }
      }
      if (block.customer) {
        out.push(`@CUS ${block.customer}`);
      } else if (scaffold) {
        out.push('@CUS');
      }

      block.items.forEach((item, itemIdx) => {
        // 머리가 모두 빈 항목은 `@SUM` 한 단어 — 텍스트 모드에서 `@SUM ` 뒤 항목 머리 자동완성이 그대로 뜬다
        const head = formatItemHeader(item, { escapeTitle: true, blankAsEmpty: true });
        out.push(head ? `@SUM ${head}` : '@SUM');
        let prev: ContentBlock | null = null;
        item.content.forEach((c) => {
          const lines = serializeContent(c);
          if (lines.length === 0) return;
          // 붙여 쓰면 다시 읽을 때 앞 블록에 흡수되는 조합 — 빈 줄로 끊는다(파서는 빈 줄에서 이어 붙이기를 멈춘다)
          if (prev && mergesIntoPrevious(prev, c, lines[0])) out.push('');
          out.push(...lines);
          prev = c;
        });
        if (itemIdx < block.items.length - 1) {
          out.push('');
        }
      });

      if (blockIdx < day.blocks.length - 1) {
        out.push('');
      }
    });

    out.push('');
  }

  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  return `${out.join('\n')}\n`;
}

/**
 * 빈 줄 없이 이어 쓰면 파서가 앞 블록에 붙여 버리는가.
 * - 번호·목록 뒤의 `- 목록` → 앞 번호의 세부 / 앞 목록의 항목이 된다
 * - 대화 뒤의 같은 들여쓰기 대화 → 한 대화로 합쳐진다
 * 비주얼 편집기에서 번호 블록 뒤에 목록 블록을 따로 만들면 화면에서는 두 블록인데, 저장했다 다시 열면
 * 목록이 번호의 세부로 바뀌어 들여쓰기·출력 모양이 달라졌다. (`>` 노트로 시작하는 블록은 빈 줄과 무관하게
 * 마지막 블록에 붙는 문법이라 여기서 끊을 수 없다.)
 */
function mergesIntoPrevious(prev: ContentBlock, next: ContentBlock, firstLine: string): boolean {
  if (next.kind === 'bullets') return (prev.kind === 'numbered' || prev.kind === 'bullets') && !isNoteLine(firstLine.trim());
  if (next.kind === 'dialog') return prev.kind === 'dialog' && (prev.indent ?? 0) === (next.indent ?? 0) && !firstLine.trim().startsWith('>');
  return false;
}

/** 들여쓰기 단계 → 줄 머리 공백 (2칸 = 1단계) */
function pad(block: ContentBlock): string {
  return '  '.repeat(block.indent ?? 0);
}

/**
 * 여러 줄 턴 — 첫 줄은 마커, 이어지는 줄은 마커 없이 한 단계 더 들여 쓴다 (파서가 직전 턴에 이어 붙임).
 * 이어지는 줄이 문법 줄처럼 보이면 `\`로 고정하고, 중간 빈 줄도 `\`로 보존한다 (끝의 빈 줄은 버림).
 * 빈 턴은 마커만 남긴다 — 골격(`->`·`<-`)이 편집 한 번에 사라지지 않게. 출력에서는 pruneBlank가 뺀다.
 */
function serializeTurn(turn: DialogTurn, p: string): string[] {
  const [first, ...rest] = turn.text.split('\n');
  while (rest.length > 0 && !rest[rest.length - 1].trim()) rest.pop();
  return [`${p}${turnMarker(turn)} ${first.trim()}`.trimEnd(), ...rest.map((r) => `${p}  ${escapeContinuation(r)}`)];
}

// 번호·목록의 빈 문자열 항목(비주얼 에디터 textarea의 빈 줄)은 생략 — `- `로 내보내면 재파싱 시 빈 항목이 남아 표에 빈 줄이 쌓인다
function serializeContent(block: ContentBlock): string[] {
  const p = pad(block);
  switch (block.kind) {
    case 'numbered': {
      const lines = [`${p}${block.index}) ${block.title}`];
      for (const d of block.details) {
        if (!d.trim()) continue;
        lines.push(`${p}${isNoteLine(d) ? d : `- ${d}`}`);
      }
      return lines;
    }
    case 'dialog':
      return block.turns.flatMap((t) => serializeTurn(t, p));
    case 'bullets':
      return block.items.filter((i) => i.trim()).map((i) => `${p}${isNoteLine(i) ? i : `- ${i}`}`);
  }
}
