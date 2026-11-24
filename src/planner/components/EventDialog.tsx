/** 달력 일정 만들기·고치기 — Google 달력에 쓴다 (달력 쓰기 권한이 있을 때만 열린다, 설계 §12 4단계) */
import { useState } from 'react';
import { BTN_GHOST, BTN_SOLID, Modal, SOLID_STYLE } from '../../components/Modal';
import type { HomeEvent } from '../classify';
import { addDays, diffDays, isoOf, mdw, toDate } from '../dates';
import type { EventInput } from '../types';

interface Props {
  /** 고칠 일정 — 없으면 새 일정 */
  event: HomeEvent | null;
  /** 새 일정의 기본 날짜 */
  date: string;
  busy: boolean;
  onSubmit(input: EventInput): void;
  onClose(): void;
}

const isTime = (s: string) => /^\d{2}:\d{2}$/.test(s);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(toDate(s)) === s;

/**
 * 입력값 → 달력에 보낼 모양. 틀리면 안내 문구.
 * `span` = 시각 일정이 걸친 날 수(끝 날짜 − 시작 날짜) — 밤을 넘기거나 여러 날에 걸친 일정을 고칠 때 그 길이를 지킨다.
 */
export function buildEventInput(v: { title: string; allDay: boolean; date: string; endDate: string; start: string; end: string; location: string; span?: number }): EventInput | string {
  const summary = v.title.trim();
  if (!summary) return '제목을 입력하세요.';
  if (!isDate(v.date)) return '날짜를 고르세요.';
  if (v.allDay) {
    const end = v.endDate && isDate(v.endDate) ? v.endDate : v.date;
    if (end < v.date) return '끝 날짜가 시작 날짜보다 앞섭니다.';
    return { summary, allDay: true, start: v.date, end, location: v.location.trim() };
  }
  if (!isTime(v.start) || !isTime(v.end)) return '시작·끝 시각을 넣으세요.';
  const span = Math.max(0, v.span ?? 0);
  if (span === 0 && v.end <= v.start) return '끝 시각이 시작 시각보다 뒤여야 합니다.';
  return { summary, allDay: false, start: `${v.date}T${v.start}`, end: `${addDays(v.date, span)}T${v.end}`, location: v.location.trim() };
}

/**
 * 고친 일정에서 **바뀐 칸만** 고른다 — 제목만 고쳤는데 시각까지 다시 쓰지 않는다.
 * (제목이 없던 일정의 자리 글 `(제목 없음)`이 실제 제목으로 들어가거나, 손대지 않은 시각이 바뀌는 일을 막는다.)
 */
export function eventPatch(original: Pick<HomeEvent, 'title' | 'allDay' | 'date' | 'endDate' | 'startTime' | 'endTime' | 'location'>, input: EventInput): Partial<EventInput> {
  const patch: Partial<EventInput> = {};
  if (input.summary !== original.title) patch.summary = input.summary;
  if ((input.location ?? '') !== original.location) patch.location = input.location ?? '';
  const start = original.allDay ? original.date : `${original.date}T${original.startTime}`;
  const end = original.allDay ? original.endDate : `${original.endDate}T${original.endTime}`;
  if (input.allDay !== original.allDay || input.start !== start || input.end !== end) {
    patch.allDay = input.allDay;
    patch.start = input.start;
    patch.end = input.end;
  }
  return patch;
}

export function EventDialog({ event, date, busy, onSubmit, onClose }: Props) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [day, setDay] = useState(event?.date ?? date);
  const [endDate, setEndDate] = useState(event?.endDate ?? date);
  const [start, setStart] = useState(event?.startTime || '10:00');
  const [end, setEnd] = useState(event?.endTime || '11:00');
  const [location, setLocation] = useState(event?.location ?? '');
  const [error, setError] = useState<string | null>(null);
  // 시각 일정이 걸친 날 수 — 밤을 넘기는 일정(22:00 ~ 다음 날 01:00)이나 여러 날 일정의 길이를 지킨다
  const span = event && !event.allDay ? Math.max(0, diffDays(event.date, event.endDate)) : 0;

  /** 날짜를 옮기면 끝 날짜도 같은 만큼 옮긴다 — 여러 날 종일 일정의 길이가 그대로 간다 */
  const moveDay = (next: string) => {
    if (isDate(next) && isDate(day) && isDate(endDate)) setEndDate(addDays(endDate, diffDays(day, next)));
    setDay(next);
  };

  const submit = () => {
    const input = buildEventInput({ title, allDay, date: day, endDate, start, end, location, span });
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    onSubmit(input);
  };

  return (
    <Modal
      title={event ? '일정 고치기·옮기기' : '일정 추가'}
      subtitle={
        event?.recurring
          ? '반복 일정입니다 — 이번 회차만 바뀝니다. 전체를 고치려면 달력에서 여세요.'
          : 'Google 달력(내 달력)에 바로 씁니다 — 알림은 달력의 기본 설정을 따릅니다.'
      }
      width={460}
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="text-[12px]" style={{ color: 'var(--stamp-red)' }} role="alert">
              {error}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            취소
          </button>
          <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={busy} onClick={submit}>
            {busy ? '쓰는 중…' : event ? '고치기' : '만들기'}
          </button>
        </>
      }
    >
      <div className="hm-form">
        <label className="is-wide">
          제목
          <input className="hm-in" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        <label>
          날짜
          <input className="hm-in hm-num" type="date" value={day} onChange={(e) => moveDay(e.target.value)} />
        </label>
        <label>
          {allDay ? '끝 날짜 (하루면 그대로)' : '종일 여부'}
          {allDay ? (
            <input className="hm-in hm-num" type="date" value={endDate} min={day} onChange={(e) => setEndDate(e.target.value)} />
          ) : (
            <span className="hm-in" style={{ display: 'flex', alignItems: 'center', color: 'var(--fg-muted)' }}>
              시각이 있는 일정
            </span>
          )}
        </label>
        {!allDay && (
          <>
            <label>
              시작
              <input className="hm-in hm-num" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              {span > 0 ? `끝 (${mdw(addDays(day, span))})` : '끝'}
              <input className="hm-in hm-num" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </>
        )}
        <label className="hm-check is-wide" style={{ flexDirection: 'row' }}>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>종일 일정 (휴가·하루 종일 걸리는 작업)</span>
        </label>
        <label className="is-wide">
          장소 (선택)
          <input className="hm-in" value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
      </div>
    </Modal>
  );
}
