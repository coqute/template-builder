/**
 * 홈의 할 일 목록 — 기한 지남 → 오늘 → 이번 주 → 다음 주 이후 → 기한 없음 → 기다리는 중 → 일지에서 찾은 후보 (설계 §4.4·§6.4).
 * 줄을 누르면 그 줄 아래로 상자가 펼쳐져 칸을 고친다. 입력칸은 모두 테두리 있는 상자다.
 */
import { useEffect, useRef, useState } from 'react';
import { mdw, relDay } from '../dates';
import { BUCKETS, WAIT_NUDGE_DAYS, waitingDays, type Bucket, type TaskGroups } from '../model';
import { candidateAge, type Candidate } from '../sources/worklog';
import type { Task, TaskOrigin, TaskPatch } from '../types';
import { cx } from './HomeParts';

export interface TaskActions {
  toggleDone(task: Task): void;
  update(id: string, patch: TaskPatch): void;
  remove(task: Task): void;
  openOrigin(origin: TaskOrigin): void;
  promote(c: Candidate): void;
  ignore(c: Candidate): void;
  /** 기한을 달력에 올린다 (달력에 쓸 수 있을 때만 단추가 나온다) */
  toCalendar?(task: Task): void;
}

interface Props {
  today: string;
  groups: TaskGroups;
  candidates: Candidate[];
  olderCandidates: number;
  lookbackDays: number;
  /** 일지에 닫힘 기록이 생긴 할 일 → 닫힌 날 */
  closed: Map<string, string>;
  /** 띠에서 고른 날 — 그날이 기한인 것만 또렷이 */
  focus: string | null;
  /** 잠깐 테두리를 둘러 보여 줄 할 일 */
  flash: string | null;
  /** Claude가 고친 뒤 아직 확인하지 않은 할 일 */
  changed?: Set<string>;
  showDone: boolean;
  actions: TaskActions;
}

function originLabel(origin: TaskOrigin): string {
  if (origin.kind === 'worklog') {
    const [, m, d] = origin.anchor.date.split('-').map(Number);
    return `일지 ${m}/${d}`;
  }
  return origin.kind === 'weekly' ? '주간보고' : '직접 입력';
}

function OriginTag({ origin, onOpen }: { origin: TaskOrigin; onOpen(o: TaskOrigin): void }) {
  if (origin.kind === 'manual') return <span className="hm-org is-self">직접 입력</span>;
  const title = origin.kind === 'worklog' ? `작업일지 탭에서 ${origin.anchor.name}의 그 사안을 엽니다` : '주간보고 탭으로 갑니다';
  return (
    <button type="button" className="hm-org" title={title} onClick={() => onOpen(origin)}>
      {originLabel(origin)} ↗
    </button>
  );
}

