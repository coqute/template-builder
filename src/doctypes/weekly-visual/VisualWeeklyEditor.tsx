import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, Plus, Trash2 } from 'lucide-react';
import { parseTolerant, serialize, type WeekReport } from '@core/index';
import {
  addContentBlock,
  addDay,
  addItem,
  addLocationBlock,
  moveContentBlock,
  moveItem,
  removeContentBlock,
  removeDay,
  removeItem,
  removeLocationBlock,
  setWeekByPrevMonday,
  toggleHoliday,
  updateBlockFields,
  updateHeader,
  updateHolidayReason,
  updateItemFields,
  updateContentBlock,
} from '@core/edit';
import { ItemEditor } from './ItemEditor';

interface Props {
  /** 단일 소스 md — 편집 시 즉시 serialize해 반영 (저장/미리보기/상태바 경로 무변경) */
  md: string;
  onMd: (next: string) => void;
}

const inputCls =
  'rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-accent';

/**
 * 주간보고서 비주얼 에디터 — AST를 로컬 상태로 소유해 입력이 즉각 반응하고,
 * 매 편집을 serialize→onMd로 흘려 md(저장 포맷)와 동기화한다.
 * 외부 md 변경(열기/샘플/Gmail 가져오기)은 ref 비교로 감지해 AST를 재초기화한다.
 */
