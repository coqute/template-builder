/**
 * 고른 날의 미리보기 — 띠에서 날을 누르면 화면 가운데에 그날의 일정·다른 달력·할 일·Notion 작성이 열린다 (설계 §19.11).
 * 날 칸은 좁아 여러 건이 겹치면 제목이 잘린다 — 여기서 전부를 제대로 읽고, 달력·일지·Notion으로 넘어간다.
 *
 * - 가운데에 띄운다(Notion의 가운데 미리보기처럼): 아래로 펼치면 화면이 밀리고 줄이 가로로 길게 늘어진다.
 *   Mac의 훑어보기처럼 — 누른 날 칸의 자리와 크기에서 부드럽게 커지며 열리고, 닫을 때는 (지금 보고 있는 날의) 칸으로 돌아간다.
 * - 띠가 가려지므로 머리에 그 주의 날 줄과 ‹ ›를 둔다 — 닫지 않고 옆 날로 넘어간다(← → 키도 같다).
 * - 날을 넘겨도 창의 자리·너비·단 구성이 같다(왼쪽 = 일정·다른 달력, 오른쪽 = 할 일·Notion) — 같은 것이 늘 같은 자리에 있다.
 * - 읽기만 한다. 고치는 것은 아래 할 일·확정 일정에서 한다.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { KIND_LABEL, type HomeEvent } from '../classify';
import { fadeIn, growFrom, leave } from '../../lib/motion';
import { diffDays, dowOf, toDate } from '../dates';
import type { StripDay } from '../model';
import type { NotionItem } from '../sources/notion';
import type { NotionPage, Task } from '../types';
import { cx, NotionMark, ownerLabel } from './HomeParts';

interface Props {
  today: string;
  day: StripDay;
  /** 띠의 모든 날(날짜순) — 옆 날로 넘어가는 범위 */
  days: StripDay[];
  /** 그날에 든 것의 수(일정 + 다른 달력 + 할 일 + Notion) — 날 줄의 점 */
  countOf(date: string): number;
  /** 그날이 기한인 열린 할 일 — 오늘이면 기한이 지난 것도 */
  tasks: Task[];
  /** 그날 Notion에 쓴 것 */
  notion: NotionItem[];
  /** 일정 키 → 그 일정의 Notion 회의록 */
  notes: Map<string, NotionPage[]>;
  /** 일지 사안과 이어진 일정의 키 */
  linked: Set<string>;
  onOpenEvent(e: HomeEvent): void;
  onOpenCase(e: HomeEvent): void;
  onOpenUrl(url: string, what: string): void;
  /** 닫고, 아래 할 일 목록에서 그 줄로 간다 */
  onTask(id: string): void;
  /** 다른 날로 */
  onMove(date: string): void;
  /** 그날에 일정을 만든다 — 달력에 쓸 수 있을 때만 */
  onAddEvent?(): void;
  onClose(): void;
}

/** 오늘에서 본 그날 — 기한이 아니라 날짜라서 지난 날은 "n일 전"이다 */
function dayFrom(today: string, date: string): string {
  const d = diffDays(today, date);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === -1) return '어제';
  return d > 0 ? `${d}일 뒤` : `${-d}일 전`;
}

