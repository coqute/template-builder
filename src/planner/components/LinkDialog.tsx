/**
 * 작업일지의 사안에 일정·할 일 달기 (설계 §6.7 ①) — 작업일지 탭에서 커서가 있는 ■ 사안에 날짜를 단다.
 * - 할 일(기한)은 플래너 저장소에만 남는다. `일지에도 적기`를 켜면 그 사안의 ▶ 아래에 `- M/D … 예정` 한 줄을 넣는다.
 * - 달력 일정(시각)은 달력 쓰기 권한이 있을 때만 고를 수 있다.
 */
import { useState } from 'react';
import { BTN_GHOST, BTN_SOLID, Modal, SOLID_STYLE } from '../../components/Modal';
import { addDays, md, mdw } from '../dates';
import type { WorklogAnchor } from '../types';

export interface LinkRequest {
  as: 'task' | 'event';
  title: string;
  date: string;
  start: string;
  end: string;
  /** 일지에 넣을 줄 (`일지에도 적기`를 껐으면 null) */
  logLine: string | null;
}

interface Props {
  anchor: WorklogAnchor;
  today: string;
  /** 달력에 쓸 수 있는가 */
  canEvent: boolean;
  busy: boolean;
  onSubmit(req: LinkRequest): void;
  onClose(): void;
}

/** 일지에 넣을 줄 — 루틴이 쓰는 날짜 표기와 같다 (`12/2 패치 적용 예정`) */
export function scheduleLine(date: string, title: string): string {
  const t = title.trim().replace(/\s*예정$/, '');
  return `${md(date)} ${t} 예정`;
}

export function LinkDialog({ anchor, today, canEvent, busy, onSubmit, onClose }: Props) {
  const [as, setAs] = useState<'task' | 'event'>('task');
  const [date, setDate] = useState(addDays(today, 1));
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('11:00');
  const [title, setTitle] = useState(anchor.title);
  const [toLog, setToLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = scheduleLine(date || today, title);

  const submit = () => {
    if (!title.trim()) return setError('제목을 입력하세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('날짜를 고르세요.');
    if (as === 'event' && end <= start) return setError('끝 시각이 시작 시각보다 뒤여야 합니다.');
    onSubmit({ as, title: title.trim(), date, start, end, logLine: toLog ? line : null });
  };

  return (
    <Modal
      title="이 사안에 일정·할 일 달기"
      subtitle={`${anchor.title} · ${mdw(anchor.date)} 일지 ${anchor.line}행`}
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
            {busy ? '다는 중…' : '달기'}
          </button>
        </>
      }
    >
      <div className="hm-form">
        <div className="hm-field is-wide">
          무엇으로
          <span className="hm-seg" role="group" aria-label="무엇으로">
            <button type="button" aria-pressed={as === 'task'} onClick={() => setAs('task')}>
              할 일 — 기한
            </button>
            <button type="button" aria-pressed={as === 'event'} disabled={!canEvent} title={canEvent ? 'Google 달력에 일정을 만듭니다' : '달력 쓰기 권한이 있을 때만 됩니다 — 설정(F1)'} onClick={() => setAs('event')}>
              달력 일정 — 시각
            </button>
          </span>
        </div>
        <label className={as === 'event' ? 'is-wide' : undefined}>
          날짜
          <input className="hm-in hm-num" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {as === 'event' && (
          <>
            <label>
              시작
              <input className="hm-in hm-num" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              끝
              <input className="hm-in hm-num" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </>
        )}
        <label className={as === 'task' ? undefined : 'is-wide'}>
          제목
          <input className="hm-in" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        <div className="is-wide">
          <label className="hm-check" style={{ flexDirection: 'row' }}>
            <input type="checkbox" checked={toLog} onChange={(e) => setToLog(e.target.checked)} />
            <span>
              <b>일지에도 적기</b> — 이 사안의 ▶ 아래에 아래 한 줄을 넣습니다(주간보고 가져오기에 그대로 실립니다). 끄면 일지 파일은 바뀌지 않고 ■ 줄에 표지만
              붙습니다.
            </span>
          </label>
          {toLog && <pre className="hm-pre">- {line}</pre>}
        </div>
      </div>
    </Modal>
  );
}