export function VisualWeeklyEditor({ md, onMd }: Props) {
  const [report, setReport] = useState<WeekReport>(() => parseTolerant(md).report);
  const lastSyncedMd = useRef<string>(md);
  const [newDate, setNewDate] = useState('');

  useEffect(() => {
    if (md !== lastSyncedMd.current) {
      // 외부에서 md가 바뀜(열기/샘플/새로만들기 등) — AST 재초기화
      setReport(parseTolerant(md).report);
      lastSyncedMd.current = md;
    }
  }, [md]);

  const apply = (next: WeekReport) => {
    setReport(next);
    const s = serialize(next);
    lastSyncedMd.current = s;
    onMd(s);
  };

  return (
    <div className="scrollbar-thin h-full space-y-2 overflow-y-auto bg-bg-elevated p-2.5">
      {/* 주간 헤더 */}
      <section className="rounded-card border border-rule bg-bg p-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-fg-muted">보고 주(월)</span>
            <input
              type="date"
              value={report.prevWeekRange.start}
              onChange={(e) => e.target.value && apply(setWeekByPrevMonday(report, e.target.value))}
              className={inputCls}
              title="지난 주 월요일 — @PREV(월~일)·@CURRENT(다음주)가 자동 계산됩니다"
            />
          </label>
          <span className="text-[10px] text-fg-muted">
            @PREV {report.prevWeekRange.start} ~ {report.prevWeekRange.end} · @CURRENT{' '}
            {report.currentWeekRange.start} ~ {report.currentWeekRange.end}
          </span>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-fg-muted">작성자</span>
            <input
              type="text"
              value={report.authorName}
              onChange={(e) => apply(updateHeader(report, { authorName: e.target.value }))}
              className={`${inputCls} w-24`}
            />
          </label>
        </div>
      </section>

      {/* 일자 카드 */}
      {report.days.map((day, di) => (
        <section key={day.date} className="rounded-card border border-rule bg-bg p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`font-mono text-xs font-semibold ${day.holiday ? 'text-red-500' : 'text-fg'}`}
            >
              {day.date} ({day.weekday})
            </span>
            <label className="flex items-center gap-1 text-[10px] text-fg-soft">
              <input
                type="checkbox"
                checked={!!day.holiday}
                onChange={() => apply(toggleHoliday(report, di))}
              />
              휴무
            </label>
            {day.holiday && (
              <input
                type="text"
                value={day.holiday.reason}
                placeholder="휴무 사유 (예: 근로자의 날)"
                onChange={(e) => apply(updateHolidayReason(report, di, e.target.value))}
                className={`${inputCls} flex-1`}
              />
            )}
            <span className="flex-1" />
            <button
              type="button"
              title="일자 삭제"
              onClick={() => apply(removeDay(report, di))}
              className="flex items-center rounded-sharp p-1 text-fg-muted hover:bg-bg-sunken hover:text-fg"
            >
              <Trash2 size={12} />
            </button>
          </div>

          {day.holiday ? (
            <p className="text-[11px] text-fg-muted">휴무 행 — 빨간 배경으로 렌더됩니다.</p>
          ) : (
            <div className="space-y-2">
              {day.blocks.map((block, bi) => (
                <div key={bi} className="rounded-sharp border border-dashed border-rule p-2">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-semibold text-fg-muted">@LOC</span>
                    <input
                      type="text"
                      value={block.locations.join(' / ')}
                      placeholder="지원장소 ( / 로 줄바꿈)"
                      onChange={(e) =>
                        apply(
                          updateBlockFields(report, di, bi, {
                            locations: e.target.value
                              .split('/')
                              .map((s) => s.trim())
                              .filter((s, idx, arr) => s !== '' || idx === arr.length - 1),
                          }),
                        )
                      }
                      className={`${inputCls} w-44`}
                    />
                    <span className="text-[10px] font-semibold text-fg-muted">@CUS</span>
                    <input
                      type="text"
                      value={block.customer}
                      placeholder="고객사/작업구분"
                      onChange={(e) => apply(updateBlockFields(report, di, bi, { customer: e.target.value }))}
                      className={`${inputCls} w-40`}
                    />
                    <span className="flex-1" />
                    {day.blocks.length > 1 && (
                      <button
                        type="button"
                        title="장소 블록 삭제"
                        onClick={() => apply(removeLocationBlock(report, di, bi))}
                        className="flex items-center rounded-sharp p-1 text-fg-muted hover:bg-bg-sunken hover:text-fg"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {block.items.map((item, ii) => (
                      <ItemEditor
                        key={ii}
                        item={item}
                        canMoveUp={ii > 0}
                        canMoveDown={ii < block.items.length - 1}
                        onField={(patch) => apply(updateItemFields(report, di, bi, ii, patch))}
                        onMove={(dir) => apply(moveItem(report, di, bi, ii, dir))}
                        onRemove={() => apply(removeItem(report, di, bi, ii))}
                        onAddBlock={(kind) => apply(addContentBlock(report, di, bi, ii, kind))}
                        onUpdateBlock={(ci, b) => apply(updateContentBlock(report, di, bi, ii, ci, b))}
                        onMoveBlock={(ci, dir) => apply(moveContentBlock(report, di, bi, ii, ci, dir))}
                        onRemoveBlock={(ci) => apply(removeContentBlock(report, di, bi, ii, ci))}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => apply(addItem(report, di, bi))}
                      className="flex items-center gap-1 rounded-sharp border border-dashed border-rule px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent hover:text-fg"
                    >
                      <Plus size={11} /> 작업(@SUM) 추가
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => apply(addLocationBlock(report, di))}
                className="flex items-center gap-1 rounded-sharp border border-dashed border-rule px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent hover:text-fg"
              >
                <Plus size={11} /> {day.blocks.length === 0 ? '작업 블록 추가' : '다른 장소 블록 추가'}
              </button>
            </div>
          )}
        </section>
      ))}

      {/* 일자 추가 */}
      <section className="flex items-center gap-2 rounded-card border border-dashed border-rule bg-bg p-2.5">
        <CalendarPlus size={13} className="text-fg-muted" />
        <input
          type="date"
          value={newDate}
          onChange={(e) => setNewDate(e.target.value)}
          className={inputCls}
        />
        <button
          type="button"
          disabled={!newDate || report.days.some((d) => d.date === newDate)}
          onClick={() => {
            apply(addDay(report, newDate));
            setNewDate('');
          }}
          className="rounded-sharp px-2.5 py-1 text-[11px] font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          일자 추가
        </button>
        <span className="text-[10px] text-fg-muted">
          빈 주 5일 생성은 툴바 [템플릿](Ctrl+T)을 사용하세요.
        </span>
      </section>
    </div>
  );
}