const fullDate = (iso: string): string => {
  const d = toDate(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${dowOf(iso)}요일`;
};

export function DayPreview({ today, day, days, countOf, tasks, notion, notes, linked, onOpenEvent, onOpenCase, onOpenUrl, onTask, onMove, onAddEvent, onClose }: Props) {
  const box = useRef<HTMLDivElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  /**
   * 띠에서 그 날의 칸이 있는 자리 — 창이 여기서 커지고 여기로 닫힌다.
   * 칸이 없거나 스크롤로 화면 밖으로 밀려나 있으면 null — 보이지 않는 곳으로 날아가지 않고 가운데에서 살짝 작아진다.
   */
  const cellRect = (date: string): DOMRect | null => {
    const r = document.querySelector(`.hm-day[data-date="${date}"]`)?.getBoundingClientRect();
    if (!r || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return null;
    return r;
  };
  // 열릴 때 — 그리기 전에 시작 모습을 잡아야 제자리에 한 번 번쩍이지 않는다
  useLayoutEffect(() => {
    growFrom(box.current, cellRect(day.date));
    fadeIn(scrim.current);
    // 처음 열릴 때 한 번만 — 옆 날로 넘어갈 때는 창이 그대로 있고 내용만 갈린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 닫는다 — 지금 보고 있는 날의 칸으로 줄어든 뒤에 떼어 낸다. `after`는 닫힌 다음에 할 일 */
  const close = useCallback(
    (after?: () => void) => {
      leave(box.current, scrim.current, cellRect(day.date), () => {
        onClose();
        after?.();
      });
    },
    [day.date, onClose],
  );
  const at = days.findIndex((d) => d.date === day.date);
  const prev = at > 0 ? days[at - 1].date : null;
  const next = at >= 0 && at < days.length - 1 ? days[at + 1].date : null;
  // 그 주의 날(월~일) — 띠는 월요일부터 7일씩이다
  const week = at >= 0 ? days.slice(at - (at % 7), at - (at % 7) + 7) : [day];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && prev) onMove(prev);
      else if (e.key === 'ArrowRight' && next) onMove(next);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, onMove, prev, next]);

  // 열릴 때 창으로 초점을 옮긴다(화면 낭독기·키보드)
  useEffect(() => {
    box.current?.focus();
  }, []);

  const left = day.events.length + day.others.length > 0;
  const right = tasks.length + notion.length > 0;
  const counts = [
    day.events.length && `일정 ${day.events.length}`,
    day.others.length && `다른 달력 ${day.others.length}`,
    tasks.length && `할 일 ${tasks.length}`,
    notion.length && `Notion ${notion.length}`,
  ].filter(Boolean);

  const time = (e: HomeEvent) => (
    <span className="hm-pk-t hm-num">
      {e.allDay ? '종일' : e.startTime}
      {!e.allDay && e.endTime && <small>~ {e.endTime}</small>}
    </span>
  );

  return (
    <div ref={scrim} className="hm-pk-scrim" onMouseDown={() => close()}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${fullDate(day.date)} 미리보기`} className="hm-pk" data-testid="home-day" data-date={day.date} onMouseDown={(e) => e.stopPropagation()}>
        <header className="hm-pk-h">
          <div className="hm-pk-top">
            <button type="button" className="hm-pk-nav" aria-label="앞 날" title="앞 날 (←)" disabled={!prev} onClick={() => prev && onMove(prev)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="hm-pk-nav" aria-label="뒷 날" title="뒷 날 (→)" disabled={!next} onClick={() => next && onMove(next)}>
              <ChevronRight size={16} />
            </button>
            <h2>
              {fullDate(day.date)}
              <span className={cx('hm-pk-rel', day.today && 'is-today')}>{dayFrom(today, day.date)}</span>
            </h2>
            <button type="button" className="hm-pk-nav hm-pk-x" aria-label="닫기 (Esc)" onClick={() => close()}>
              <X size={16} />
            </button>
          </div>
          <div className="hm-pk-sum">
            {day.off && <b className="hm-pk-off">{day.off}</b>}
            {day.place && <span className="hm-chip">{day.place}</span>}
            <span>{counts.length ? counts.join(' · ') : '잡힌 것 없음'}</span>
          </div>
          {/* 그 주의 날 — 띠가 가려져 있으므로 여기서 옆 날로 넘어간다 */}
          <div className="hm-pk-wk" role="group" aria-label="그 주의 날">
            {week.map((d) => {
              const n = countOf(d.date);
              return (
                <button
                  key={d.date}
                  type="button"
                  className={cx('hm-pk-d', d.date === day.date && 'is-sel', d.today && 'is-today', (d.weekend || (d.off && !d.offPart)) && 'is-red')}
                  aria-pressed={d.date === day.date}
                  aria-label={`${fullDate(d.date)} — ${n}건`}
                  onClick={() => onMove(d.date)}
                >
                  <span>{dowOf(d.date)}</span>
                  <b className="hm-num">{toDate(d.date).getDate()}</b>
                  {n > 0 && <i className="hm-num">{n}</i>}
                </button>
              );
            })}
          </div>
        </header>

        <div className="hm-pk-b">
          {!left && !right ? (
            <p className="hm-pk-none">이 날에는 일정·할 일·Notion 작성이 없습니다.</p>
          ) : (
            <div key={day.date} className="hm-pk-g tb-swap">
              <div className="hm-pk-col">
                {!left && <p className="hm-pk-nil">일정 없음</p>}
                  {day.events.length > 0 && (
                    <section data-group="events">
                      <div className="hm-cap">
                        일정 <i className="hm-num">{day.events.length}</i>
                      </div>
                      {day.events.map((e) => (
                        <div className="hm-pk-r" key={e.key}>
                          {time(e)}
                          <span className="hm-pk-n">
                            <b>{e.title}</b>
                            <small>
                              {KIND_LABEL[e.kind]}
                              {e.client ? ` · ${e.client}` : ''}
                              {e.location ? ` · ${e.location}` : ''}
                              {e.source === 'plan' ? ' · 주간보고 일정 예정' : ''}
                            </small>
                            {(e.htmlLink || linked.has(e.key) || notes.has(e.key)) && (
                              <span className="hm-pk-l">
                                {(notes.get(e.key) ?? []).map((n) => (
                                  <button key={n.id} type="button" className="hm-org" title={`Notion 회의록 — ${n.title}`} aria-label={`Notion 회의록 열기 — ${e.title}`} onClick={() => onOpenUrl(n.url, 'Notion 회의록을')}>
                                    <NotionMark /> 회의록 ↗
                                  </button>
                                ))}
                                {linked.has(e.key) && (
                                  <button type="button" className="hm-org" aria-label={`이어진 일지 사안 열기 — ${e.title}`} onClick={() => onOpenCase(e)}>
                                    일지 ↗
                                  </button>
                                )}
                                {e.htmlLink && (
                                  <button type="button" className="hm-org" aria-label={`달력에서 열기 — ${e.title}`} onClick={() => onOpenEvent(e)}>
                                    달력 ↗
                                  </button>
                                )}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </section>
                  )}
                  {day.others.length > 0 && (
                    <section data-group="others">
                      <div className="hm-cap">
                        다른 달력 <i className="hm-num">{day.others.length}</i>
                      </div>
                      {day.others.map((e) => (
                        <div className="hm-pk-r is-other" key={e.key}>
                          {time(e)}
                          <span className="hm-pk-n">
                            <b>{e.title}</b>
                            <small title={e.owner}>
                              {ownerLabel(e.owner) || '다른 달력'}
                              {e.location ? ` · ${e.location}` : ''}
                            </small>
                          </span>
                          {e.htmlLink && (
                            <button type="button" className="hm-org hm-pk-side" aria-label={`달력에서 열기 — ${e.title}`} onClick={() => onOpenEvent(e)}>
                              달력 ↗
                            </button>
                          )}
                        </div>
                      ))}
                    </section>
                  )}
              </div>
              <div className="hm-pk-col">
                {!right && <p className="hm-pk-nil">할 일·Notion 작성 없음</p>}
                  {tasks.length > 0 && (
                    <section data-group="tasks">
                      <div className="hm-cap">
                        할 일 <i className="hm-num">{tasks.length}</i>
                      </div>
                      {tasks.map((t) => {
                        const late = t.due && t.due < today ? diffDays(t.due, today) : 0;
                        return (
                          <button type="button" className="hm-pk-r is-btn" key={t.id} aria-label={`할 일로 가기 — ${t.title}`} title="닫고, 아래 할 일 목록에서 이 줄로 갑니다" onClick={() => close(() => onTask(t.id))}>
                            <span className={cx('hm-pk-t', late > 0 && 'is-late')}>{late > 0 ? `${late}일 지남` : '이 날까지'}</span>
                            <span className="hm-pk-n">
                              <b>{t.title}</b>
                              {(t.client || t.who) && <small>{[t.client, t.who].filter(Boolean).join(' · ')}</small>}
                            </span>
                          </button>
                        );
                      })}
                    </section>
                  )}
                  {notion.length > 0 && (
                    <section data-group="notion">
                      <div className="hm-cap">
                        <NotionMark /> Notion 작성 <i className="hm-num">{notion.length}</i>
                      </div>
                      {notion.map((n) => (
                        <button
                          type="button"
                          className="hm-pk-r is-btn"
                          key={`${n.id}:${n.fresh ? 'new' : 'edit'}`}
                          aria-label={`Notion에서 열기 — ${n.title}`}
                          title="Notion에서 이 페이지를 엽니다"
                          onClick={() => onOpenUrl(n.url, 'Notion에서 이 페이지를')}
                        >
                          <span className="hm-pk-t hm-num">{n.time}</span>
                          <span className="hm-pk-n">
                            <b>{n.title}</b>
                            <small>
                              {n.source?.name ?? 'DB 밖의 페이지'} · {n.fresh ? '새로 만듦' : '고침'}
                            </small>
                          </span>
                          <span className="hm-pk-go">↗</span>
                        </button>
                      ))}
                    </section>
                  )}
              </div>
            </div>
          )}
        </div>

        <footer className="hm-pk-f">
          <span>← → 옆 날 · Esc 닫기</span>
          {onAddEvent && day.date >= today && (
            <button type="button" className="hm-mini" onClick={onAddEvent} title="Google 달력에 이 날의 일정을 만듭니다">
              ＋ 이 날에 일정 추가
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
