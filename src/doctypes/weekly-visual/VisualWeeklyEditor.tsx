import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import { Field, ItemEditor } from './ItemEditor';

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
 * 주간보고서 비주얼 에디터 — "원고지 조판".
 * 에디터 전체가 하나의 연속 문서: 마스트헤드(주간 정보) → 러닝 헤드(날짜) →
 * 고스트 넘버럴(작업) → 밑줄 필드. 카드·박스·컬러 보더 없음.
 * AST를 로컬 상태로 소유하고 매 편집을 serialize→onMd로 동기화한다.
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
    <div className="scrollbar-thin h-full overflow-y-auto bg-bg px-5 py-4">
      {/* 마스트헤드 — 굵은 룰 아래 주간 정보 */}
      <header className="border-t-2 pt-3" style={{ borderTopColor: 'var(--fg)' }}>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          <Field label="보고 주 — 지난주 월요일">
            <input
              type="date"
              value={report.prevWeekRange.start}
              onChange={(e) => e.target.value && apply(setWeekByPrevMonday(report, e.target.value))}
              className="ms-input"
            />
          </Field>
          <Field label="작성자" width="w-28">
            <input
              type="text"
              value={report.authorName}
              onChange={(e) => apply(updateHeader(report, { authorName: e.target.value }))}
              className="ms-input"
            />
          </Field>
          <span className="pb-1 text-[11px] leading-relaxed text-fg-muted">
            보고 대상 {report.prevWeekRange.start} ~ {report.prevWeekRange.end} · 이번 주 계획{' '}
            {report.currentWeekRange.start} ~ {report.currentWeekRange.end}
          </span>
        </div>
      </header>

      {/* 날짜 섹션 — 러닝 헤드 + 작업 목록 */}
      <div className="mt-8 space-y-9">
        {report.days.map((day, di) => {
          const offsets: number[] = [];
          let acc = 0;
          for (const b of day.blocks) {
            offsets.push(acc);
            acc += b.items.length;
          }
          return (
            <section key={day.date} className="group/day">
              {/* 러닝 헤드 — 날짜 제목 뒤로 룰이 우측 끝까지 */}
              <div className="flex items-center gap-3">
                <span
                  className="text-[17px] font-bold tracking-tight"
                  style={{ color: day.holiday ? 'var(--stamp-red, #DC2626)' : 'var(--fg)' }}
                >
                  {formatDayTitle(day.date)}
                </span>
                <span className="text-[12px] text-fg-soft">
                  {WEEKDAY_LABEL[day.weekday] ?? day.weekday}
                  {day.holiday ? ' · 휴무' : ''}
                </span>
                <span className={`day-rule ${day.holiday ? 'day-rule--holiday' : ''}`} />
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted opacity-60 transition group-hover/day:opacity-100">
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
                  className="flex items-center rounded-sharp p-1 text-fg-muted opacity-60 transition hover:bg-bg-sunken hover:text-fg group-hover/day:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {day.holiday ? (
                <div className="mt-3 pl-[56px]">
                  <Field label="휴무 사유 — 표에서 빨간 행으로 강조됩니다">
                    <input
                      type="text"
                      value={day.holiday.reason}
                      placeholder="예: 근로자의 날"
                      onChange={(e) => apply(updateHolidayReason(report, di, e.target.value))}
                      className="ms-input w-full max-w-xs"
                    />
                  </Field>
                </div>
              ) : (
                <div className="mt-3 space-y-5">
                  {day.blocks.map((block, bi) => (
                    <div key={bi}>
                      {/* 메타 행 — 장소/구분 (넘버럴 컬럼과 정렬) */}
                      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 pl-[56px]">
                        <Field label="지원장소" width="w-56">
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
                            className="ms-input"
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
                            className="ms-input"
                          />
                        </Field>
                        <span className="flex-1" />
                        {day.blocks.length > 1 && (
                          <button
                            type="button"
                            title="이 장소 블록 삭제"
                            onClick={() => apply(removeLocationBlock(report, di, bi))}
                            className="ms-add mb-1"
                          >
                            <Trash2 size={11} /> 블록 삭제
                          </button>
                        )}
                      </div>

                      {/* 작업 목록 — 고스트 넘버럴, 작업 간 헤어라인 */}
                      <div className="mt-4">
                        {block.items.map((item, ii) => (
                          <ItemEditor
                            key={ii}
                            item={item}
                            order={offsets[bi] + ii + 1}
                            canMoveUp={ii > 0}
                            canMoveDown={ii < block.items.length - 1}
                            onField={(patch) => apply(updateItemFields(report, di, bi, ii, patch))}
                            onMove={(dir) => apply(moveItem(report, di, bi, ii, dir))}
                            onRemove={() => apply(removeItem(report, di, bi, ii))}
                            onAddBlock={(kind) => apply(addContentBlock(report, di, bi, ii, kind))}
                            onUpdateBlock={(ci, b) =>
                              apply(updateContentBlock(report, di, bi, ii, ci, b))
                            }
                            onMoveBlock={(ci, dir) =>
                              apply(moveContentBlock(report, di, bi, ii, ci, dir))
                            }
                            onRemoveBlock={(ci) => apply(removeContentBlock(report, di, bi, ii, ci))}
                          />
                        ))}
                        {/* 추가 버튼 — 다음 넘버럴을 옅게 예고 */}
                        <button
                          type="button"
                          onClick={() => apply(addItem(report, di, bi))}
                          className={`work-entry work-entry-add w-full text-left ${
                            block.items.length > 0 ? 'mt-4 border-t border-rule pt-4' : ''
                          }`}
                        >
                          <span className="work-numeral" aria-hidden="true">
                            {String(offsets[bi] + block.items.length + 1).padStart(2, '0')}
                          </span>
                          <span className="ms-add py-1">
                            <Plus size={12} /> 작업 추가
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="pl-[56px]">
                    <button
                      type="button"
                      onClick={() => apply(addLocationBlock(report, di))}
                      className="ms-add"
                    >
                      <Plus size={11} />
                      {day.blocks.length === 0 ? '이 날짜에 작업 추가' : '다른 장소 블록 추가'}
                    </button>
                  </div>
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
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="ms-input"
            />
          </Field>
          <button
            type="button"
            disabled={!newDate || report.days.some((d) => d.date === newDate)}
            onClick={() => {
              apply(addDay(report, newDate));
              setNewDate('');
            }}
            className="ms-add mb-1 disabled:opacity-30"
          >
            <Plus size={12} /> 추가
          </button>
          <span className="mb-1.5 text-[11px] text-fg-muted">
            빈 주(월~금) 한 번에 만들기는 툴바의 [템플릿] (Ctrl+T)
          </span>
        </div>
      </footer>
    </div>
  );
}