/** 펼친 상자 — 칸을 벗어나거나 Enter를 누르면 바뀐 칸만 저장한다 */
function TaskEditor({ task, actions, onClose }: { task: Task; actions: TaskActions; onClose(): void }) {
  const [title, setTitle] = useState(task.title);
  const [client, setClient] = useState(task.client);
  const [who, setWho] = useState(task.who);
  const [waitingOn, setWaitingOn] = useState(task.waitingOn);
  const [note, setNote] = useState(task.note);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const save = (patch: TaskPatch) => actions.update(task.id, patch);
  const commit = (key: 'title' | 'client' | 'who' | 'waitingOn' | 'note', value: string) => {
    const next = value.trim();
    if (next === task[key]) return;
    if (key === 'title' && !next) {
      setTitle(task.title);
      return;
    }
    save({ [key]: next });
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') onClose();
  };
  return (
    <div className="hm-edit" role="group" aria-label={`${task.title} 고치기`}>
      <label className="is-half">
        제목
        <input ref={first} className="hm-in" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => commit('title', title)} onKeyDown={onEnter} />
      </label>
      <label>
        고객사·구분
        <input className="hm-in" value={client} onChange={(e) => setClient(e.target.value)} onBlur={() => commit('client', client)} onKeyDown={onEnter} />
      </label>
      <label>
        요청자
        <input className="hm-in" value={who} onChange={(e) => setWho(e.target.value)} onBlur={() => commit('who', who)} onKeyDown={onEnter} />
      </label>
      <label>
        기한
        <input
          className="hm-in hm-num"
          type="date"
          value={task.due ?? ''}
          onChange={(e) => save({ due: e.target.value || null })}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      </label>
      {/* 단추 묶음은 label로 감싸지 않는다 — label은 첫 단추의 이름이 되고, 글자를 눌러도 그 단추가 눌린다 */}
      <div className="hm-field">
        상태
        <span className="hm-seg" role="group" aria-label="상태">
          <button type="button" aria-pressed={task.state === 'todo'} onClick={() => task.state !== 'todo' && save({ state: 'todo' })}>
            내 차례
          </button>
          <button type="button" aria-pressed={task.state === 'waiting'} onClick={() => task.state !== 'waiting' && save({ state: 'waiting' })}>
            기다리는 중
          </button>
        </span>
      </div>
      <label className="is-half">
        기다리는 대상
        <input
          className="hm-in"
          value={waitingOn}
          disabled={task.state !== 'waiting'}
          placeholder={task.state === 'waiting' ? '누구의 회신을 기다리는지 (선택)' : '기다리는 중일 때만'}
          onChange={(e) => setWaitingOn(e.target.value)}
          onBlur={() => commit('waitingOn', waitingOn)}
          onKeyDown={onEnter}
        />
      </label>
      <label className="is-wide">
        메모
        <textarea className="hm-in" value={note} rows={2} onChange={(e) => setNote(e.target.value)} onBlur={() => commit('note', note)} />
      </label>
      <div className="hm-acts is-wide">
        {task.due && (
          <button type="button" className="hm-mini" onClick={() => save({ due: null })}>
            기한 없애기
          </button>
        )}
        {actions.toCalendar && task.due && !task.event && (
          <button type="button" className="hm-mini" onClick={() => actions.toCalendar?.(task)} title="기한 날짜에 종일 일정으로 Google 달력에 만듭니다">
            달력에 올리기
          </button>
        )}
        {task.event && <span className="hm-chip">달력에 올림</span>}
        <span className="hm-sp" />
        <button type="button" className="hm-mini is-danger" onClick={() => actions.remove(task)}>
          지우기
        </button>
        <button type="button" className="hm-mini" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}

