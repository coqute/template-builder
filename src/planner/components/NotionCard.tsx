/**
 * 홈의 Notion 구역 — 고른 DB에서 최근에 바뀐 페이지를 DB별로 보여 주고 Notion으로 잇는다 (설계 §19.10).
 * 읽기만 한다. 키가 없으면 아무것도 그리지 않는다(연결은 도움말·설정 F1의 Notion 칸에서).
 */
import { useState } from 'react';
import { clock, md } from '../dates';
import type { NotionGroup } from '../sources/notion';
import type { NotionSettings } from '../types';
import type { NotionView } from '../usePlanner';
import { NotionMark } from './HomeParts';

/** DB마다 먼저 보이는 줄 수 — 넘치면 "외 n건"으로 접는다(지원 기록처럼 하루에도 여러 건 생기는 DB가 있다) */
const SHOWN = 3;

interface Props {
  view: NotionView;
  groups: NotionGroup[];
  settings: NotionSettings;
  onOpen(url: string, what: string): void;
  onRetry(): void;
  onHelp(): void;
}

export function NotionCard({ view, groups, settings, onOpen, onRetry, onHelp }: Props) {
  const [more, setMore] = useState<Set<string>>(new Set());
  if (!view.status?.connected) return null;
  const total = groups.reduce((n, g) => n + g.pages.length, 0);
  const toggle = (key: string) =>
    setMore((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="hm-nt" aria-label="Notion" data-testid="home-notion">
      <div className="hm-h">
        <h2>
          <NotionMark size={14} /> Notion
        </h2>
        <small>
          최근 {settings.days}일에 바뀐 것{total > 0 ? ` ${total}` : ''}
        </small>
        {view.readAt && <span className="hm-r hm-num">{clock(view.readAt)} 확인</span>}
      </div>
      {settings.sources.length === 0 ? (
        <p className="hm-note">
          볼 DB를 아직 고르지 않았습니다.{' '}
          <button type="button" className="hm-mini" onClick={onHelp}>
            DB 고르기 (F1 설정)
          </button>
        </p>
      ) : (
        <>
          {view.error && (
            <p className="hm-note" role="status">
              Notion을 읽지 못했습니다 — {view.error}{' '}
              <button type="button" className="hm-mini" onClick={onRetry}>
                다시 읽기
              </button>
            </p>
          )}
          {!view.error && view.failed.length > 0 && (
            <p className="hm-note" role="status">
              읽지 못한 DB {view.failed.length}개 — Notion에서 그 DB에 이 연결을 더했는지 확인하세요.
            </p>
          )}
          {groups.length === 0 && !view.error && <p className="hm-note">{view.readAt ? `최근 ${settings.days}일 동안 바뀐 페이지가 없습니다.` : 'Notion을 읽는 중입니다.'}</p>}
          {groups.map((g) => {
            const key = g.source?.id ?? '';
            const open = more.has(key);
            const rows = open ? g.pages : g.pages.slice(0, SHOWN);
            const name = g.source?.name ?? 'DB 밖의 페이지';
            return (
              <div className="hm-ng" key={key}>
                <div className="hm-cap">
                  {g.source?.url ? (
                    <button type="button" className="hm-org" title="Notion에서 이 DB를 엽니다" onClick={() => onOpen(g.source!.url, 'Notion에서 이 DB를')}>
                      {name} ↗
                    </button>
                  ) : (
                    <span>{name}</span>
                  )}
                  <i className="hm-num">{g.pages.length}</i>
                </div>
                {rows.map((p) => (
                  <button key={p.id} type="button" className="hm-np" aria-label={`Notion에서 열기 — ${p.title}`} title={p.title} onClick={() => onOpen(p.url, 'Notion에서 이 페이지를')}>
                    <span className="hm-num">{md(p.date)}</span>
                    <b>{p.title}</b>
                    {p.fresh && <span className="hm-chip">새</span>}
                  </button>
                ))}
                {g.pages.length > SHOWN && (
                  <button type="button" className="hm-mini hm-np-m" aria-expanded={open} onClick={() => toggle(key)}>
                    {open ? '접기' : `외 ${g.pages.length - SHOWN}건`}
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
