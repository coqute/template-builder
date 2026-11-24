/** 설정(F1)의 Notion 칸 — 키 저장, DB 찾기, 홈에 보일 DB와 회의록 DB 고르기 (설계 §19.10). 읽기만 한다 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { plannerApi } from '../api';
import { DEFAULT_NOTION } from '../ops';
import type { NotionSettings, NotionSource, NotionStatus } from '../types';
import { NOTION_CHANGED } from '../usePlanner';

const BOX = 'mb-3 rounded-card border border-rule bg-bg p-3';
const H3 = 'mb-2 text-xs font-semibold text-fg';
const P = 'text-[11px] leading-relaxed text-fg-muted';
const SMALL_BTN = 'rounded-sharp border border-rule px-2 py-1 text-[11px] text-fg-soft hover:bg-bg-sunken disabled:opacity-40';
const INPUT = 'min-w-0 flex-1 rounded-sharp border border-rule bg-bg px-2 py-1 text-[11.5px] text-fg';
const ON = { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' } as const;

export function NotionSettingsBox({ mono, open }: { mono: boolean; open: boolean }) {
  const api = useMemo(plannerApi, []);
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [cfg, setCfg] = useState<NotionSettings>(DEFAULT_NOTION);
  const [found, setFound] = useState<NotionSource[] | null>(null);
  const [key, setKey] = useState('');
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 이름을 고치는 중인 DB — 홈에는 여기서 정한 이름이 보인다(Notion의 DB 이름은 그대로) */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const s = await api.notionStatus().catch(() => null);
      const store = await api.plannerGet();
      if (!alive) return;
      setStatus(s);
      if (store.ok) setCfg(store.state.settings.notion ?? DEFAULT_NOTION);
    })();
    return () => {
      alive = false;
    };
  }, [api, open]);

  const save = useCallback(
    async (base: NotionSettings, patch: Partial<NotionSettings>): Promise<NotionSettings> => {
      const r = await api.plannerApply({ type: 'settings', patch: { notion: { ...base, ...patch } } });
      const next = r.ok ? (r.state.settings.notion ?? DEFAULT_NOTION) : base;
      setCfg(next);
      return next;
    },
    [api],
  );

  /** 홈이 바로 다시 읽게 알린다 — 키는 저장소 밖에 있어 설정 변화로는 알 수 없다 */
  const changed = () => window.dispatchEvent(new Event(NOTION_CHANGED));

  /** 이 연결이 볼 수 있는 DB를 찾는다 — 연결 확인을 겸한다 */
  const find = async (base: NotionSettings) => {
    setBusy(true);
    const r = await api.notionSources();
    setBusy(false);
    if (!r.ok) return setMsg(r.message);
    setFound(r.sources);
    setMsg(r.sources.length ? `DB ${r.sources.length}개를 찾았습니다.` : '볼 수 있는 DB가 없습니다 — Notion에서 보고 싶은 페이지의 ⋯ → 연결에 이 연결을 더하세요.');
    if (base.sources.length === 0 && r.sources.length > 0) {
      // 처음이면 전부 고른다. 이름에 '회의'가 든 DB가 하나뿐이면 회의록 DB로 삼는다
      const meet = r.sources.filter((s) => /회의|meeting/i.test(s.name));
      await save(base, { sources: r.sources, meetings: meet.length === 1 ? meet[0].id : base.meetings });
    } else {
      // 이미 고른 DB의 이름·주소가 Notion에서 바뀌었으면 맞춘다
      const byId = new Map(r.sources.map((s) => [s.id, s]));
      // 주소는 Notion 것으로 맞추되, 이름은 여기서 정한 것을 지킨다(SR·DL처럼 줄여 둔 이름)
      const next = base.sources.map((s) => {
        const fresh = byId.get(s.id);
        return fresh ? { ...fresh, name: s.name } : s;
      });
      if (JSON.stringify(next) !== JSON.stringify(base.sources)) await save(base, { sources: next });
    }
  };

  const saveKey = async () => {
    setMsg(null);
    const r = await api.notionSetKey(key);
    if (!r.ok) return setMsg(r.error);
    setKey('');
    setStatus(await api.notionStatus());
    await find(cfg);
    changed();
  };

  const clearKey = async () => {
    await api.notionClearKey();
    setStatus(await api.notionStatus());
    setFound(null);
    setMsg('키를 지웠습니다. 골라 둔 DB 목록은 남아 있습니다.');
    changed();
  };

  const add = async () => {
    setMsg(null);
    setBusy(true);
    const r = await api.notionResolve(addr);
    setBusy(false);
    if (!r.ok) return setMsg(r.message);
    setAddr('');
    const have = new Set(cfg.sources.map((s) => s.id));
    await save(cfg, { sources: [...cfg.sources, ...r.sources.filter((s) => !have.has(s.id))] });
    setMsg(`더했습니다 — ${r.sources.map((s) => s.name).join(', ')}`);
  };

  /** 홈에 보일 이름을 바꾼다 — 비우면 그대로 둔다 */
  const rename = async () => {
    if (!renaming) return;
    const name = renaming.name.replace(/\s+/g, ' ').trim();
    const id = renaming.id;
    setRenaming(null);
    if (!name) return;
    setFound((f) => f?.map((x) => (x.id === id ? { ...x, name } : x)) ?? f);
    if (cfg.sources.some((x) => x.id === id)) await save(cfg, { sources: cfg.sources.map((x) => (x.id === id ? { ...x, name } : x)) });
  };

  const toggle = (s: NotionSource, on: boolean) => {
    // 끈 DB도 목록에는 남긴다 — 다시 켤 수 있게
    setFound((f) => (f?.some((x) => x.id === s.id) ? f : [...(f ?? []), s]));
    const sources = on ? [...cfg.sources.filter((x) => x.id !== s.id), s] : cfg.sources.filter((x) => x.id !== s.id);
    void save(cfg, { sources, meetings: !on && cfg.meetings === s.id ? '' : cfg.meetings });
  };

  // 찾은 DB + 이미 고른 DB (찾기 전에도 고른 것은 보인다)
  const list = useMemo(() => {
    const byId = new Map<string, NotionSource>();
    for (const s of [...cfg.sources, ...(found ?? [])]) byId.set(s.id, s);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [cfg.sources, found]);
  const chosen = new Set(cfg.sources.map((s) => s.id));

  return (
    <section className={BOX} data-testid="notion-settings">
      <h3 className={H3}>{mono ? '$ notion' : 'Notion'}</h3>
      {!status ? (
        <p className={P}>확인 중…</p>
      ) : status.connected ? (
        <p className={P}>
          <b className="text-fg">연결됨</b> — 고른 DB에서 어느 날에 무엇을 썼는지 홈의 띠(날 칸)와 그날 미리보기에 보여 주고, 회의록 DB의 페이지를 본인 달력의 일정 줄에 잇습니다. 읽기만 하고 Notion에는 아무것도 쓰지 않습니다.
        </p>
      ) : (
        <>
          <p className={P}>
            <b className="text-fg">연결되지 않음</b> — 연결하면 어느 날에 어떤 Notion 페이지를 썼는지와 회의록 링크가 홈에 나옵니다.
          </p>
          <ol className={`${P} mt-2 list-decimal space-y-1 pl-4`}>
            <li>Notion의 연결(통합) 관리 화면에서 내부 연결을 하나 만듭니다. 권한은 “콘텐츠 읽기”만 켭니다.</li>
            <li>보고 싶은 가장 위 페이지(팀 페이지 등)의 ⋯ → 연결에서 그 연결을 더합니다. 아래 페이지와 DB가 함께 열립니다.</li>
            <li>연결의 키(ntn_…)를 아래에 붙여 넣고 [저장]을 누릅니다. 키는 이 PC에 암호화해 두고 화면에 다시 보여 주지 않습니다.</li>
          </ol>
        </>
      )}

      {status && !status.stored && (
        <div className="mt-2 flex items-center gap-1">
          <input
            type="password"
            className={INPUT}
            value={key}
            placeholder="Notion 연결 키 (ntn_…)"
            aria-label="Notion 연결 키"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey()}
          />
          <button type="button" className={SMALL_BTN} disabled={!key.trim() || !status.encryption} onClick={() => void saveKey()}>
            저장
          </button>
        </div>
      )}
      {status && !status.encryption && <p className={`${P} mt-1`}>이 PC에서는 키를 암호화해 저장할 수 없습니다.</p>}

      {status?.connected && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button type="button" className={SMALL_BTN} disabled={busy} onClick={() => void find(cfg)}>
              {busy ? '찾는 중…' : 'DB 찾기 (연결 확인)'}
            </button>
            {status.stored && (
              <button type="button" className={SMALL_BTN} onClick={() => void clearKey()}>
                키 지우기
              </button>
            )}
          </div>

          {list.length > 0 && (
            <div className="mt-2">
              <p className={`${P} mb-1`}>홈에 보일 DB — 회의록 DB를 하나 고르면 그 페이지를 일정 줄에 잇습니다. [이름]으로 홈에 보일 이름을 짧게 바꿀 수 있습니다(예: SR · DL · 회의).</p>
              {list.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-0.5 text-[11.5px] text-fg-soft">
                  {renaming?.id === s.id ? (
                    <input
                      type="text"
                      className={INPUT}
                      value={renaming.name}
                      aria-label={`${s.name} — 홈에 보일 이름`}
                      autoFocus
                      maxLength={40}
                      onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                      onBlur={() => void rename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename();
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="checkbox" checked={chosen.has(s.id)} onChange={(e) => toggle(s, e.target.checked)} style={{ accentColor: 'var(--fg)' }} />
                      <span className="min-w-0 truncate">{s.name}</span>
                    </label>
                  )}
                  {chosen.has(s.id) && renaming?.id !== s.id && (
                    <button type="button" className={SMALL_BTN} title="홈에 보일 이름을 바꿉니다 — Notion의 DB 이름은 그대로입니다" onClick={() => setRenaming({ id: s.id, name: s.name })}>
                      이름
                    </button>
                  )}
                  {chosen.has(s.id) && (
                    <button
                      type="button"
                      className={SMALL_BTN}
                      aria-pressed={cfg.meetings === s.id}
                      title="이 DB의 페이지를 회의록으로 보고, 만든 시각이 맞는 본인 일정에 잇습니다"
                      style={cfg.meetings === s.id ? ON : undefined}
                      onClick={() => void save(cfg, { meetings: cfg.meetings === s.id ? '' : s.id })}
                    >
                      회의록
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center gap-1">
            <input type="text" className={INPUT} value={addr} placeholder="목록에 없는 DB — 주소를 붙여 넣기" aria-label="더할 Notion DB 주소" onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addr.trim() && void add()} />
            <button type="button" className={SMALL_BTN} disabled={!addr.trim() || busy} onClick={() => void add()}>
              더하기
            </button>
          </div>

          <label className="mt-2 flex items-center gap-1 text-[11.5px] text-fg-soft">
            <input type="checkbox" checked={cfg.loose} onChange={(e) => void save(cfg, { loose: e.target.checked })} style={{ accentColor: 'var(--fg)' }} />
            DB에 들어 있지 않은 페이지도 보기
          </label>
          <p className={`${P} mt-2`}>지난 주 월요일부터 오늘까지를 5분마다 다시 읽습니다. 페이지는 만든 날과 마지막으로 고친 날에 나옵니다(여러 날에 걸쳐 고쳤으면 마지막 날에만). DB 밖의 페이지는 Notion 검색으로 찾아 몇 분 늦을 수 있습니다.</p>
        </>
      )}
      {msg && (
        <p className={`${P} mt-2`} role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
