/**
 * 홈의 확정 일정 — 오늘부터 2주 끝까지 날짜순. 원본은 Google 달력이고 앱은 읽어서 보여 준다 (설계 §5.4·§6.4).
 * 일정을 누르면 그 줄 아래로 단추가 펼쳐진다. 고치기·지우기는 달력에 쓸 수 있을 때만 나온다.
 */
import { useState } from 'react';
import { KIND_LABEL, type EventChange, type HomeEvent } from '../classify';
import { clock, mdw, relDay } from '../dates';
import type { CalendarView } from '../usePlanner';
import { cx, EmptyBox } from './HomeParts';

export interface EventActions {
  open(e: HomeEvent): void;
  hide(e: HomeEvent, byTitle: boolean): void;
  /** 그 일정에 이어진 일지 사안을 연다 */
  openCase(e: HomeEvent): void;
  /** 지난 일정을 그날 일지의 회의 블록으로 */
  toWorklog(e: HomeEvent): void;
  /** 달력에 쓸 수 있을 때만 */
  edit?(e: HomeEvent | null): void;
  remove?(e: HomeEvent): void;
}

interface Props {
  today: string;
  days: Array<{ date: string; events: HomeEvent[] }>;
  past: HomeEvent[];
  cal: CalendarView;
  changes: EventChange[];
  /** 일지 사안과 이어진 일정의 키 */
  linked: Set<string>;
  focus: string | null;
  flash: string | null;
  /** 작업일지 폴더가 있어 일지에 쓸 수 있는가 */
  canLog: boolean;
  actions: EventActions;
  onRetry(): void;
  onHelp(): void;
}

export function Agenda({ today, days, past, cal, changes, linked, focus, flash, canLog, actions, onRetry, onHelp }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const changed = new Map(changes.map((c) => [c.key, c.what]));

  if (cal.status && !cal.status.canRead) {
    return (
      <EmptyBox title="Google 달력이 연결되지 않았습니다" action={{ label: '연결 방법 보기 (F1 설정)', onClick: onHelp }}>
        {cal.status.reason === 'credentials-missing'
          ? '자격증명 파일을 찾지 못했습니다. 연결하면 회의·작업 일정이 여기와 위 띠에 나옵니다. 연결 전에도 할 일과 기한은 그대로 쓸 수 있습니다.'
          : '토큰에 달력 읽기 권한이 없습니다. 권한을 더해 다시 동의하면 회의·작업 일정이 여기와 위 띠에 나옵니다. 그 전에도 할 일과 기한은 그대로 쓸 수 있습니다.'}
      </EmptyBox>
    );
  }

  const row = (e: HomeEvent, date: string, pastRow = false) => {
    const what = changed.get(e.key);
    const off = e.kind === 'leave' || e.kind === 'holiday';
    const dim = !!focus && !(e.date <= focus && focus <= e.endDate);
    return (
      <div key={`${e.key}@${date}`}>
        <button
          type="button"
          className={cx('hm-ag', off && 'is-off', dim && 'is-dim', flash === e.key && 'is-flash')}
          aria-expanded={open === e.key}
          aria-label={`${mdw(date)} ${e.allDay ? '종일' : e.startTime} ${e.title}${what ? ' — 바뀜' : ''}`}
          data-event={e.key}
          onClick={() => setOpen((cur) => (cur === e.key ? null : e.key))}
        >
          <span className="hm-ag-t hm-num">
            {e.allDay ? '종일' : e.startTime}
            {!e.allDay && e.endTime && <small>~ {e.endTime}</small>}
            {e.allDay && e.endDate > e.date && <small>~ {mdw(e.endDate)}</small>}
          </span>
          <span>
            <span className="hm-ag-n">
              {e.title}
              {what && (
                <span className="hm-tag" title={`지난번 본 뒤 바뀜: ${what}`}>
                  바뀜
                </span>
              )}
            </span>
            {!off && (
              <span className="hm-ag-w">
                {e.client && <span className="hm-chip">{e.client}</span>}
                <span>{KIND_LABEL[e.kind]}</span>
                {e.location && <span>· {e.location}</span>}
                {e.source === 'plan' && <span>· 주간보고 일정 예정</span>}
                {linked.has(e.key) && <span>· 일지와 이어짐</span>}
              </span>
            )}
          </span>
        </button>
        {open === e.key && (
          <div className="hm-ag-acts">
            {e.htmlLink && (
              <button type="button" className="hm-mini" onClick={() => actions.open(e)}>
                달력에서 열기 ↗
              </button>
            )}
            {linked.has(e.key) && (
              <button type="button" className="hm-mini" onClick={() => actions.openCase(e)}>
                이어진 일지 사안 ↗
              </button>
            )}
            {pastRow && canLog && !off && (
              <button type="button" className="hm-mini" onClick={() => actions.toWorklog(e)} title="그날 작업일지 끝에 ■ 회의 블록 초안을 덧붙입니다 (이미 있으면 쓰지 않음)">
                일지에 회의 블록으로
              </button>
            )}
            {actions.edit && e.canWrite && e.ref && !pastRow && (
              <button type="button" className="hm-mini" onClick={() => actions.edit?.(e)}>
                고치기·옮기기
              </button>
            )}
            {actions.remove && e.canWrite && e.ref && (
              <button type="button" className="hm-mini is-danger" onClick={() => actions.remove?.(e)}>
                지우기
              </button>
            )}
            {e.ref && (
              <>
                <button type="button" className="hm-mini" onClick={() => actions.hide(e, false)} title="홈에서만 가립니다 — 달력은 그대로">
                  이 일정 숨기기
                </button>
                <button type="button" className="hm-mini" onClick={() => actions.hide(e, true)} title="같은 제목의 일정을 늘 가립니다 (개인 일정 등)">
                  이 제목은 늘 숨기기
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="home-agenda">
      {cal.error && (
        <p className="hm-note" role="status">
          달력을 읽지 못했습니다 — {cal.readAt ? `${clock(cal.readAt)}에 읽은 내용입니다.` : '보여 줄 내용이 없습니다.'}{' '}
          <button type="button" className="hm-mini" onClick={onRetry}>
            다시 읽기
          </button>
        </p>
      )}
      {days.length === 0 && !cal.error && (
        <EmptyBox title="이번 주와 다음 주에 잡힌 일정이 없습니다">{cal.status ? 'Google 달력에 일정을 넣으면 몇 분 안에 여기에 나옵니다.' : '달력을 읽는 중입니다.'}</EmptyBox>
      )}
      {days.map((d) => (
        <section className="hm-agd" key={d.date}>
          <div className="hm-agd-h hm-num">
            {mdw(d.date)} <span>{relDay(today, d.date)}</span>
          </div>
          {d.events.map((e) => row(e, d.date))}
        </section>
      ))}
      {actions.edit && (
        <button type="button" className="hm-addev" onClick={() => actions.edit?.(null)}>
          ＋ 일정 추가 <span style={{ color: 'var(--fg-muted)' }}>· Google 달력에 만들기</span>
        </button>
      )}
      {past.length > 0 && (
        <section className="hm-agd">
          <div className="hm-cap">
            지난 일정 <i className="hm-num">{past.length} · 최근 7일</i>
            <button type="button" className="hm-mini" style={{ marginLeft: 'auto' }} aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
              {showPast ? '접기' : '보기'}
            </button>
          </div>
          {showPast && past.map((e) => row(e, e.date, true))}
        </section>
      )}
    </div>
  );
}
