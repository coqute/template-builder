import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { UNDO_MS } from '../../lib/undo';
import {
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  KNOWN_CHANNELS,
  LOCATION_SEPARATOR,
  WORK_CATEGORIES,
  WORK_PLACES,
  buildingOf,
  isBlankItem,
  parseTolerant,
  serialize,
  type DialogTurn,
  type WeekReport,
} from '@core/index';
import {
  addContentBlock,
  addDay,
  addItem,
  addLocationBlock,
  addTurn,
  continueItem,
  convertListLineToTurn,
  convertTurnToList,
  fillItemClientsFromRow,
  fillItemSitesFromRow,
  fillMissingDays,
  fillRowCustomerFromItem,
  isOnLeave,
  missingDates,
  moveContentBlock,
  moveItem,
  moveTurn,
  removeContentBlock,
  removeDay,
  removeItem,
  removeLocationBlock,
  removeTurn,
  replaceTurn,
  setContentIndent,
  setWeekByPrevMonday,
  toggleHalfday,
  toggleHoliday,
  toggleLeave,
  updateBlockFields,
  updateContentBlock,
  updateHalfdayLabel,
  updateHolidayReason,
  updateItemFields,
  updateTurn,
  type ItemBody,
} from '@core/edit';
import { Chip, Field, ItemEditor, itemStats, useDismiss } from './ItemEditor';

interface Props {
  /** 단일 소스 md — 편집 시 즉시 serialize해 반영 (저장/미리보기/상태바 경로 무변경) */
  md: string;
  onMd: (next: string) => void;
}

/** 워크스페이스가 비주얼 편집기 안의 위치를 열 때 쓰는 핸들 (진단 이동·모드 전환) */
export interface VisualEditorHandle {
  /** 항목(`di-bi-ii`)을 펼치고 스크롤·포커스. selector가 있으면 항목 안 그 요소에 포커스 */
  reveal(key: string, selector?: string): void;
  /** 일자를 펼치고 스크롤 */
  revealDay(date: string): void;
  /** 지금 포커스가 있는 항목 키 (없으면 null) */
  focusedItemKey(): string | null;
}

const WEEKDAY_LABEL: Record<string, string> = {
  월: '월요일',
  화: '화요일',
  수: '수요일',
  목: '목요일',
  금: '금요일',
  토: '토요일',
  일: '일요일',
};

