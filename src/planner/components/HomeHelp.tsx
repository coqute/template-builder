/** 설정(F1)의 홈 구역 — 달력 연결, 읽을 달력, 후보를 찾는 기간, 시작 화면 + 가이드 (설계 §6.6) */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadStartMode, saveStartMode, type StartMode } from '../../hooks/useDocType';
import { plannerApi } from '../api';
import type { CalendarInfo, CalendarStatus, PlannerSettings } from '../types';
import { NotionSettingsBox } from './NotionHelp';

const BOX = 'mb-3 rounded-card border border-rule bg-bg p-3';
const H3 = 'mb-2 text-xs font-semibold text-fg';
const P = 'text-[11px] leading-relaxed text-fg-muted';
const SMALL_BTN = 'rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken';
const LOOKBACK = [14, 30, 60, 90];

export function HomeSettings({ mono, open }: { mono: boolean; open: boolean }) {
  const api = useMemo(plannerApi, []);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [settings, setSettings] = useState<PlannerSettings | null>(null);
  const [path, setPath] = useState('');
  const [start, setStart] = useState<StartMode>(loadStartMode);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const s = await api.calendarStatus();
      if (!alive) return;
      setStatus(s);
      const store = await api.plannerGet();
      if (!alive) return;
      if (store.ok) {
        setSettings(store.state.settings);
        setPath(store.path);
      }
      if (s.canRead && s.canList) {
        const list = await api.calendarList();
        if (alive) setCalendars(list.ok ? list.calendars : null);
      } else setCalendars(null);
    })();
    return () => {
      alive = false;
    };
  }, [api, open]);

  const save = useCallback(
    async (patch: Partial<PlannerSettings>) => {
      const r = await api.plannerApply({ type: 'settings', patch });
      if (r.ok) setSettings(r.state.settings);
    },
    [api],
  );

  // 저장하는 달력 ID — 본인 달력은 주소 대신 'primary'로 적는다
  const idOf = (c: CalendarInfo) => (c.primary ? 'primary' : c.id);
  const toggleCalendar = (c: CalendarInfo, on: boolean) => {
    if (c.holiday) return void save({ holidays: on });
    const cur = settings?.calendars ?? ['primary'];
    const next = on ? [...new Set([...cur, idOf(c)])] : cur.filter((id) => id !== idOf(c));
    void save({ calendars: next.includes('primary') ? next : ['primary', ...next] });
  };

  return (
    <>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ calendar' : 'Google 달력'}</h3>
        {!status ? (
          <p className={P}>확인 중…</p>
        ) : status.canRead ? (
          <p className={P}>
            <b className="text-fg">연결됨</b> — 일정 읽기{status.canWrite ? ' · 쓰기(만들기·옮기기·지우기)' : ''}
            {!status.canWrite && ' (쓰기 권한은 없어 홈에서 일정을 만들거나 옮길 수 없습니다)'}
          </p>
        ) : (
          <p className={P}>
            <b className="text-fg">연결되지 않음</b> —{' '}
            {status.reason === 'credentials-missing' ? '자격증명 파일(oauth-client.json · token.json)을 찾지 못했습니다.' : '토큰에 달력 권한이 없습니다.'}
          </p>
        )}
        {status && (!status.canRead || !status.canWrite) && (
          <ul className={`${P} mt-2 space-y-1`}>
            <li>앱은 Gmail 초안과 같은 자격증명 폴더의 토큰을 읽기만 합니다. 그 토큰을 발급하는 쪽에서 아래 범위를 더해 다시 동의하세요.</li>
            <li>
              읽기: <code className="font-mono">calendar.events.readonly</code> · <code className="font-mono">calendar.calendarlist.readonly</code>
            </li>
            <li>
              쓰기(선택): <code className="font-mono">calendar.events.owned</code>
            </li>
            <li>그 OAuth 클라이언트의 Google Cloud 프로젝트에서 Google Calendar API가 켜져 있어야 합니다.</li>
          </ul>
        )}
        {status?.canRead && (
          <div className="mt-2">
            <p className={`${P} mb-1`}>읽을 달력{calendars ? '' : status.canList ? ' — 목록을 읽는 중' : ' — 달력 목록 권한이 없어 본인 달력만 읽습니다'}</p>
            {calendars?.map((c) => {
              const on = c.primary || (c.holiday ? (settings?.holidays ?? true) : (settings?.calendars ?? []).includes(idOf(c)));
              return (
                <label key={c.id} className="flex items-center gap-2 py-0.5 text-[11.5px] text-fg-soft">
                  <input type="checkbox" checked={on} disabled={c.primary} onChange={(e) => toggleCalendar(c, e.target.checked)} style={{ accentColor: 'var(--fg)' }} />
                  {/* 남의 달력은 Google 달력에서 정해 둔 색을 함께 보인다 — 홈의 띠·미리보기에서 그 색으로 가른다 */}
                  {!c.primary && !c.holiday && !c.mine && c.color && <i className="hm-dot" style={{ background: c.color }} aria-hidden="true" />}
                  <span className="min-w-0 truncate">
                    {c.primary ? '내 달력' : c.summary}
                    {c.holiday && ' · 공휴일'}
                    {!c.primary && !c.holiday && !c.mine && ' · 2주 띠에만 옅게'}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <NotionSettingsBox mono={mono} open={open} />

      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ candidates' : '작업일지에서 후보 찾기'}</h3>
        <p className={`${P} mb-2`}>작업일지의 ‘회신 대기’·‘확인 필요’ 같은 상태로 끝난 사안을 후보로 보여 줍니다. 이 기간보다 오래된 것은 세지 않습니다.</p>
        <div className="flex items-center gap-1" role="group" aria-label="후보를 찾는 기간">
          {LOOKBACK.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={settings?.lookbackDays === d}
              onClick={() => void save({ lookbackDays: d })}
              className={SMALL_BTN}
              style={settings?.lookbackDays === d ? { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' } : undefined}
            >
              최근 {d}일
            </button>
          ))}
        </div>
      </section>

      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ start' : '시작 화면'}</h3>
        <div className="flex items-center gap-1" role="group" aria-label="시작 화면">
          {(
            [
              ['home', '홈'],
              ['last', '마지막으로 보던 화면'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={start === mode}
              onClick={() => {
                saveStartMode(mode);
                setStart(mode);
              }}
              className={SMALL_BTN}
              style={start === mode ? { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' } : undefined}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={`${P} mt-2`}>할 일은 이 파일에 저장됩니다 — 작업일지·주간보고·달력에는 단추를 누를 때만 씁니다.</p>
        <div className="mt-1 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-soft" title={path}>
            {path || '…'}
          </code>
          <button type="button" className={SMALL_BTN} onClick={() => void api.plannerReveal()}>
            폴더 열기
          </button>
        </div>
      </section>
    </>
  );
}

export function HomeGuide({ mono }: { mono: boolean }) {
  return (
    <>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ read' : '화면 읽는 법'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li>
            <b>맨 위 한 줄</b> — 오늘 날짜, 다음 일정, 기한 지남·오늘·이번 주 할 일 수. 숫자를 누르면 그 묶음으로 갑니다.
          </li>
          <li>
            <b>2주 띠</b> — 이번 주와 다음 주. 날 칸을 누르면 화면 가운데에 그날의 미리보기가 열립니다 — 일정·다른 달력·할 일·Notion 작성. ‹ ›나 ← → 키, 그 주의 날 줄로 닫지 않고 옆 날로 넘어가고, Esc나 바깥을 눌러 닫습니다. 여러 건이 겹쳐 날 칸에서 잘린 것은 여기서 읽습니다.
          </li>
          <li>
            <b>할 일</b> — 기한 지남 → 오늘 → 이번 주 → 다음 주 이후 → 기한 없음 → 기다리는 중 순서입니다.
          </li>
          <li>
            <b>확정 일정</b> — Google 달력에서 읽은 회의·작업·휴가입니다. 달력에서 바뀌면 ‘바뀜’으로 알려 줍니다.
          </li>
        </ul>
      </section>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ tasks' : '할 일 쓰기'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li>
            입력칸에 적고 <b>Enter</b>. 끝에 <code className="font-mono">11/27</code>처럼 쓰면 기한이 됩니다. (Ctrl+N = 입력칸으로)
          </li>
          <li>제목을 누르면 줄 아래로 상자가 펼쳐져 고객사·기한·상태·메모를 고칩니다.</li>
          <li>남의 회신을 기다리는 일은 상태를 ‘기다리는 중’으로 바꾸면 며칠째인지 셉니다.</li>
          <li>체크하면 끝남입니다. 8초 안에 [되돌리기], 또는 [오늘 일지에 기록]으로 작업일지 끝에 한 블록을 남깁니다.</li>
        </ul>
      </section>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ worklog' : '작업일지와 잇기'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li>
            <b>후보</b> — 작업일지 사안의 마지막 상태 줄이 ‘회신 대기’나, 직접 적어 둔 ‘확인 필요’·‘~ 예정’으로 끝나면 올라옵니다. [할 일로] 올리거나 [무시]합니다. 일지 루틴은 ‘확인 필요’·‘예정’ 같은 말을 스스로 붙이지 않습니다 — 보낸 문의의 ‘회신 대기’만 적습니다.
          </li>
          <li>
            <b>일지 11/18 ↗</b>를 누르면 작업일지 탭에서 그 사안이 열립니다.
          </li>
          <li>
            작업일지 탭에서 커서를 사안 안에 두고 <b>⋯ → 이 사안에 일정·할 일 달기</b>(Ctrl+Shift+D). ■ 줄 끝에 표지가 붙고, 표지를 누르면 홈으로 옵니다.
          </li>
          <li>같은 사안이 일지에서 ‘완료’로 닫히면 할 일 옆에 [끝냄으로]가 나옵니다.</li>
        </ul>
      </section>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ notion' : 'Notion과 잇기'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li>
            <b>날짜별 Notion 작성</b> — 연결하면 2주 띠 위에 지난 주 줄이 붙고, 날 칸마다 그날 만들거나 고친 페이지가 표지와 함께 나옵니다. 날을 누르면 화면 가운데에 그날의 미리보기가 열리고, 줄을 누르면 그 페이지가 Notion에서 열립니다.
          </li>
          <li>
            <b>회의록 ↗</b> — 회의록 DB의 페이지는 만든 시각이 본인 달력 일정의 시간(앞뒤 30분) 안이면 그 일정 줄에 이어집니다. 2주 띠의 일정 끝에도 작은 표지가 붙습니다.
          </li>
          <li>달력에도 Notion에도 쓰지 않습니다. 이어 놓은 것은 저장하지 않고 읽을 때마다 다시 맞춥니다.</li>
        </ul>
      </section>
      <section className={BOX}>
        <h3 className={H3}>{mono ? '$ claude' : 'Claude에게 시키기 (플래너 MCP)'}</h3>
        <ul className="space-y-1 text-[11px] text-fg-soft">
          <li>
            저장소의 <code className="font-mono">scripts/planner-tool.mjs</code>를 Claude Code에 등록하면, 말로 할 일을 더하고 기한을 옮기고 작업일지의 사안에 할 일을 달 수 있습니다.
          </li>
          <li>
            <code className="font-mono">claude mcp add --scope user tb-planner -- node &quot;&lt;저장소&gt;/scripts/planner-tool.mjs&quot; mcp</code>
          </li>
          <li>Claude가 고친 할 일은 3초 안에 여기에 반영되고 ‘바뀜’으로 표시됩니다. ⋯ → 바뀐 기록에서 되돌릴 수 있습니다.</li>
          <li>일지에는 오늘 일지 끝에 후속 블록을 덧붙이는 것만 합니다. 지난 일지와 기존 줄은 건드리지 않습니다.</li>
          <li>달력 일정을 옮기거나 새로 잡는 것은 Claude에 연결된 Google 달력으로 합니다 — 홈은 다음에 달력을 읽을 때 ‘바뀜’으로 알려 줍니다.</li>
        </ul>
      </section>
    </>
  );
}
