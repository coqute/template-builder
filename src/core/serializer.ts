import type { ContentBlock, WeekReport } from './types';
import { isNoteLine } from './types';

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
  out.push('');

  for (const day of report.days) {
    out.push(`# ${day.date}(${day.weekday})`);

    if (day.holiday) {
      out.push(day.holiday.reason ? `@HOLIDAY ${day.holiday.reason}` : '@HOLIDAY');
      out.push('');
      continue;
    }

    if (day.blocks.length === 0) {
      out.push('');
      continue;
    }

    day.blocks.forEach((block, blockIdx) => {
      // inheritLocation=true이면 @LOC 생략 (직전 block과 장소 공유)
      if (!block.inheritLocation && block.locations.length > 0) {
        out.push(`@LOC ${block.locations.join(' / ')}`);
      }
      if (block.customer) {
        out.push(`@CUS ${block.customer}`);
      }

      block.items.forEach((item, itemIdx) => {
        const head = formatClientHead(item);
        out.push(`@SUM ${head}`);

        item.content.forEach((c) => {
          out.push(...serializeContent(c));
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

function formatClientHead(item: { client: string; contact?: string; channel?: string; workType: string }): string {
  const head = item.contact
    ? item.channel
      ? `[${item.client}] (${item.contact}/${item.channel})`
      : `[${item.client}] (${item.contact})`
    : `[${item.client}]`;
  return item.workType ? `${head} ${item.workType}` : head;
}

function serializeContent(block: ContentBlock): string[] {
  switch (block.kind) {
    case 'numbered': {
      const lines = [`${block.index}) ${block.title}`];
      for (const d of block.details) {
        lines.push(isNoteLine(d) ? d : `- ${d}`);
      }
      return lines;
    }
    case 'qa': {
      const lines: string[] = [];
      if (block.question) lines.push(`<- ${block.question}`);
      for (const a of block.answers) {
        lines.push(isNoteLine(a) ? a : `-> ${a}`);
      }
      return lines;
    }
    case 'bullets': {
      return block.items.map((i) => (isNoteLine(i) ? i : `- ${i}`));
    }
  }
}
