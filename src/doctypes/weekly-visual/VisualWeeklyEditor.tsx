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
import { Field, ItemEditor, VISUAL_INPUT_CLS } from './ItemEditor';

interface Props {
  /** 단일 소스 md — 편집 시 즉시 serialize해 반영 (저장/미리보기/상태바 경로 무변경) */
  md: string;
  onMd: (next: string) => void;
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
    <div className="scrollbar-thin h-full space-y-4 overflow-y-auto bg-bg-deep p-3">
      {/* 주간 정보 */}
      <section className="rounded-card border border-rule bg-bg p-3">
        <h3 className="mb-2.5 text-[13px] font-semibold text-fg">주간 정보</h3>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <Field label="보고 주 — 지난주 월요일 선택">
            <input
              type="date"
              value={report.prevWeekRange.start}
              onChange={(e) => e.target.value && apply(setWeekByPrevMonday(report, e.target.value))}
              className={VISUAL_INPUT_CLS}
            />
          </Field>
          <Field label="작성자" width="w-32">
            <input
              type="text"
              value={report.authorName}
              onChange={(e) => apply(updateHeader(report, { authorName: e.target.value }))}
              className={VISUAL_INPUT_CLS}
            />
          </Field>
          <div className="pb-1 text-[12px] leading-relaxed text-fg-muted">
            보고 대상 {report.prevWeekRange.start} ~ {report.prevWeekRange.end}
            <br />
            이번 주 계획 {report.currentWeekRange.start} ~ {report.currentWeekRange.end}
          </div>
        </div>
      </section>

      {/* 일자 카드 */}
      {report.days.map((day, di) => (
        <section
          key={day.date}
          className="overflow-hidden rounded-card border border-rule bg-bg"
        >
          {/* 날짜 밴드 — 스캔 기준점 */}
          <div
            className="flex items-center gap-3 border-b border-rule px-3 py-2"
            style={{
              background: day.holiday ? 'rgba(220, 38, 38, 0.07)' : 'var(--bg-deep)',
              borderLeft: `3px solid ${day.holiday ? '#DC2626' : 'var(--accent)'}`,
            }}
          >
            <span className={`text-sm font-semibold ${day.holiday ? 'text-red-600' : 'text-fg'}`}>
              {formatDayTitle(day.date)}
            </span>
            <span className="text-[12px] text-fg-soft">
              {WEEKDAY_LABEL[day.weekday] ?? day.weekday} · {day.date}
            </span>
            <span className="flex-1" />
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-soft">
              <input
                type="checkbox"
                checked={!!day.holiday}
                onChange={() => apply(toggleHoliday(report, di))}
              />
              휴무
            </label>
            <button
              type="button"
              title="일자 삭제"
              onClick={() => apply(removeDay(report, di))}
              className="flex items-center rounded-sharp p-1 text-fg-muted transition hover:bg-bg-sunken hover:text-fg"
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="p-3">
            {day.holiday ? (
              <Field label="휴무 사유 — 표에서 빨간 행으로 강조됩니다">
                <input
                  type="text"
                  value={day.holiday.reason}
                  placeholder="예: 근로자의 날"
                  onChange={(e) => apply(updateHolidayReason(report, di, e.target.value))}
                  className={`${VISUAL_INPUT_CLS} w-full max-w-sm`}
                />
              </Field>
            ) : (
              <div className="space-y-3">
                {day.blocks.map((block, bi) => (
                  <div key={bi}>
                    {/* 장소/구분 필드 */}
                    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                      <Field label="지원장소" width="w-52">
                        <input
                          type="text"
                          value={block.locations.join(' / ')}
                          placeholder="예: 한강 제트플러스 4F"
                          title="여러 장소는 / 로 구분 (표에서 줄바꿈)"
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
                          className={VISUAL_INPUT_CLS}
                        />
                      </Field>
                      <Field label="고객사 / 작업구분" width="w-44">
                        <input
                          type="text"
                          value={block.customer}
                          placeholder="예: 한강 SRE"
                          onChange={(e) =>
                            apply(updateBlockFields(report, di, bi, { customer: e.target.value }))
                          }
                          className={VISUAL_INPUT_CLS}
                        />
                      </Field>
                      <span className="flex-1" />
                      {day.blocks.length > 1 && (
                        <button
                          type="button"
                          title="이 장소 블록 삭제"
                          onClick={() => apply(removeLocationBlock(report, di, bi))}
                          className="mb-1 flex items-center gap-1 rounded-sharp px-1.5 py-1 text-[11px] text-fg-muted transition hover:bg-bg-sunken hover:text-fg"
                        >
                          <Trash2 size={12} /> 블록 삭제
                        </button>
                      )}
                    </div>

                    {/* 작업 카드들 — 인덱스 스파인 언어 (번호 배지 + 좌측 스파인) */}
                    <div className="mt-2.5 space-y-3">
                      {block.items.map((item, ii) => (
                        <ItemEditor
                          key={ii}
                          item={item}
                          order={ii + 1}
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
                        className="flex items-center gap-1.5 rounded-sharp border border-rule px-2.5 py-1.5 text-[12px] font-medium text-fg-soft transition hover:border-accent hover:text-fg"
                      >
                        <Plus size={12} /> 작업 추가
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => apply(addLocationBlock(report, di))}
                  className="flex items-center gap-1.5 rounded-sharp border border-dashed border-rule px-2.5 py-1.5 text-[12px] text-fg-muted transition hover:border-accent hover:text-fg"
                >
                  <Plus size={12} />
                  {day.blocks.length === 0 ? '이 날짜에 작업 추가' : '다른 장소 블록 추가'}
                </button>
              </div>
            )}
          </div>
        </section>
      ))}

      {/* 일자 추가 */}
      <section className="flex flex-wrap items-end gap-3 rounded-card border border-dashed border-rule bg-bg p-3">
        <Field label="일자 추가">
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className={VISUAL_INPUT_CLS} />
        </Field>
        <button
          type="button"
          disabled={!newDate || report.days.some((d) => d.date === newDate)}
          onClick={() => {
            apply(addDay(report, newDate));
            setNewDate('');
          }}
          className="mb-0.5 flex items-center gap-1.5 rounded-sharp px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          <CalendarPlus size={13} /> 추가
        </button>
        <span className="mb-1.5 text-[12px] text-fg-muted">
          빈 주(월~금) 한 번에 만들기는 툴바의 [템플릿] (Ctrl+T)
        </span>
      </section>
    </div>
  );
}
