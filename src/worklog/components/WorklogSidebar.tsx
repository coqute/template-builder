import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Search, X } from 'lucide-react';
import type { WorklogEntry, WorklogFileText } from '../../../electron/worklog-types';
import { weekdayOf } from '../format';
import { searchWorklogs, type SearchHit } from '../search';
import { sameRef } from '../useWorklog';

interface Props {
  files: WorklogEntry[];
  corpus: WorklogFileText[];
  current: WorklogEntry | null;
  dirty: boolean;
  onOpen: (entry: WorklogEntry, line?: number) => void;
}

export interface WorklogSidebarHandle {
  focusSearch(): void;
}

/** 폴더 이름 줄임 — 'AB Z+ 작업' → 'AB Z+', '기타 작업 내용' → '기타' */
export function folderLabel(folder: string): string {
  if (!folder) return '기본';
  return folder.replace(/\s*(작업\s*내용|작업)$/, '').trim() || folder;
}

/** 파일 목록(월별) + 전체 검색 — 검색어가 있으면 결과로 바뀐다 */
export const WorklogSidebar = forwardRef<WorklogSidebarHandle, Props>(function WorklogSidebar(
  { files, corpus, current, dirty, onOpen },
  ref,
) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useImperativeHandle(ref, () => ({ focusSearch: () => inputRef.current?.focus() }), []);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(id);
  }, [query]);

  const folders = useMemo(() => [...new Set(files.map((f) => f.folder))], [files]);
  const shown = useMemo(() => files.filter((f) => folder === null || f.folder === folder), [files, folder]);
  const months = useMemo(() => {
    const m = new Map<string, WorklogEntry[]>();
    for (const f of shown) m.set(f.date.slice(0, 7), [...(m.get(f.date.slice(0, 7)) ?? []), f]);
    return [...m.entries()];
  }, [shown]);
  const hits = useMemo<SearchHit[]>(
    () => (debounced.trim() ? searchWorklogs(corpus.filter((f) => folder === null || f.folder === folder), debounced) : []),
    [corpus, debounced, folder],
  );
  const entryOf = (h: SearchHit) => files.find((f) => f.folder === h.folder && f.name === h.name);

  return (
    <aside className="flex h-full flex-col border-r border-rule bg-bg-deep" aria-label="작업일지 목록">
      <div className="border-b border-rule p-2">
        <label className="flex items-center gap-1.5 rounded-sharp border border-rule-input bg-bg px-2 py-1">
          <Search size={13} className="shrink-0 text-fg-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
              if (e.key === 'Enter' && hits[0]) {
                const en = entryOf(hits[0]);
                if (en) onOpen(en, hits[0].lines[0]?.no);
              }
            }}
            placeholder="전체 일지 검색 (Ctrl+F)"
            aria-label="전체 일지 검색"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-muted"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기" className="text-fg-muted hover:text-fg">
              <X size={12} />
            </button>
          )}
        </label>
        {folders.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1" role="radiogroup" aria-label="폴더">
            {[null, ...folders].map((f) => (
              <button
                key={f ?? '*'}
                type="button"
                role="radio"
                aria-checked={folder === f}
                onClick={() => setFolder(f)}
                className={[
                  'rounded-sharp border px-1.5 py-0.5 text-[10.5px] leading-none',
                  folder === f ? 'border-fg font-semibold text-fg' : 'border-rule text-fg-soft hover:text-fg',
                ].join(' ')}
                title={f ?? '모든 폴더'}
              >
                {f === null ? '전체' : folderLabel(f)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {debounced.trim() ? (
          hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-fg-muted">찾는 낱말이 모두 든 일지가 없습니다.</p>
          ) : (
            <ul aria-label="검색 결과">
              <li className="px-3 pb-1 pt-2 text-[10.5px] text-fg-muted">{hits.length}개 일지</li>
              {hits.map((h) => {
                const en = entryOf(h);
                return (
                  <li key={`${h.folder}/${h.name}`} className="border-b border-rule-thin">
                    <button
                      type="button"
                      disabled={!en}
                      onClick={() => en && onOpen(en, h.lines[0]?.no)}
                      className="block w-full px-3 pt-1.5 text-left text-[12px] font-semibold text-fg hover:bg-bg-sunken"
                      title={h.name}
                    >
                      {h.date.slice(5)} ({weekdayOf(h.date)}) <span className="font-normal text-fg-soft">{h.title}</span>
                    </button>
                    <ul className="pb-1.5">
                      {h.lines.map((l) => (
                        <li key={l.no}>
                          <button
                            type="button"
                            disabled={!en}
                            onClick={() => en && onOpen(en, l.no)}
                            className="block w-full truncate px-3 py-0.5 text-left text-[11.5px] text-fg-soft hover:bg-bg-sunken hover:text-fg"
                            title={l.text}
                          >
                            <span className="mr-1 text-fg-faint">{l.no}</span>
                            <Marked text={l.text.trim()} ranges={shiftRanges(l.text, l.ranges)} />
                          </button>
                        </li>
                      ))}
                      {h.total > h.lines.length && <li className="px-3 text-[10.5px] text-fg-muted">… {h.total - h.lines.length}줄 더</li>}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )
        ) : months.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-fg-muted">일지가 없습니다.</p>
        ) : (
          months.map(([month, list]) => (
            <section key={month}>
              <h3 className="sticky top-0 z-[1] bg-bg-deep px-3 pb-0.5 pt-2 text-[10.5px] font-semibold text-fg-muted">
                {month.replace('-', '. ')}월 · {list.length}
              </h3>
              <ul>
                {list.map((f) => {
                  const active = sameRef(f, current);
                  return (
                    <li key={`${f.folder}/${f.name}`}>
                      <button
                        type="button"
                        onClick={() => onOpen(f)}
                        aria-current={active ? 'true' : undefined}
                        className={[
                          'flex w-full items-baseline gap-1.5 px-3 py-1 text-left text-[12px]',
                          active ? 'bg-bg-sunken font-semibold text-fg' : 'text-fg-soft hover:bg-bg-sunken hover:text-fg',
                        ].join(' ')}
                        title={`${f.folder ? `${f.folder} › ` : ''}${f.name}`}
                      >
                        <span className="shrink-0 tabular-nums">
                          {f.date.slice(5)} {weekdayOf(f.date)}
                        </span>
                        {folders.length > 1 && folder === null && (
                          <span className="shrink-0 rounded-sharp border border-rule px-1 text-[9.5px] leading-tight text-fg-muted">{folderLabel(f.folder)}</span>
                        )}
                        <span className="min-w-0 flex-1 truncate">{f.title || '(제목 없음)'}</span>
                        {active && dirty && <span aria-label="저장 전">●</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
});

/** 앞 공백을 뗀 만큼 일치 구간을 당긴다 */
function shiftRanges(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
  const lead = text.length - text.trimStart().length;
  return ranges.map(([a, b]) => [Math.max(0, a - lead), Math.max(0, b - lead)]);
}

function Marked({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (b <= at) return;
    const s = Math.max(a, at);
    if (s > at) out.push(<span key={`t${i}`}>{text.slice(at, s)}</span>);
    out.push(
      <mark key={`m${i}`} className="rounded-sharp px-0.5 text-fg" style={{ background: 'var(--selection)' }}>
        {text.slice(s, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(<span key="end">{text.slice(at)}</span>);
  return <>{out}</>;
}
