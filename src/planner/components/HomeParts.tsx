/** 홈 화면의 위쪽 — 요약 줄, 2주 띠, 빈 상태 상자, 바뀐 것 한 줄 (설계 §6.2) */
import type { ReactNode } from 'react';
import type { EventChange } from '../classify';
import { dowOf, mdw, relDay, toDate } from '../dates';
import type { StripDay, Summary } from '../model';
import type { NotionItem } from '../sources/notion';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Notion 표지 — 둥근 네모 안의 N을 직접 그린다(글자 색을 따라간다). 공식 로고 파일은 넣지 않는다 */
export function NotionMark({ size = 12 }: { size?: number }) {
  return (
    <svg className="hm-nm" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.4 11.4V4.6l5.2 6.8V4.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SummaryProps {
  today: string;
  summary: Summary;
  /** 달력을 읽을 수 있는가 */
  calendar: boolean;
  onJump(target: 'late' | 'today' | 'week' | 'agenda' | 'waiting'): void;
}

/** 3초 안에 읽는 줄 — 오늘·다음 일정·숫자 다섯 */
export function SummaryBar({ today, summary, calendar, onJump }: SummaryProps) {
  const d = toDate(today);
  const next = summary.next;
  const tile = (n: number, label: string, target: Parameters<SummaryProps['onJump']>[0], alert = false) => (
    <button type="button" className={cx('hm-tile', n === 0 ? 'is-zero' : alert && 'is-alert')} onClick={() => onJump(target)} title={`${label} ${n}건 — 눌러서 이동`}>
      <b className="hm-num">{n}</b>
      <span>{label}</span>
    </button>
  );
  return (
    <div className="hm-sum">
      <div className="hm-date">
        <b className="hm-num">
          {d.getMonth() + 1}월 {d.getDate()}일
        </b>
        <span>{dowOf(today)}요일</span>
      </div>
      <div className="hm-next" data-testid="home-next">
        {!calendar ? (
          '달력이 연결되지 않아 정해진 일정을 볼 수 없습니다'
        ) : next ? (
          <>
            {summary.todayEvents > 0 ? `오늘 일정 ${summary.todayEvents}건 · ` : '오늘 정해진 일정 없음 · '}다음 일정{' '}
            <b>
              {next.date <= today ? '오늘' : `${relDay(today, next.date)} ${dowOf(next.date)}요일`}
              {next.startTime ? ` ${next.startTime}` : ''}
            </b>{' '}
            {next.title}
          </>
        ) : (
          '오늘과 앞으로 2주 동안 정해진 일정이 없습니다'
        )}
      </div>
      <div className="hm-tiles" role="group" aria-label="요약">
        {tile(summary.late, '기한 지남', 'late', true)}
        {tile(summary.today, '오늘 할 일', 'today')}
        {tile(summary.week, '이번 주 할 일', 'week')}
        {tile(summary.weekEvents, '이번 주 일정', 'agenda')}
        {tile(summary.waiting, '기다리는 중', 'waiting')}
      </div>
    </div>
  );
}

/**
 * 달력 이름을 날 칸에 넣을 만큼 짧게 — 동료 달력의 이름은 대개 메일 주소라, 그대로 앞에 두면 일정 제목이 잘려 보이지 않는다.
 * 주소면 골뱅이 앞부분만 쓴다. 전체 이름은 말풍선과 그날 미리보기에서 보인다.
 */
export function ownerLabel(owner: string | undefined): string {
  const s = (owner ?? '').trim();
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

/** 날 칸에 보이는 Notion 작성 수 — 넘치면 "외 n건"으로 접는다 */
const NOTION_SHOWN = 2;
/** 날 칸에 보이는 남의 달력 일정 수 — 넘치면 "외 n건"으로 접는다(동료 달력을 여럿 켜면 2주에 수십 건이다) */
const OTHERS_SHOWN = 3;

interface StripProps {
  weeks: StripDay[][];
  focus: string | null;
  onFocus(date: string | null): void;
  /** Notion 회의록이 이어진 일정의 키 — 조각 끝에 작은 표지 */
  noted?: Set<string>;
  /** 날짜 → 그날 Notion에 쓴 것 — 날 칸에 표지와 제목으로 보인다 */
  notion?: Map<string, NotionItem[]>;
}

/** 이번 주·다음 주 — 날 칸을 누르면 그날의 할 일·일정만 또렷이 (자리는 움직이지 않는다) */
export function WeekStrip({ weeks, focus, onFocus, noted, notion }: StripProps) {
  // 오늘이 든 줄이 이번 주 — 그 앞은 지난 주, 뒤는 다음 주
  const thisWeek = Math.max(0, weeks.findIndex((w) => w.some((d) => d.today)));
  return (
    <section className="hm-strip" aria-label={thisWeek > 0 ? '지난 주부터 다음 주까지' : '이번 주와 다음 주'}>
      {weeks.map((week, wi) => (
        <div className="hm-wk" key={week[0].date}>
          <div className="hm-wk-l">{wi < thisWeek ? '지난 주' : wi === thisWeek ? '이번 주' : '다음 주'}</div>
          {week.map((day) => {
            const wrote = notion?.get(day.date) ?? [];
            return (
            <button
              type="button"
              key={day.date}
              className={cx('hm-day', day.today && 'is-today', day.weekend && 'is-we', day.off && !day.offPart && 'is-off', day.past && 'is-past', focus === day.date && 'is-sel')}
              data-date={day.date}
              aria-pressed={focus === day.date}
              aria-label={`${mdw(day.date)}${day.off ? ` ${day.off}` : ''} — 일정 ${day.events.length}건, 할 일 ${day.due}건${day.others.length ? `, 다른 달력 ${day.others.length}건` : ''}${wrote.length ? `, Notion 작성 ${wrote.length}건` : ''}`}
              onClick={() => onFocus(focus === day.date ? null : day.date)}
            >
              <span className="hm-day-h hm-num">
                <b>{toDate(day.date).getDate()}</b>
                <span>{dowOf(day.date)}</span>
                {day.place ? <em title="근무 위치">{day.place}</em> : day.today ? <em>오늘</em> : null}
              </span>
              {day.off && (
                <span className="hm-off" title={day.off}>
                  {day.off}
                </span>
              )}
              {day.events.map((e) => (
                <span className="hm-ev" key={e.key} title={`${e.startTime} ${e.title}${noted?.has(e.key) ? ' · Notion 회의록 있음' : ''}`.trim()}>
                  {e.startTime && <i className="hm-num">{e.startTime}</i>}
                  <b>{e.title}</b>
                  {noted?.has(e.key) && <NotionMark size={10} />}
                </span>
              ))}
              {day.others.slice(0, OTHERS_SHOWN).map((e) => (
                <span className="hm-ev is-other" key={e.key} title={`${e.owner ? `${e.owner} — ` : '다른 달력 — '}${e.startTime} ${e.title}`.replace(/\s+/g, ' ').trim()}>
                  {e.startTime && <i className="hm-num">{e.startTime}</i>}
                  <b>{e.title}</b>
                  {e.owner && <em>{ownerLabel(e.owner)}</em>}
                </span>
              ))}
              {day.others.length > OTHERS_SHOWN && (
                <span className="hm-ev is-other" title={day.others.slice(OTHERS_SHOWN).map((e) => `${e.owner ? `${e.owner} — ` : ''}${e.startTime} ${e.title}`.trim()).join(' · ')}>
                  <b>외 {day.others.length - OTHERS_SHOWN}건</b>
                </span>
              )}
              {/* 그날 Notion에 쓴 것 — 표지와 제목. 여는 것은 아래 "날짜별 Notion 작성"에서 */}
              {wrote.slice(0, NOTION_SHOWN).map((n) => (
                <span className="hm-ev is-notion" key={`${n.id}:${n.fresh ? 'new' : 'edit'}`} title={`Notion ${n.source?.name ?? '페이지'} — ${n.title} (${n.fresh ? '새로 만듦' : '고침'})`}>
                  <NotionMark size={10} />
                  <b>{n.title}</b>
                </span>
              ))}
              {wrote.length > NOTION_SHOWN && (
                <span className="hm-ev is-notion" title={wrote.slice(NOTION_SHOWN).map((n) => n.title).join(' · ')}>
                  <NotionMark size={10} />
                  <b>외 {wrote.length - NOTION_SHOWN}건</b>
                </span>
              )}
              {day.late > 0 && <span className="hm-due is-late">지남 {day.late}</span>}
              {day.due > 0 && <span className="hm-due">할 일 {day.due}</span>}
            </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}

export function EmptyBox({ title, children, action }: { title: string; children?: ReactNode; action?: { label: string; onClick(): void } }) {
  return (
    <div className="hm-empty">
      <p>{title}</p>
      {children && <span>{children}</span>}
      {action && (
        <button type="button" className="hm-mini is-solid" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** 마지막으로 확인한 뒤 달력에서 바뀐 일정 — Claude가 옮긴 것, 다른 기기에서 고친 것 */
export function ChangeBanner({ changes, onAck }: { changes: EventChange[]; onAck(): void }) {
  if (changes.length === 0) return null;
  return (
    <div className="hm-chg" role="status">
      <b>지난번 본 뒤 바뀐 일정 {changes.length}건</b>
      <span title={changes.map((c) => `${c.title} ${c.what}`).join('\n')}>{changes.map((c) => `${c.title} ${c.what}`).join(' · ')}</span>
      <button type="button" className="hm-mini" onClick={onAck}>
        확인
      </button>
    </div>
  );
}

export { cx };