export function TaskList({ today, groups, candidates, olderCandidates, lookbackDays, closed, focus, flash, changed, showDone, actions }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));

  const taskRow = (t: Task, bucket: Bucket | 'waiting' | 'done') => {
    const dim = !!focus && t.due !== focus;
    const closedOn = closed.get(t.id);
    const days = bucket === 'waiting' ? waitingDays(t, today) : 0;
    return (
      <div key={t.id}>
        <div className={cx('hm-row', bucket === 'done' && 'is-done', dim && 'is-dim', flash === t.id && 'is-flash')} data-task={t.id}>
          {bucket === 'waiting' ? (
            <span className="hm-mk" title="기다리는 중" aria-hidden="true">
              …
            </span>
          ) : (
            <button type="button" className="hm-chk" aria-pressed={!!t.doneAt} aria-label={`${t.title} — ${t.doneAt ? '끝냄 취소' : '끝냄으로'}`} onClick={() => actions.toggleDone(t)} />
          )}
          <button type="button" className="hm-ttl" aria-expanded={open === t.id} title={`${t.title} — 눌러서 고치기`} onClick={() => toggle(t.id)}>
            {t.title}
          </button>
          {changed?.has(t.id) && (
            <span className="hm-tag" title="Claude가 고쳤습니다 — ⋯ 바뀐 기록에서 되돌릴 수 있습니다">
              바뀜
            </span>
          )}
          {t.client && <span className="hm-chip">{t.client}</span>}
          {closedOn && (
            <button type="button" className="hm-mini" title={`작업일지 ${closedOn}에 이 사안의 완료 기록이 있습니다`} onClick={() => actions.toggleDone(t)}>
              일지에 완료 기록 — 끝냄으로
            </button>
          )}
          <span className="hm-sp" />
          <OriginTag origin={t.origin} onOpen={actions.openOrigin} />
          {bucket === 'waiting' ? (
            <div className={cx('hm-when is-wait', days > WAIT_NUDGE_DAYS && 'is-nudge')}>
              {t.waitingOn ? `${t.waitingOn} 회신` : '회신 대기'}
              <small className="hm-num">{days}일째</small>
            </div>
          ) : t.due ? (
            <div className={cx('hm-when hm-num', bucket === 'late' && 'is-late')}>
              {mdw(t.due)}
              <small>{relDay(today, t.due)}</small>
            </div>
          ) : (
            <div className="hm-when">
              <small>—</small>
            </div>
          )}
        </div>
        {open === t.id && <TaskEditor task={t} actions={actions} onClose={() => setOpen(null)} />}
      </div>
    );
  };

  return (
    <div data-testid="home-tasks">
      {BUCKETS.map(({ id, label }) =>
        groups.buckets[id].length === 0 ? null : (
          <section key={id} data-bucket={id}>
            <div className={cx('hm-cap', id === 'late' && 'is-late')}>
              {label} <i className="hm-num">{groups.buckets[id].length}</i>
            </div>
            {groups.buckets[id].map((t) => taskRow(t, id))}
          </section>
        ),
      )}
      {groups.waiting.length > 0 && (
        <section data-bucket="waiting">
          <div className="hm-cap">
            기다리는 중 <i className="hm-num">{groups.waiting.length}</i>
          </div>
          {groups.waiting.map((t) => taskRow(t, 'waiting'))}
        </section>
      )}
      {(candidates.length > 0 || olderCandidates > 0) && (
        <section data-bucket="candidates">
          <div className="hm-cap">
            작업일지에서 찾은 후보{' '}
            <i className="hm-num">
              {candidates.length} · 최근 {lookbackDays}일
            </i>
          </div>
          {candidates.map((c) => (
            <div className={cx('hm-row', focus && 'is-dim')} key={c.key} data-candidate={c.key}>
              <span className="hm-mk is-q" title={c.cls === 'wait' ? '기다리는 중으로 보이는 사안' : '내 차례로 보이는 사안'} aria-hidden="true">
                ?
              </span>
              <span className="hm-ttl" style={{ cursor: 'default' }} title={c.title}>
                {c.title}
              </span>
              <span className="hm-sub" title={c.phrase}>
                — {c.phrase}
              </span>
              <OriginTag
                origin={c.anchor ? { kind: 'worklog', anchor: c.anchor } : { kind: 'manual' }}
                onOpen={actions.openOrigin}
              />
              <span className="hm-chip hm-num" title="기록된 뒤 지난 날">
                {candidateAge(c, today)}일 전
              </span>
              <button type="button" className="hm-mini" onClick={() => actions.promote(c)}>
                할 일로
              </button>
              <button type="button" className="hm-mini" onClick={() => actions.ignore(c)}>
                무시
              </button>
            </div>
          ))}
          {olderCandidates > 0 && (
            <p className="hm-note">
              더 오래된 열린 사안이 {olderCandidates}건 있습니다 — 끝났는데 기록이 없는 것일 수 있어 세지 않습니다. 찾는 기간은 설정(F1)에서 바꿉니다.
            </p>
          )}
        </section>
      )}
      {showDone && (
        <section data-bucket="done">
          <div className="hm-cap">
            끝낸 일 <i className="hm-num">{groups.done.length}</i>
          </div>
          {groups.done.length === 0 ? <p className="hm-note">아직 끝낸 일이 없습니다.</p> : groups.done.slice(0, 50).map((t) => taskRow(t, 'done'))}
        </section>
      )}
    </div>
  );
}
