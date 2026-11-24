/**
 * 고른 날의 미리보기 — 띠에서 날을 누르면 그날의 일정·다른 달력·할 일·Notion 작성을 한데 펼쳐 보여 준다 (설계 §19.11).
 * 날 칸은 좁아 여러 건이 겹치면 제목이 잘린다 — 여기서 전부를 제대로 읽고, 달력·일지·Notion으로 넘어간다.
 * 읽기만 한다. 고치는 것은 아래 할 일·확정 일정에서 한다.
 */
import { KIND_LABEL, type HomeEvent } from '../classify';
import { diffDays, mdw } from '../dates';
import type { StripDay } from '../model';
import type { NotionItem } from '../sources/notion';
import type { NotionPage, Task } from '../types';
import { cx, NotionMark, ownerLabel } from './HomeParts';

interface Props {
  today: string;
  day: StripDay;
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
  /** 아래 할 일 목록에서 그 줄로 간다 */
  onTask(id: string): void;
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

const when = (e: HomeEvent): string => (e.allDay ? '종일' : `${e.startTime}${e.endTime ? ` ~ ${e.endTime}` : ''}`);

export function DayPreview({ today, day, tasks, notion, notes, linked, onOpenEvent, onOpenCase, onOpenUrl, onTask, onClose }: Props) {
  const empty = day.events.length + day.others.length + tasks.length + notion.length === 0 && !day.off;
  const counts = [
    day.events.length && `일정 ${day.events.length}`,
    day.others.length && `다른 달력 ${day.others.length}`,
    tasks.length && `할 일 ${tasks.length}`,
    notion.length && `Notion ${notion.length}`,
  ].filter(Boolean);

  return (
    <section className="hm-dp" aria-label={`${mdw(day.date)} 미리보기`} data-testid="home-day">
      <div className="hm-dp-h">
        <b className="hm-num">{mdw(day.date)}</b>
        <span>{dayFrom(today, day.date)}</span>
        {day.off && <span className="hm-dp-off">{day.off}</span>}
        {day.place && <span className="hm-chip">{day.place}</span>}
        <span className="hm-dp-c">{counts.join(' · ')}</span>
        <button type="button" className="hm-mini" onClick={onClose} title="날 칸을 다시 눌러도 닫힙니다">
          닫기
        </button>
      </div>
      {empty ? (
        <p className="hm-note">이 날에는 일정·할 일·Notion 작성이 없습니다.</p>
      ) : (
        <div className="hm-dp-g">
          {day.events.length > 0 && (
            <div data-group="events">
              <div className="hm-cap">
                일정 <i className="hm-num">{day.events.length}</i>
              </div>
              {day.events.map((e) => (
                <div className="hm-dp-r" key={e.key}>
                  <span className="hm-dp-t hm-num">{when(e)}</span>
                  <span className="hm-dp-n">
                    <b>{e.title}</b>
                    <small>
                      {KIND_LABEL[e.kind]}
                      {e.client ? ` · ${e.client}` : ''}
                      {e.location ? ` · ${e.location}` : ''}
                      {e.source === 'plan' ? ' · 주간보고 일정 예정' : ''}
                    </small>
                  </span>
                  <span className="hm-dp-l">
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
                </div>
              ))}
            </div>
          )}
          {day.others.length > 0 && (
            <div data-group="others">
              <div className="hm-cap">
                다른 달력 <i className="hm-num">{day.others.length}</i>
              </div>
              {day.others.map((e) => (
                <div className="hm-dp-r" key={e.key}>
                  <span className="hm-dp-t hm-num">{when(e)}</span>
                  <span className="hm-dp-n">
                    <b>{e.title}</b>
                    <small title={e.owner}>
                      {ownerLabel(e.owner) || '다른 달력'}
                      {e.location ? ` · ${e.location}` : ''}
                    </small>
                  </span>
                  {e.htmlLink && (
                    <span className="hm-dp-l">
                      <button type="button" className="hm-org" aria-label={`달력에서 열기 — ${e.title}`} onClick={() => onOpenEvent(e)}>
                        달력 ↗
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {tasks.length > 0 && (
            <div data-group="tasks">
              <div className="hm-cap">
                할 일 <i className="hm-num">{tasks.length}</i>
              </div>
              {tasks.map((t) => {
                const late = t.due && t.due < today ? diffDays(t.due, today) : 0;
                return (
                  <button type="button" className="hm-dp-r is-btn" key={t.id} aria-label={`할 일로 가기 — ${t.title}`} title="아래 할 일 목록에서 이 줄로 갑니다" onClick={() => onTask(t.id)}>
                    <span className={cx('hm-dp-t', late > 0 && 'is-late')}>{late > 0 ? `${late}일 지남` : '기한'}</span>
                    <span className="hm-dp-n">
                      <b>{t.title}</b>
                      {(t.client || t.who) && <small>{[t.client, t.who].filter(Boolean).join(' · ')}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {notion.length > 0 && (
            <div data-group="notion">
              <div className="hm-cap">
                <NotionMark /> Notion 작성 <i className="hm-num">{notion.length}</i>
              </div>
              {notion.map((n) => (
                <button
                  type="button"
                  className="hm-dp-r is-btn"
                  key={`${n.id}:${n.fresh ? 'new' : 'edit'}`}
                  aria-label={`Notion에서 열기 — ${n.title}`}
                  title="Notion에서 이 페이지를 엽니다"
                  onClick={() => onOpenUrl(n.url, 'Notion에서 이 페이지를')}
                >
                  <span className="hm-dp-t hm-num">{n.time}</span>
                  <span className="hm-dp-n">
                    <b>{n.title}</b>
                    <small>
                      {n.source?.name ?? 'DB 밖의 페이지'} · {n.fresh ? '새로 만듦' : '고침'}
                    </small>
                  </span>
                  <span className="hm-dp-l">↗</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
