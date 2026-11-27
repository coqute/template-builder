/**
 * 할 일 → 오늘 일지 — 할 일의 메모를 그 사안의 이전 일지 블록·주고받은 메일과 대조해 오늘 일지에 덧붙일 블록으로 만든다.
 * 작업일지의 [대화 → 블록]과 같은 흐름이다: 재료(메모·이전 기록·메일)를 고르고 → 결과를 고친 뒤 → 오늘 일지 끝에 넣는다.
 *
 * 메일은 두 단계로 읽는다: 요청자 이름으로 **제목만** 조회해 보여 주고, 고른 스레드 하나만 본문을 읽는다.
 * 본문은 main이 거르는 도구(sanitizer)를 거친 것만 받는다. 목록의 제목은 이 화면에만 보이고 밖으로 나가지 않는다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AiError, AiNotes, AiRunFooter, aiResultLine, ctrlEnter, DESKTOP_ONLY } from '../../components/AiDialogParts';
import { BTN_GHOST, BTN_SOLID, INPUT, Modal, SOLID_STYLE } from '../../components/Modal';
import { loadAiModel, modelLabel } from '../../ai/settings';
import { planTaskLog, renderTaskLog, type TaskLogMail, type TaskLogResult } from '../../ai/taskLog';
import { useAiRun } from '../../ai/useAiRun';
import { caseKey, parseWorklog } from '../../worklog/format';
import { followupHead } from '../anchor';
import type { PlannerApi } from '../api';
import { addDays, md } from '../dates';
import { confidentPick, rankThreads, splitLikely, type MailHint, type RankedThread } from '../mailRank';
import type { MailStatus, MailThreadInfo, Task } from '../types';

interface Props {
  task: Task;
  today: string;
  api: PlannerApi;
  myName: string;
  /** 가릴 이름 — 다른 할 일·후보의 요청자 */
  knownNames: readonly string[];
  /** 블록을 오늘 일지 끝에 넣는다 — 넣었으면 true */
  onAppend(block: string): Promise<boolean>;
  /** "완료"만 바로 적는다 (전의 동작) — 끝낸 할 일일 때만 */
  onPlainDone?(): void;
  /** 고친 메모를 할 일에 남긴다 */
  onMemo(note: string): void;
  onClose(): void;
}

/** 이전 기록으로 보낼 블록 수·길이 — 최근 것부터 */
const CASE_MAX = 4;
const CASE_MAX_CHARS = 3000;
/** 메일을 찾기 시작하는 날 — 사안이 일지에 적힌 날보다 이만큼 앞부터 */
const MAIL_BEFORE_DAYS = 14;

interface CaseBlock {
  date: string;
  text: string;
}

/** 같은 사안(폴더 + 사안 키)의 일지 블록을 날짜순으로 — 그 사안이 처음 적힌 날부터 */
async function loadCases(api: PlannerApi, task: Task): Promise<CaseBlock[]> {
  if (task.origin.kind !== 'worklog') return [];
  const a = task.origin.anchor;
  const r = await api.worklogReadAll({ from: a.date });
  if (!r.ok) return [];
  const out: CaseBlock[] = [];
  for (const f of r.files.filter((x) => x.folder === a.folder).sort((x, y) => x.date.localeCompare(y.date))) {
    const lines = f.text.replace(/\r\n?/g, '\n').split('\n');
    for (const b of parseWorklog(f.text).blocks) {
      if (b.kind !== 'case' || caseKey(b) !== a.caseKey) continue;
      out.push({ date: f.date, text: lines.slice(b.startLine - 1, b.endLine).join('\n').slice(0, CASE_MAX_CHARS) });
    }
  }
  return out.slice(-CASE_MAX);
}

