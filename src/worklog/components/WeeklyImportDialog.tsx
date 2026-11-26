import { useEffect, useMemo, useState } from 'react';
import { addDays } from '../../lib/dates';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { canonicalClient, parseTolerant, validate, type WeekReport } from '@core/index';
import type { WorklogConfig, WorklogFileText } from '../../../electron/worklog-types';
import { BTN_GHOST, BTN_SOLID, INPUT, Modal, SOLID_STYLE } from '../../components/Modal';
import { safeSetItem } from '../../lib/storage';
import { weekdayOf } from '../format';
import { buildWeeklyMd, defaultFolderMaps, learnFromReports, lastMonday, mondayOf, type FolderMap, type WeeklyLearn } from '../toWeekly';

interface Props {
  /** 지금 문서 — 보고 주와 @PLAN을 이어 받는다 */
  currentMd: string;
  author: string;
  company: string;
  /** 최근에 연 주간보고 파일 — 그 폴더의 지난 보고에서 @CUS를 배운다 */
  recentFiles: readonly string[];
  onApply: (md: string, message: string) => void;
  onClose: () => void;
}

const MAP_KEY = 'tb:worklog:weekly-map:v1';

function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}


function readMaps(): Record<string, Omit<FolderMap, 'folder'>> {
  try {
    return JSON.parse(localStorage.getItem(MAP_KEY) ?? '{}') as Record<string, Omit<FolderMap, 'folder'>>;
  } catch {
    return {};
  }
}