function formatDayTitle(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

function shortDate(date: string, weekday?: string): string {
  return `${date.slice(5).replace('-', '/')}${weekday ? `(${weekday})` : ''}`;
}

/** 입력 멈춤이 이 시간보다 길면 되돌리기 단위를 새로 끊는다 (한 글자씩 되돌리지 않게) */
const UNDO_COALESCE_MS = 1000;
const UNDO_LIMIT = 200;

interface FocusRequest {
  id: string;
  selector?: string;
}

/**
 * 주간보고서 비주얼 에디터 — "원고지 조판".
 * 에디터 전체가 하나의 연속 문서: 마스트헤드(주간 정보) → 러닝 헤드(날짜) →
 * 고스트 넘버럴(항목) → 입력 필드·대화 이력.
 * AST를 로컬 상태로 소유하고 매 편집을 serialize→onMd로 동기화한다. 되돌리기 기록도 여기서 관리한다.
 */
export const VisualWeeklyEditor = forwardRef<VisualEditorHandle, Props>(function VisualWeeklyEditor({ md, onMd }, ref) {
  const [report, setReport] = useState<WeekReport>(() => parseTolerant(md).report);
  const reportRef = useRef(report);
  reportRef.current = report;
  const lastSyncedMd = useRef<string>(md);
  /** 바깥에서 문서가 통째로 바뀐 횟수 — 삭제 [되돌리기]가 다른 문서에 적용되지 않게 비교한다 */
  const docEpoch = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [newDate, setNewDate] = useState('');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<string>>(() => new Set());
  // 요일 띠 — 지금 화면 위쪽에 걸린 일자
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const scrollRaf = useRef(0);
  // 띠를 눌러 그 날로 미끄러져 가는 동안은 누른 날을 붙잡아 둔다 — 지나치는 날로 표시가 흔들리지 않고,
  // 끝 무렵 날(위까지 못 올라오는 토·일)도 누른 날이 표시된다. 스크롤이 멈추면 놓는다.
  const pinnedDay = useRef<string | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const releasePinLater = (ms: number) => {
    clearTimeout(pinTimer.current);
    pinTimer.current = setTimeout(() => {
      pinnedDay.current = null;
    }, ms);
  };
  const trackActiveDay = () => {
    if (pinnedDay.current) {
      releasePinLater(150);
      return;
    }
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const top = root.getBoundingClientRect().top + 48;
      let current: string | null = null;
      root.querySelectorAll<HTMLElement>('section[id^="vday-"]').forEach((el) => {
        if (el.getBoundingClientRect().top <= top) current = el.id.slice('vday-'.length);
      });
      setActiveDay((prev) => (prev === current ? prev : current));
    });
  };
  const goToDay = (date: string) => {
    pinnedDay.current = date;
    setActiveDay(date);
    // 이미 그 자리라 스크롤이 일어나지 않아도 붙잡은 채로 남지 않게
    releasePinLater(600);
    document.getElementById(`vday-${date}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  useEffect(() => () => clearTimeout(pinTimer.current), []);

  // 좁은 폭에서 띠가 가로로 밀려 있으면 지금 일자가 띠 안에 보이게 — 띠만 가로로 민다.
  // scrollIntoView는 쓰지 않는다: 편집 영역의 부드러운 스크롤까지 멈춰, 띠를 누르면 한 칸씩만 이동했다(2026-10-22 실측)
  useEffect(() => {
    if (!activeDay) return;
    const strip = rootRef.current?.querySelector<HTMLElement>('.vx-strip-days');
    const btn = strip?.querySelector<HTMLElement>('.vx-strip-day[aria-current="true"]');
    if (!strip || !btn) return;
    const s = strip.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    if (b.left < s.left) strip.scrollLeft -= s.left - b.left;
    else if (b.right > s.right) strip.scrollLeft += b.right - s.right;
  }, [activeDay]);

  // 되돌리기 기록 — 구조 편집(추가·삭제·이동)은 한 단계씩, 타이핑은 멈춤 단위로 묶는다
  const history = useRef({
    past: [] as WeekReport[],
    future: [] as WeekReport[],
    lastAt: 0,
    lastStructural: true,
  });
  const [, setHistoryTick] = useState(0);
  useEffect(() => {
    if (md !== lastSyncedMd.current) {
      // 외부에서 md가 바뀜(열기/샘플/새 주간보고 등) — AST·되돌리기·접힘 재초기화
      docEpoch.current++;
      const next = parseTolerant(md).report;
      setReport(next);
      lastSyncedMd.current = md;
      history.current = {
        past: [],
        future: [],
        lastAt: 0,
        lastStructural: true,
      };
      setCollapsedItems(new Set());
    }
  }, [md]);

  // 추가·이어쓰기·바로가기 뒤 — 대상으로 스크롤하고 입력칸에 포커스
  useEffect(() => {
    if (!focusRequest) return;
    const el = document.getElementById(focusRequest.id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const target = el.querySelector<HTMLElement>(focusRequest.selector ?? 'input[type="text"], textarea');
    target?.focus({ preventScroll: true });
    setFocusRequest(null);
  }, [focusRequest, report, collapsedDays, collapsedItems]);

  const sync = (next: WeekReport) => {
    setReport(next);
    reportRef.current = next;
    const s = serialize(next);
    lastSyncedMd.current = s;
    onMd(s);
  };

  const commit = (next: WeekReport, structural: boolean) => {
    const cur = reportRef.current;
    if (next === cur) return;
    const h = history.current;
    const now = Date.now();
    if (structural || h.lastStructural || now - h.lastAt > UNDO_COALESCE_MS) {
      h.past.push(cur);
      if (h.past.length > UNDO_LIMIT) h.past.shift();
    }
    h.future = [];
    h.lastAt = now;
    h.lastStructural = structural;
    sync(next);
    setHistoryTick((t) => t + 1);
  };
  /** 타이핑 — 멈춤 단위로 되돌리기 */
  const apply = (next: WeekReport) => commit(next, false);
  /** 구조 편집 — 한 번에 한 단계 되돌리기 */
  const act = (next: WeekReport) => commit(next, true);

  const undo = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(reportRef.current);
    h.lastStructural = true;
    sync(prev);
    setHistoryTick((t) => t + 1);
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(reportRef.current);
    h.lastStructural = true;
    sync(next);
    setHistoryTick((t) => t + 1);
  };

  /** 삭제 — 확인 창 대신 토스트의 [되돌리기] (한 번에 여러 개를 지울 때 방해되지 않게) */
  const removeWithUndo = (next: WeekReport, what: string) => {
    const before = reportRef.current;
    const epoch = docEpoch.current;
    act(next);
    toast.success(`${what} 삭제했습니다.`, {
      duration: UNDO_MS,
      action: {
        label: '되돌리기',
        onClick: () => {
          // 그 사이 다른 문서를 열었으면 지운 문서의 내용을 지금 문서에 통째로 덮어쓰게 된다
          if (docEpoch.current !== epoch) {
            toast.info('그 사이 다른 문서를 열어 되돌리지 않았습니다.');
            return;
          }
          act(before);
        },
      },
    });
  };

  useImperativeHandle(ref, () => ({
    reveal(key, selector) {
      const [di, bi, ii] = key.split('-').map(Number);
      const day = reportRef.current.days[di];
      if (!day) return;
      setCollapsedDays((s) => {
        if (!s.has(day.date)) return s;
        const n = new Set(s);
        n.delete(day.date);
        return n;
      });
      setCollapsedItems((s) => {
        if (!s.has(key)) return s;
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      if (Number.isNaN(bi) || Number.isNaN(ii)) return;
      setFocusRequest({ id: `vitem-${key}`, selector });
    },
    revealDay(date) {
      setCollapsedDays((s) => {
        if (!s.has(date)) return s;
        const n = new Set(s);
        n.delete(date);
        return n;
      });
      setFocusRequest({ id: `vday-${date}` });
    },
    focusedItemKey() {
      const el = document.activeElement?.closest('[id^="vitem-"]');
      return el ? el.id.slice('vitem-'.length) : null;
    },
  }));

  // 입력 추천 — 규격 어휘 + 문서에 이미 쓴 값 (빈 골격은 제외)
  const suggestions = useMemo(() => {
    const places = new Set<string>(WORK_PLACES);
    const customers = new Set<string>(WORK_CATEGORIES);
    const contacts = new Set<string>();
    for (const d of report.days)
      for (const b of d.blocks) {
        b.locations.forEach((l) => l.trim() && places.add(l));
        if (b.customer.trim()) customers.add(b.customer);
        b.items.forEach((it) => {
          if (it.client.trim()) customers.add(it.client);
          if (it.contact?.trim()) contacts.add(it.contact);
        });
      }
    return {
      places: [...places],
      customers: [...customers],
      contacts: [...contacts],
    };
  }, [report]);

  const missing = missingDates(report);
  const h = history.current;

  const toggleDay = (date: string) =>
    setCollapsedDays((s) => {
      const n = new Set(s);
      if (n.has(date)) n.delete(date);
      else n.add(date);
      return n;
    });
  const toggleItem = (key: string) =>
    setCollapsedItems((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const anyCollapsed = collapsedDays.size > 0 || collapsedItems.size > 0;
  const collapseAll = () => setCollapsedDays(new Set(report.days.filter((d) => !d.holiday).map((d) => d.date)));
  const expandAll = () => {
    setCollapsedDays(new Set());
    setCollapsedItems(new Set());
  };

  // 요일 띠 — 일자별 쓴 항목 수·미결 수
  const dayStats = report.days.map((d) => {
    const written = d.blocks.flatMap((b) => b.items).filter((it) => !isBlankItem(it));
    const pending = written.reduce((n, it) => n + itemStats(it).pending, 0);
    return {
      date: d.date,
      weekday: d.weekday,
      off: !!d.holiday,
      written: written.length,
      pending,
    };
  });

  return (
    <div
      ref={rootRef}
      className="vx scrollbar-thin h-full overflow-y-auto bg-bg px-5 pb-6"
      onScroll={trackActiveDay}
      onKeyDownCapture={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const k = e.key.toLowerCase();
        // 입력칸의 기본 되돌리기 대신 문서 단위 되돌리기 — 추가·삭제·이동까지 되돌린다
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault();
          redo();
        }
      }}
    >
      {/* 요일 띠 — 고정. 어느 날에 무엇이 얼마나 있는지, 누르면 그 날로 */}
      <div className="vx-strip">
        <nav className="vx-strip-days" aria-label="일자로 이동">
          {dayStats.map((d) => (
            <button
              key={d.date}
              type="button"
              aria-current={activeDay === d.date ? 'true' : undefined}
              aria-label={
                d.off
                  ? `${d.weekday}요일 ${Number(d.date.slice(8))}일 휴일`
                  : `${d.weekday}요일 ${Number(d.date.slice(8))}일 항목 ${d.written}${d.pending ? ` 미결 ${d.pending}` : ''}`
              }
              onClick={() => {
                setCollapsedDays((cur) => {
                  if (!cur.has(d.date)) return cur;
                  const n = new Set(cur);
                  n.delete(d.date);
                  return n;
                });
                goToDay(d.date);
              }}
              title={
                d.off ? `${d.date} 휴일` : `${d.date} — 항목 ${d.written}${d.pending ? `, 미결 ${d.pending}` : ''}`
              }
              className={[
                'vx-strip-day',
                d.off ? 'vx-strip-day--off' : '',
                !d.off && d.written === 0 ? 'vx-strip-day--empty' : '',
              ].join(' ')}
            >
              <span>
                {d.weekday} {Number(d.date.slice(8))}
              </span>
              {d.off ? null : <span className="vx-strip-n">{d.written || '–'}</span>}
              {/* 미결 수 — 대화 턴의 미결 표지와 같은 채운 모양 */}
              {d.pending > 0 && <span className="vx-strip-pending">{d.pending}</span>}
            </button>
          ))}
        </nav>
        <span className="vx-strip-tools">
          <DocBtn title="되돌리기 (Ctrl+Z)" disabled={h.past.length === 0} onClick={undo}>
            <Undo2 size={13} />
          </DocBtn>
          <DocBtn title="다시 실행 (Ctrl+Shift+Z)" disabled={h.future.length === 0} onClick={redo}>
            <Redo2 size={13} />
          </DocBtn>
          {anyCollapsed ? (
            <DocBtn title="모두 펼치기" onClick={expandAll}>
              <ChevronsUpDown size={13} />
            </DocBtn>
          ) : (
            <DocBtn title="모두 접기 — 일자마다 요약 한 줄로" onClick={collapseAll}>
              <ChevronsDownUp size={13} />
            </DocBtn>
          )}
        </span>
      </div>

      {/* 마스트헤드 — 굵은 룰 아래 주간 정보 */}
      <header className="pt-4">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          <Field label="보고 주 — 지난주 월요일">
            <input
              type="date"
              value={report.prevWeekRange.start}
              onChange={(e) => e.target.value && act(setWeekByPrevMonday(report, e.target.value))}
              className="ms-input"
            />
          </Field>
          <span className="pb-1 text-[11px] leading-relaxed text-fg-muted">
            보고 대상 {report.prevWeekRange.start} ~ {report.prevWeekRange.end} · 일정 예정{' '}
            {report.currentWeekRange.start} ~ {report.currentWeekRange.end}
          </span>
        </div>

      </header>

      {/* 일자 — 보고서와 같은 계층: 일자 → 행(지원장소·고객사) → 항목 머리 → 대화 턴 */}
      <div className="mt-8">
        {report.days.map((day, di) => {
          const onLeave = isOnLeave(day);
          const dayCollapsed = collapsedDays.has(day.date);
          const continueDates = report.days
            .filter((d) => d.date !== day.date && !d.holiday)
            .map((d) => ({
              date: d.date,
              label: shortDate(d.date, d.weekday),
            }));
          const stat = dayStats[di];
          const status = day.holiday
            ? '휴일'
            : onLeave
              ? '휴가'
              : day.partial
                ? day.partial.label.trim() || '반차'
                : '';
          return (
            <section
              key={`${day.date}-${di}`} // 파서는 중복 일자를 허용(경고)하므로 date만으로는 key가 충돌한다
              id={`vday-${day.date}`}
              className={`vx-day ${day.holiday ? 'vx-day--off' : ''}`}
            >
              {/* 일자 제목 — 스크롤해도 요일 띠 아래에 고정 */}
              <div className="vx-dayhead">
                {!day.holiday && (
                  <button
                    type="button"
                    onClick={() => toggleDay(day.date)}
                    aria-expanded={!dayCollapsed}
                    title={dayCollapsed ? '펼치기' : '접기'}
                    className="vx-icon -ml-1 self-center"
                  >
                    {dayCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </button>
                )}
                <span
                  className="vx-daytitle"
                  style={{
                    color: day.holiday ? 'var(--stamp-red)' : day.partial ? 'var(--stamp-amber)' : 'var(--fg)',
                  }}
                >
                  {formatDayTitle(day.date)}
                </span>
                <span className="vx-daymeta">{WEEKDAY_LABEL[day.weekday] ?? day.weekday}</span>
                {status && <span className="vx-daymeta font-semibold">{status}</span>}
                {!day.holiday && stat.written > 0 && <span className="vx-daycount">항목 {stat.written}</span>}
                {!day.holiday && dayCollapsed && stat.written === 0 && (
                  <span className="vx-daycount">아직 작성 전</span>
                )}
                {stat.pending > 0 && (
                  <span className="vx-daycount font-semibold" style={{ color: 'var(--tok-pending)' }}>
                    미결 {stat.pending}
                  </span>
                )}
                <span className="vx-daytools">
                  {/* 근태 — 켜진 것만 진하게. 누르면 켜고 끈다 */}
                  {!day.holiday && (
                    <>
                      <label className="vx-toggle">
                        <input type="checkbox" checked={onLeave} onChange={() => act(toggleLeave(report, di))} />
                        휴가
                      </label>
                      <label className="vx-toggle">
                        <input
                          type="checkbox"
                          checked={!!day.partial}
                          onChange={() => act(toggleHalfday(report, di))}
                        />
                        반차
                      </label>
                    </>
                  )}
                  <label className="vx-toggle">
                    <input type="checkbox" checked={!!day.holiday} onChange={() => act(toggleHoliday(report, di))} />
                    휴일
                  </label>
                  <button
                    type="button"
                    title="일자 삭제"
                    aria-label="일자 삭제"
                    tabIndex={-1}
                    onClick={() => removeWithUndo(removeDay(report, di), `${shortDate(day.date, day.weekday)} 일자를`)}
                    className="vx-icon vx-daydel"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>

              {day.holiday ? (
                <div className="vx-dayline">
                  <Chip
                    label="휴일 사유"
                    field="holiday"
                    value={day.holiday.reason}
                    placeholder="주말은 비워 둡니다 — 공휴일만 예: 근로자의 날"
                    onChange={(v) => apply(updateHolidayReason(report, di, v))}
                    grow
                  />
                </div>
              ) : dayCollapsed ? null : (
                <div>
                  {day.partial && (
                    <div className="vx-dayline">
                      <Chip
                        label="근태 표기"
                        field="partial"
                        ariaLabel="반차/근태 표기"
                        value={day.partial.label}
                        placeholder="예: 오후 반차(13:00~18:00) — 표의 날짜 칸 아래 표기"
                        onChange={(v) => apply(updateHalfdayLabel(report, di, v))}
                        grow
                      />
                    </div>
                  )}
                  {day.blocks.map((block, bi) => {
                    const building = block.locations.map(buildingOf).find(Boolean);
                    return (
                      <div key={bi} id={`vrow-${di}-${bi}`} className="vx-row">
                        {/* 행 머리 — 표의 지원장소 · 고객사|작업구분 칸. 아래 항목들의 머리 띠 */}
                        <div className="vx-rowhead">
                          <Chip
                            label="지원장소"
                            field="locations"
                            value={block.locations.join(' / ')}
                            list="visual-place-options"
                            title="지원장소 — 현장 방문은 고객사(건물), 원격 대응은 근무 위치(파트너사·회사·외부·휴가). 여러 장소는 ' / '로 구분"
                            onChange={(v) =>
                              apply(
                                updateBlockFields(report, di, bi, {
                                  // 파서(@LOC)와 동일 규칙: 공백 둘러싼 슬래시만 구분자. 마지막 빈 조각은 타이핑 중 보존
                                  locations: v
                                    .split(LOCATION_SEPARATOR)
                                    .map((x) => x.trim())
                                    .filter((x, idx, arr) => x !== '' || idx === arr.length - 1),
                                }),
                              )
                            }
                            // 현장이면 항목의 빈 건물 칸을 지원장소의 건물명으로
                            onBlur={() => apply(fillItemSitesFromRow(reportRef.current, di, bi))}
                            strong
                          />
                          <Chip
                            label="고객사|작업구분"
                            field="customer"
                            value={block.customer}
                            list="visual-customer-options"
                            title="고객사|작업구분 — 항목의 [고객사]와 같은 약칭, 고객 건이 아니면 제조사문의·미팅·테스트. 항목의 빈 고객사 칸에 자동으로 채워집니다"
                            onChange={(v) =>
                              apply(
                                updateBlockFields(report, di, bi, {
                                  customer: v,
                                }),
                              )
                            }
                            // 같은 값을 두 번 쓰지 않게 — 항목의 빈 고객사 칸을 채운다
                            onBlur={() => apply(fillItemClientsFromRow(reportRef.current, di, bi))}
                            strong
                          />
                          {day.blocks.length > 1 && (
                            <button
                              type="button"
                              title="이 행 삭제"
                              aria-label="이 행 삭제"
                              tabIndex={-1}
                              onClick={() => removeWithUndo(removeLocationBlock(report, di, bi), '행을')}
                              className="vx-icon vx-rowtool"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>

                        {block.items.map((item, ii) => {
                          const key = `${di}-${bi}-${ii}`;
                          return (
                            <ItemEditor
                              key={ii}
                              item={item}
                              order={ii + 1}
                              canMoveUp={ii > 0}
                              canMoveDown={ii < block.items.length - 1}
                              anchorId={`vitem-${key}`}
                              continueDates={continueDates}
                              collapsed={collapsedItems.has(key)}
                              onToggleCollapse={() => toggleItem(key)}
                              onField={(patch) => apply(updateItemFields(report, di, bi, ii, patch))}
                              onClientCommit={() => apply(fillRowCustomerFromItem(reportRef.current, di, bi, ii))}
                              onMove={(dir) => act(moveItem(report, di, bi, ii, dir))}
                              onRemove={() =>
                                isBlankItem(item)
                                  ? act(removeItem(report, di, bi, ii))
                                  : removeWithUndo(removeItem(report, di, bi, ii), '항목을')
                              }
                              onContinue={(date) => {
                                const { report: next, at } = continueItem(report, di, bi, ii, date);
                                if (next === report) return;
                                act(next);
                                if (at) {
                                  setFocusRequest({
                                    id: `vitem-${at.di}-${at.bi}-${at.ii}`,
                                    selector: 'textarea[data-turn]',
                                  });
                                }
                              }}
                              onAddBlock={(kind) => act(addContentBlock(report, di, bi, ii, kind))}
                              onUpdateBlock={(ci, b) => apply(updateContentBlock(report, di, bi, ii, ci, b))}
                              onMoveBlock={(ci, dir) => act(moveContentBlock(report, di, bi, ii, ci, dir))}
                              onRemoveBlock={(ci) =>
                                removeWithUndo(removeContentBlock(report, di, bi, ii, ci), '블록을')
                              }
                              onIndentBlock={(ci, indent) => act(setContentIndent(report, di, bi, ii, ci, indent))}
                              onAddTurn={(ci, turn, at) => act(addTurn(report, di, bi, ii, ci, turn, at))}
                              onUpdateTurn={(ci, ti, patch) => apply(updateTurn(report, di, bi, ii, ci, ti, patch))}
                              onReplaceTurn={(ci, ti, turns: DialogTurn[]) =>
                                act(replaceTurn(report, di, bi, ii, ci, ti, turns))
                              }
                              onRemoveTurn={(ci, ti) => act(removeTurn(report, di, bi, ii, ci, ti))}
                              onMoveTurn={(ci, ti, dir) => act(moveTurn(report, di, bi, ii, ci, ti, dir))}
                              onTurnToList={(ci, ti, lines) => {
                                const { report: next, at } = convertTurnToList(report, di, bi, ii, ci, ti, lines);
                                act(next);
                                return at;
                              }}
                              onLineToTurn={(ci, li, turns) => {
                                const { report: next, at } = convertListLineToTurn(report, di, bi, ii, ci, li, turns);
                                act(next);
                                return at;
                              }}
                            />
                          );
                        })}
                        <AddItemButton
                          title={building ? `현장(${building}) 항목 추가` : '항목 추가'}
                          onPick={(body) => {
                            act(addItem(report, di, bi, body));
                            // 행에서 고객사를 물려받았으면 제목부터, 아니면 고객사부터
                            const inherits =
                              !!block.customer.trim() && !WORK_CATEGORIES.includes(block.customer.trim());
                            setFocusRequest({
                              id: `vitem-${di}-${bi}-${block.items.length}`,
                              selector: `[data-field="${inherits ? 'workType' : 'client'}"]`,
                            });
                          }}
                        />
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      act(addLocationBlock(report, di));
                      setFocusRequest({
                        id: `vrow-${di}-${day.blocks.length}`,
                        selector: '[data-field="locations"]',
                      });
                    }}
                    className="vx-add mt-2"
                  >
                    <Plus size={11} />
                    {day.blocks.length === 0 ? '이 날짜에 작업 추가' : '다른 지원장소·고객사 행 추가'}
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 문서 말미 — 일자 추가 */}
      <footer className="mt-10 border-t border-rule pt-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <Field label="일자 추가">
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="ms-input" />
          </Field>
          <button
            type="button"
            disabled={!newDate || report.days.some((d) => d.date === newDate)}
            onClick={() => {
              act(
                addDay(report, newDate, {
                  weekendHoliday: true,
                  skeleton: true,
                }),
              );
              setFocusRequest({
                id: `vday-${newDate}`,
                selector: '[data-field="locations"]',
              });
              setNewDate('');
            }}
            className="ms-add mb-1 disabled:opacity-30"
          >
            <Plus size={12} /> 추가
          </button>
          {missing.length > 0 && (
            <button
              type="button"
              onClick={() => act(fillMissingDays(report))}
              className="ms-add mb-1"
              title={`보고 주에서 빠진 일자: ${missing.map((d) => shortDate(d)).join(', ')}`}
            >
              <CalendarPlus size={12} /> 빠진 일자 채우기 ({missing.length}일)
            </button>
          )}
          <span className="mb-1.5 text-[11px] text-fg-muted">
            빈 주(월~일) 한 번에 만들기는 툴바의 [새 주간보고] (Ctrl+N)
          </span>
        </div>
      </footer>

      {/* 자동완성 목록 — 항목마다 렌더하면 id가 중복되므로 문서에 1회만 */}
      <datalist id="visual-channel-options">
        {KNOWN_CHANNELS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="visual-place-options">
        {suggestions.places.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="visual-customer-options">
        {suggestions.customers.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="visual-contact-options">
        {suggestions.contacts.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
});

/** 문서 단위 아이콘 버튼 — 되돌리기·다시 실행 */
function DocBtn({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center rounded-sharp p-1 text-fg-muted transition hover:bg-bg-sunken hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * 항목 추가 — 본문 모양을 고른다. 목록(`- 한 일` / `> 상세`)이 사용자 보고서의 주된 모양이고,
 * 대화 이력(`->` 상대 / `<-` 대응)은 문의 ↔ 회신이 핵심인 건에 쓴다.
 * 전에는 늘 대화 이력으로만 만들어졌다(2026-11-16 사용자 신고). 만든 뒤에도 줄 앞 `- `·`-> `로 바꿀 수 있다.
 */
function AddItemButton({ title, onPick }: { title: string; onPick: (body: ItemBody) => void }) {
  const [open, setOpen] = useState(false);
  useDismiss(open, () => setOpen(false), 'data-additem-menu');
  const firstRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);
  const pick = (body: ItemBody) => {
    setOpen(false);
    onPick(body);
  };
  return (
    <div className="vx-additem" data-additem-menu={open ? '' : undefined}>
      <button
        type="button"
        className="vx-add"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={12} /> 항목 추가
      </button>
      {open && (
        <div className="vx-menu" role="menu" aria-label="새 항목의 본문">
          <div className="vx-menu-h">본문 모양</div>
          <button ref={firstRef} type="button" role="menuitem" onClick={() => pick('bullets')}>
            <span className="vx-glyph">-</span>
            목록 — 한 일 · &gt; 상세
          </button>
          <button type="button" role="menuitem" onClick={() => pick('dialog')}>
            <span className="vx-glyph">-&gt;</span>
            대화 이력 — 상대 발화 · 내 대응
          </button>
        </div>
      )}
    </div>
  );
}