export function TaskLogDialog({ task, today, api, myName, knownNames, onAppend, onPlainDone, onMemo, onClose }: Props) {
  const anchor = task.origin.kind === 'worklog' ? task.origin.anchor : null;
  const [memo, setMemo] = useState(task.note);
  const [cases, setCases] = useState<CaseBlock[] | null>(null);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [who, setWho] = useState(task.who || (anchor?.source.split('/')[0].trim() ?? ''));
  const [words, setWords] = useState('');
  const [threads, setThreads] = useState<MailThreadInfo[] | null>(null);
  const [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [mailNote, setMailNote] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  /** 앱이 미리 골라 둔 스레드 — 사용자가 바꾸면 비운다 */
  const [autoPicked, setAutoPicked] = useState('');
  /** 가깝지 않은 나머지도 펼쳐 보는가 */
  const [showRest, setShowRest] = useState(false);
  /** 이 목록에 대해서는 고르기가 끝났다(앱이 골랐거나 사용자가 골랐다) — 같은 목록을 두 번 미리 고르지 않는다 */
  const decidedFor = useRef<MailThreadInfo[] | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<TaskLogResult | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ai = useAiRun();
  const busy = !!ai.busy || reading;
  const model = loadAiModel();
  const alive = useRef(true);
  // 개발 모드는 효과를 한 번 걷었다 다시 건다 — 다시 걸 때 살려 놓지 않으면 뒤에 오는 응답을 모두 버리게 된다
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const since = useMemo(() => addDays(anchor?.date ?? (task.createdAt.slice(0, 10) || today), -MAIL_BEFORE_DAYS), [anchor, task.createdAt, today]);

  const search = async (force = false) => {
    if (typeof api.mailSearch !== 'function' || !who.trim()) return;
    setSearching(true);
    setMailNote(null);
    const r = await api.mailSearch({ who: who.trim(), words: words.trim(), since, force });
    if (!alive.current) return;
    setSearching(false);
    if (!r.ok) {
      setThreads(null);
      setMailNote(r.message);
      return;
    }
    setThreads(r.threads);
    setMore(r.more);
    setShowRest(false);
    // 고른 것이 새 목록에 없으면 고르지 않은 것으로
    setPicked((cur) => (r.threads.some((t) => t.threadId === cur) ? cur : ''));
  };

  // 찾은 메일 가운데 이 사안과 가까운 것을 앞에 세운다 — 요청자·제목·사안이 적힌 날·고객사·내 회신 (mailRank.ts)
  const hint = useMemo(
    (): MailHint => ({
      titles: [task.title, anchor?.title ?? ''],
      notes: [memo, ...(cases ?? []).map((c) => c.text)],
      client: task.client,
      who: who.split(/\s*[,·;]\s*/).filter(Boolean),
      caseDates: [...new Set([...(anchor ? [anchor.date] : []), ...(cases ?? []).map((c) => c.date)])],
      today,
    }),
    [task.title, task.client, anchor, memo, cases, who, today],
  );
  const ranked = useMemo((): RankedThread[] | null => (threads ? rankThreads(threads, hint) : null), [threads, hint]);
  const { likely, rest } = useMemo(() => splitLikely(ranked ?? []), [ranked]);
  // 가까운 것이 하나도 없으면 접지 않고 다 보인다. 접어 둔 것을 골랐으면 그 줄은 접어도 남긴다
  const shown = likely.length === 0 || showRest ? [...likely, ...rest] : [...likely, ...rest.filter((t) => t.threadId === picked)];
  const narrowNote = !ranked?.length
    ? ''
    : likely.length === 0
      ? `찾은 ${ranked.length}건 가운데 이 사안과 뚜렷이 가까운 메일은 없습니다 — 최근 것부터 보입니다.`
      : rest.length > 0
        ? `찾은 ${ranked.length}건 가운데 이 사안과 가까운 ${likely.length}건을 먼저 보입니다.`
        : ranked.length === 1
          ? '찾은 1건이 이 사안과 가까워 보입니다.'
          : `찾은 ${ranked.length}건을 이 사안과 가까운 순서로 보입니다.`;

  // 하나가 뚜렷이 앞서면 미리 골라 둔다 — 목록을 받고 이전 기록까지 읽은 때에 한 번만 정한다.
  // 그 뒤에는 메모를 치는 동안 순서가 바뀌어도 고른 것을 건드리지 않는다(모르는 사이에 메일이 붙지 않게)
  useEffect(() => {
    if (!ranked || !threads || cases === null || decidedFor.current === threads) return;
    decidedFor.current = threads;
    if (picked) return;
    const best = confidentPick(ranked);
    if (!best) return;
    setPicked(best.threadId);
    setAutoPicked(best.threadId);
  }, [ranked, threads, cases, picked]);

  const pick = (id: string) => {
    decidedFor.current = threads;
    setAutoPicked('');
    setPicked(id);
  };

  // 열면 이전 기록을 읽고, 메일을 읽을 수 있으면 요청자 이름으로 제목만 한 번 조회한다(main이 5분 기억한다)
  useEffect(() => {
    void loadCases(api, task)
      .catch((): CaseBlock[] => []) // 일지를 읽지 못해도 창은 메모·메일만으로 이어 간다
      .then((c) => alive.current && setCases(c));
    if (typeof api.mailStatus !== 'function') {
      setStatus({ canRead: false });
      return;
    }
    void api.mailStatus().then((s) => {
      if (!alive.current) return;
      setStatus(s);
      if (s.canRead && who.trim()) void search();
    });
    // 창을 열 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const head = anchor ? followupHead(anchor, today) : picked && who.trim() ? `■ (${who.trim()}/메일) ${task.title}` : `■ ${task.title}`;

  const saveMemo = () => {
    if (memo.trim() !== task.note.trim()) onMemo(memo.trim());
  };

  const run = async () => {
    if (busy) return;
    if (!window.reportApi?.aiComplete) return void setError(DESKTOP_ONLY);
    setError(null);
    saveMemo();
    let mail: TaskLogMail | null = null;
    if (picked) {
      setReading(true);
      const r = await api.mailThread(picked);
      if (!alive.current) return;
      setReading(false);
      if (!r.ok) return void setError(`메일을 읽지 못했습니다: ${r.message} — "메일 없이"를 고르면 메모만으로 만듭니다.`);
      mail = { subject: r.subject, messages: r.messages, sanitized: r.sanitized };
    }
    const plan = planTaskLog({ today, title: task.title, done: !!task.doneAt, head, memo, cases: cases ?? [], mail, myName, knownNames: [...knownNames, who] }, model);
    if (!plan) return void setError('메모를 적거나 메일을 고르세요 — 대조할 글이 없습니다.');
    const res = await ai.call(plan.request, '정리하는 중');
    if (!res.ok) {
      if (res.code !== 'canceled') setError(res.message);
      return;
    }
    try {
      const r = renderTaskLog(plan, res);
      if (!r.text.trim()) return void setError('이번에 한 일을 찾지 못했습니다. 메모에 한 일을 한두 줄 적어 보세요.');
      setResult(r);
      setDraft(r.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const append = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    const ok = await onAppend(draft);
    if (alive.current) setSaving(false);
    if (ok) onClose();
  };

  const canRun = !!memo.trim() || !!picked;
  return (
    <Modal
      title="할 일 → 오늘 일지"
      subtitle={
        result
          ? aiResultLine(result, `▶ ${result.acts}줄`)
          : `메모를 이전 기록·메일과 대조해 오늘 일지에 덧붙일 블록으로 정리합니다 (${modelLabel(model)}). 메일은 거르는 도구를 거친 글만, 이름·URL은 가려서 보냅니다.`
      }
      onClose={() => {
        ai.cancel();
        saveMemo();
        onClose();
      }}
      width={860}
      labelId="hm-tasklog-title"
      footer={
        result ? (
          <>
            <button type="button" className={BTN_GHOST} onClick={() => setResult(null)}>
              재료 고치기
            </button>
            <span className="flex-1" />
            <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={!draft.trim() || saving} onClick={() => void append()}>
              {saving ? '넣는 중…' : '오늘 일지 끝에 넣기'}
            </button>
          </>
        ) : (
          <>
            {onPlainDone && (
              <button type="button" className={BTN_GHOST} disabled={busy} title="전과 같이 '처리 완료' 한 줄만 오늘 일지에 적습니다" onClick={onPlainDone}>
                완료만 기록
              </button>
            )}
            <AiRunFooter
              ai={ai}
              idle={reading ? '고른 메일을 읽는 중…' : '메모·메일에 없는 사실은 만들지 않습니다. 넣기 전에 결과를 고칠 수 있습니다.'}
              busyLabel="정리하는 중…"
              runLabel="블록 만들기"
              canRun={canRun && !reading}
              onRun={() => void run()}
              onClose={onClose}
            />
          </>
        )
      }
    >
      <AiError error={error} />
      {result ? (
        <div className="space-y-3">
          <AiNotes warnings={result.warnings} notes={result.questions} className="text-[12.5px]" />
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-fg">넣을 블록 — 여기서 고친 뒤 넣으세요</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(24, Math.max(8, draft.split('\n').length + 1))}
              className={`${INPUT} font-mono text-[12.5px] leading-relaxed`}
              spellCheck={false}
            />
          </label>
        </div>
      ) : (
        <div className="space-y-3 text-[12.5px]">
          <p className="truncate font-mono text-[12px] text-fg-soft" title={head}>
            {head}
          </p>
          <label className="block">
            <span className="mb-1 block font-semibold text-fg">메모 — 이번에 한 일을 짧게</span>
            <textarea
              autoFocus
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              onBlur={saveMemo}
              rows={4}
              className={`${INPUT} leading-relaxed`}
              placeholder={'제조사지원 회신 받아 원인 안내함. 2.9.5 패치 파일 전달, 적용은 고객이 다음 주에'}
              spellCheck={false}
              onKeyDown={ctrlEnter(canRun && !busy, () => void run())}
            />
          </label>

          <section aria-label="이전 기록">
            <h3 className="mb-1 font-semibold text-fg">이전 기록</h3>
            {!anchor ? (
              <p className="text-[11.5px] text-fg-muted">직접 만든 할 일이라 이어진 일지 사안이 없습니다 — 메모와 메일만으로 만듭니다.</p>
            ) : cases === null ? (
              <p className="text-[11.5px] text-fg-muted">일지에서 이 사안을 찾는 중…</p>
            ) : cases.length === 0 ? (
              <p className="text-[11.5px] text-fg-muted">일지에서 이 사안의 블록을 찾지 못했습니다(제목이 바뀌었을 수 있습니다).</p>
            ) : (
              <details className="rounded-sharp border border-rule px-2.5 py-1.5">
                <summary className="cursor-pointer text-fg-soft">
                  이 사안이 일지에 {cases.length}번 적혀 있습니다 ({cases.map((c) => md(c.date)).join(', ')}) — 이미 적힌 일은 되풀이하지 않습니다
                </summary>
                <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-fg-soft">
                  {cases.map((c) => `[${c.date}]\n${c.text}`).join('\n\n')}
                </pre>
              </details>
            )}
          </section>

          <section aria-label="메일">
            <h3 className="mb-1 font-semibold text-fg">메일 — 제목만 먼저 찾고, 고른 스레드만 읽습니다</h3>
            {status === null ? (
              <p className="text-[11.5px] text-fg-muted">메일을 읽을 수 있는지 확인하는 중…</p>
            ) : !status.canRead ? (
              <p className="text-[11.5px] text-fg-muted">메일은 쓰지 않고 메모와 이전 기록만으로 만듭니다{status.message ? ` — ${status.message}` : '.'}</p>
            ) : (
              <>
                <div className="flex items-end gap-2">
                  <label className="block w-44">
                    <span className="mb-0.5 block text-[11px] text-fg-muted">찾을 사람 (요청자 · 쉼표로 셋까지)</span>
                    <input value={who} onChange={(e) => setWho(e.target.value)} className={INPUT} placeholder="이름이나 주소" title="쉼표로 여럿을 적으면 그중 누구와든 주고받은 메일을 찾습니다 — 예: 요청자, 제조사 담당자" onKeyDown={(e) => e.key === 'Enter' && void search(true)} />
                  </label>
                  <label className="block min-w-0 flex-1">
                    <span className="mb-0.5 block text-[11px] text-fg-muted">함께 찾을 낱말 (선택)</span>
                    <input value={words} onChange={(e) => setWords(e.target.value)} className={INPUT} placeholder="제목·본문의 낱말" onKeyDown={(e) => e.key === 'Enter' && void search(true)} />
                  </label>
                  <button type="button" className={BTN_GHOST} disabled={searching || !who.trim()} onClick={() => void search(true)}>
                    {searching ? '찾는 중…' : '찾기'}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-fg-muted">
                  {md(since)} 이후에 그 사람과 주고받은 메일을 찾아, 제목·사안이 적힌 날·고객사로 가까운 것을 추립니다. 제목 목록은 이 화면에만 보이고, 고른 스레드만 거르는 도구를 거쳐 Claude로 갑니다.
                </p>
                {mailNote && (
                  <p className="mt-1 text-[11.5px]" style={{ color: 'var(--stamp-red)' }}>
                    {mailNote}
                  </p>
                )}
                {ranked && (
                  <>
                    {ranked.length > 0 && (
                      <p className="mt-1.5 text-[11.5px] text-fg-soft" data-testid="mail-narrow">
                        {narrowNote}
                        {autoPicked && picked === autoPicked ? ' 가장 가까운 메일을 골라 두었습니다 — 다르면 바꾸세요.' : ''}
                      </p>
                    )}
                    <div className="mt-1 max-h-60 overflow-auto rounded-sharp border border-rule" role="radiogroup" aria-label="메일 스레드">
                      <label className="flex cursor-pointer items-center gap-2 border-b border-rule px-2.5 py-1.5">
                        <input type="radio" name="hm-tasklog-mail" checked={picked === ''} onChange={() => pick('')} />
                        <span className="text-fg-soft">메일 없이 — 메모와 이전 기록만으로</span>
                      </label>
                      {ranked.length === 0 && <p className="px-2.5 py-2 text-[11.5px] text-fg-muted">찾은 메일이 없습니다 — 이름을 바꾸거나 낱말을 빼고 다시 찾아 보세요.</p>}
                      {shown.map((t) => (
                        <label key={t.threadId} className="flex cursor-pointer items-start gap-2 border-b border-rule px-2.5 py-1.5 last:border-b-0">
                          <input type="radio" name="hm-tasklog-mail" className="mt-1" checked={picked === t.threadId} onChange={() => pick(t.threadId)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-fg" title={t.subject}>
                              {t.subject}
                            </span>
                            <span className="block text-[11px] text-fg-muted">
                              {t.from} · {t.date ? md(t.date) : '날짜 없음'} · {t.count}통{t.mine ? ' · 내 회신 있음' : ''}
                            </span>
                            {t.why.length > 0 && <span className="block text-[11px] text-fg-soft">{t.why.join(' · ')}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                    {likely.length > 0 && rest.length > 0 && (
                      <button type="button" className="mt-1 text-[11px] text-fg-muted underline" onClick={() => setShowRest((v) => !v)}>
                        {showRest ? '가까운 메일만 보기' : `그 밖의 메일 ${rest.length}건 보기`}
                      </button>
                    )}
                  </>
                )}
                {threads && more && <p className="mt-1 text-[11px] text-fg-muted">최근 것부터 일부만 가져왔습니다 — 낱말을 더해 좁혀 보세요.</p>}
              </>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