/** 작업일지 → 주간보고 — 한 주를 골라 일지로 주간보고 .md를 만든다(지금 문서는 되돌리기로 되살릴 수 있다) */
export function WeeklyImportDialog({ currentMd, author, company, recentFiles, onApply, onClose }: Props) {
  const api = window.reportApi;
  const current = useMemo(() => parseTolerant(currentMd).report, [currentMd]);
  // 지금 문서의 보고 주 — 그 주에 일지가 없으면(샘플·다른 주 문서) 지난주로
  const docMonday = /^\d{4}-\d{2}-\d{2}$/.test(current.prevWeekRange.start) ? mondayOf(current.prevWeekRange.start) : null;
  const [picked, setMonday] = useState<string | null>(null);
  const [config, setConfig] = useState<WorklogConfig | null>(null);
  const [files, setFiles] = useState<WorklogFileText[] | null>(null);
  const [learn, setLearn] = useState<WeeklyLearn | null>(null);
  const [maps, setMaps] = useState<FolderMap[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api?.worklogConfig) {
        setError('데스크톱 앱에서만 쓸 수 있습니다.');
        return;
      }
      const cfg = await api.worklogConfig();
      if (!alive) return;
      setConfig(cfg);
      if (!cfg.root) {
        setError('작업일지 폴더가 없습니다. 작업일지 탭에서 폴더를 먼저 고르세요.');
        return;
      }
      const [all, history] = await Promise.all([api.worklogReadAll(), api.worklogWeeklyHistory([...new Set(recentFiles.map(dirOf))])]);
      if (!alive) return;
      if (!all.ok) {
        setError(all.error);
        return;
      }
      setFiles(all.files);
      setMonday((m) => m ?? (docMonday && all.files.some((f) => f.date >= docMonday && f.date <= addDays(docMonday, 6)) ? docMonday : lastMonday()));
      const reports: WeekReport[] = history.map((h) => parseTolerant(h.text).report).filter((r) => r.days.length > 0);
      const l = learnFromReports(reports);
      setLearn(l);
      const saved = readMaps();
      // 저장해 둔 고객 토큰의 옛 표기(ABZ+)는 표준 표기(AB Z+)로 보여 준다 — 만들어지는 .md와 같게
      setMaps(
        defaultFolderMaps(cfg.folders.map((f) => f.name), l, company).map((m) => {
          const merged = { ...m, ...(saved[m.folder] ?? {}) };
          return { ...merged, client: canonicalClient(merged.client) };
        }),
      );
    })();
    return () => {
      alive = false;
    };
    // 처음 한 번 — 문서 주(docMonday)는 열 때의 값으로 충분하다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, recentFiles, company]);

  const monday = picked ?? lastMonday();
  const samePlans = current.prevWeekRange.start === monday ? currentMd.split('\n').filter((l) => /^@PLAN\s/.test(l)) : [];
  const result = useMemo(
    () => (files && learn ? buildWeeklyMd({ prevStart: monday, author, files, maps, learn, plans: samePlans }) : null),
    // samePlans는 currentMd·monday에서 나온다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, learn, maps, monday, author, currentMd],
  );
  const check = useMemo(() => {
    if (!result) return null;
    const parsed = parseTolerant(result.md);
    const v = validate(parsed.report);
    const all = [...parsed.diagnostics, ...v.issues.map((i) => ({ severity: i.severity }))];
    return { errors: all.filter((d) => d.severity === 'error').length, warnings: all.filter((d) => d.severity === 'warning').length };
  }, [result]);
  const perDay = useMemo(() => {
    const out: Array<{ date: string; n: number }> = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDays(monday, i);
      out.push({ date: iso, n: files?.filter((f) => f.date === iso).length ?? 0 });
    }
    return out;
  }, [files, monday]);

  const setMap = (folder: string, patch: Partial<FolderMap>) =>
    setMaps((ms) => {
      const next = ms.map((m) => (m.folder === folder ? { ...m, ...patch } : m));
      const saved = readMaps();
      for (const m of next) saved[m.folder] = { client: m.client, cus: m.cus, loc: m.loc };
      safeSetItem(MAP_KEY, JSON.stringify(saved));
      return next;
    });

  const replacing = current.days.some((d) => d.blocks.some((b) => b.items.some((it) => it.workType.trim())));
  return (
    <Modal
      title="작업일지에서 주간보고 만들기"
      subtitle="한 주의 작업일지로 주간보고 .md를 만듭니다. AI 없이 규칙으로 바로 바꾸고, 문장은 이후 [AI 정돈]으로 다듬을 수 있습니다."
      onClose={onClose}
      width={880}
      labelId="wl-weekly-title"
      footer={
        <>
          <span className="min-w-0 flex-1 text-[11px] text-fg-muted">
            {result
              ? `일지 ${result.stats.files}개 → 항목 ${result.stats.items}개 (작업한 날 ${result.stats.days}일${result.stats.merged ? `, 같은 사안 ${result.stats.merged}건 합침` : ''})${check ? ` · 오류 ${check.errors} · 경고 ${check.warnings}` : ''}`
              : ''}
            {replacing ? ' · 지금 문서를 바꿉니다(되돌리기 가능)' : ''}
          </span>
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className={BTN_SOLID}
            style={SOLID_STYLE}
            disabled={!result || result.stats.files === 0}
            onClick={() => result && onApply(result.md, `작업일지 ${result.stats.files}개로 ${monday} 주 주간보고를 만들었습니다 — 항목 ${result.stats.items}개`)}
          >
            가져오기
          </button>
        </>
      }
    >
      {error ? (
        <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--stamp-red)' }}>
          <AlertTriangle size={13} /> {error}
        </p>
      ) : !result || !config ? (
        <p className="flex items-center gap-2 py-8 text-[12.5px] text-fg-muted">
          <Loader2 size={14} className="animate-spin" /> 작업일지와 지난 주간보고를 읽는 중…
        </p>
      ) : (
        <div className="space-y-3 text-[12.5px]">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block font-semibold text-fg">보고 주 (월요일)</span>
              <input type="date" value={monday} onChange={(e) => e.target.value && setMonday(mondayOf(e.target.value))} className={`${INPUT} w-[170px]`} />
            </label>
            <div className="flex gap-1" aria-label="일자별 일지 수">
              {perDay.map((d) => (
                <span key={d.date} className="rounded-sharp border border-rule px-1.5 py-0.5 text-[11px]" style={d.n ? undefined : { color: 'var(--fg-muted)' }} title={d.date}>
                  {d.date.slice(5)} {weekdayOf(d.date)} {d.n ? `· ${d.n}` : '–'}
                </span>
              ))}
            </div>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="pb-1 font-medium">작업일지 폴더</th>
                <th className="pb-1 font-medium">[고객사] 토큰</th>
                <th className="pb-1 font-medium">@CUS 기본값</th>
                <th className="pb-1 font-medium">@LOC</th>
              </tr>
            </thead>
            <tbody>
              {maps.map((m) => (
                <tr key={m.folder}>
                  <td className="pr-2 font-semibold text-fg">{m.folder || '(작업일지 폴더)'}</td>
                  <td className="pr-2 py-0.5">
                    <input value={m.client} onChange={(e) => setMap(m.folder, { client: e.target.value })} className={`${INPUT} py-1`} />
                  </td>
                  <td className="pr-2 py-0.5">
                    <input value={m.cus} onChange={(e) => setMap(m.folder, { cus: e.target.value })} className={`${INPUT} py-1`} />
                  </td>
                  <td className="py-0.5">
                    <input value={m.loc} onChange={(e) => setMap(m.folder, { loc: e.target.value })} className={`${INPUT} py-1`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-fg-muted">
            요청자별 @CUS는 지난 주간보고 {learn?.reports ?? 0}개에서 배웠습니다(요청자 {learn?.contactCus.size ?? 0}명). 처음 보는 요청자·요청자 없는 사안은 폴더 기본값을 씁니다.
          </p>
          <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap rounded-sharp border border-rule bg-bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed text-fg-soft">{result.md}</pre>
        </div>
      )}
    </Modal>
  );
}
