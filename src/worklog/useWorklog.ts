/**
 * 작업일지 상태 — 열린 파일 하나 + 목록·전체 본문(검색·자동완성).
 *
 * 저장 규칙
 * - 편집을 멈추고 1.5초 뒤 저장한다(Ctrl+S는 바로). 저장은 "마지막으로 읽은 본문(base)"이 디스크와 같을 때만 된다.
 * - 디스크가 base + 꼬리면(작업일지 루틴의 덧붙이기) 꼬리를 편집 중인 내용 끝에 합쳐 다시 저장한다.
 * - 그 밖의 변경(메모장에서 고침 등)은 충돌로 멈추고 사람이 고른다. 저장하지 못한 내용은 앱 저장소에 보관한다.
 * - 3초마다(창이 보일 때) 디스크를 확인해, 루틴이 덧붙인 내용을 편집 중에도 바로 합친다.
 * - 저장 전 내용은 쓰기를 멈춘 0.4초 뒤 앱 저장소에도 남긴다(파일별). 충돌로 자동 저장이 멈춘 사이나
 *   자동 저장을 기다리는 사이에 창을 닫아도, 그 파일을 다시 열면 되살릴 수 있다.
 * - 토스트의 [되돌리기] 같은 늦게 눌리는 동작은 그 파일이 열려 있을 때만 본문을 바꾼다
 *   (다른 파일을 연 뒤 누르면 옛 파일 내용이 지금 파일에 들어가 그대로 자동 저장된다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UNDO_MS } from '../lib/undo';
import { toast } from 'sonner';
import type { WorklogConfig, WorklogEntry, WorklogFileRef, WorklogFileText } from '../../electron/worklog-types';
import { isoToday } from './format';
import { countCases, reconcile, type ExternalChange } from './merge';
import { mergeCaseBlocks, setTitleLine, type WlFix } from './lint';
import { collectVocabulary } from './search';
import { safeRemoveItem, safeSetItem } from '../lib/storage';

const LAST_KEY = 'tb:worklog:last:v1';
const DRAFT_KEY = 'tb:worklog:unsaved:v1';
const AUTOSAVE_MS = 1500;
const POLL_MS = 3000;
const DRAFT_MS = 400;
/** 보관하는 파일 수 — 가장 최근 것부터 */
const DRAFT_KEEP = 8;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

interface Fmt {
  bom: boolean;
  crlf: boolean;
  legacyEncoding: boolean;
}

interface Draft extends WorklogFileRef {
  text: string;
  base: string;
  at: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function sameRef(a: WorklogFileRef | null | undefined, b: WorklogFileRef | null | undefined): boolean {
  return !!a && !!b && a.folder === b.folder && a.name === b.name;
}

/** 보관본 목록 — 파일마다 하나. 예전 저장본(보관본 하나짜리 객체)도 읽는다 */
function readDrafts(): Draft[] {
  const raw = readJson<Draft | Draft[]>(DRAFT_KEY);
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter(
    (d) => !!d && typeof d.name === 'string' && typeof d.folder === 'string' && typeof d.text === 'string' && typeof d.base === 'string',
  );
}

function writeDrafts(list: Draft[]): boolean {
  if (list.length === 0) {
    safeRemoveItem(DRAFT_KEY);
    return true;
  }
  return safeSetItem(DRAFT_KEY, JSON.stringify(list));
}

export interface UseWorklogOptions {
  /** 처음에 열 파일 — 홈에서 "이 사안 열기"로 넘어온 경우. 없으면 오늘 일지 → 마지막에 본 일지 순 */
  initial?: WorklogFileRef | null;
}

export function useWorklog(opts: UseWorklogOptions = {}) {
  const api = typeof window !== 'undefined' ? window.reportApi : undefined;
  const [config, setConfig] = useState<WorklogConfig | null>(null);
  const [files, setFiles] = useState<WorklogEntry[]>([]);
  const [corpus, setCorpus] = useState<WorklogFileText[]>([]);
  const [current, setCurrent] = useState<WorklogEntry | null>(null);
  const [text, setTextState] = useState('');
  const [base, setBase] = useState('');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState<{ disk: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const textRef = useRef(text);
  const baseRef = useRef(base);
  const currentRef = useRef<WorklogEntry | null>(null);
  const fmtRef = useRef<Fmt>({ bom: false, crlf: false, legacyEncoding: false });
  const knownRef = useRef<{ mtimeMs: number; size: number } | null>(null);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  textRef.current = text;
  baseRef.current = base;
  currentRef.current = current;
  conflictRef.current = !!conflict;
  /** 아래에서 만드는 save — 그보다 위에 있는 동작(폴더 바꾸기)이 호출 시점에 쓴다 */
  const saveRef = useRef<((force?: boolean) => Promise<boolean>) | null>(null);

  const dirty = !!current && text !== base;

  const setText = useCallback((next: string) => {
    textRef.current = next;
    setTextState(next);
  }, []);

  /**
   * 그 파일이 지금 열려 있을 때만 본문을 바꾼다 — 토스트 액션처럼 몇 초 뒤에 눌리는 동작용.
   * 다른 파일을 연 뒤라면 바꾸지 않고 알린다(바꾸면 옛 파일 내용이 지금 파일에 들어가 자동 저장된다).
   */
  const setTextFor = useCallback(
    (ref: WorklogFileRef, next: string, elseSay = '그 사이 다른 일지를 열어 적용하지 않았습니다.'): boolean => {
      if (!sameRef(currentRef.current, ref)) {
        toast.info(elseSay);
        return false;
      }
      setText(next);
      return true;
    },
    [setText],
  );

  const adoptBase = useCallback((next: string, meta?: { mtimeMs: number; size: number }) => {
    baseRef.current = next;
    setBase(next);
    if (meta) knownRef.current = meta;
  }, []);

  // ── 목록·설정 ──────────────────────────────────────────────
  const refreshList = useCallback(async () => {
    if (!api?.worklogList) return [] as WorklogEntry[];
    const r = await api.worklogList();
    if (!r.ok) {
      setError(r.error);
      return [] as WorklogEntry[];
    }
    setFiles(r.files);
    return r.files;
  }, [api]);

  const refreshCorpus = useCallback(async () => {
    if (!api?.worklogReadAll) return;
    const r = await api.worklogReadAll();
    if (r.ok) setCorpus(r.files);
  }, [api]);

  const loadConfig = useCallback(async () => {
    if (!api?.worklogConfig) return null;
    const c = await api.worklogConfig();
    setConfig(c);
    return c;
  }, [api]);

  const pickRoot = useCallback(async () => {
    if (!api?.worklogPickRoot) return;
    // 폴더를 바꾸면 열린 일지가 닫힌다 — 저장 전 내용은 먼저 저장하고, 안 되면 앱에 보관한다
    const prev = currentRef.current;
    if (prev && textRef.current !== baseRef.current && !(await saveRef.current?.())) storeDraft(prev, textRef.current, baseRef.current);
    const c = await api.worklogPickRoot();
    setConfig(c);
    setCurrent(null);
    setText('');
    adoptBase('');
    await refreshList();
    await refreshCorpus();
    // storeDraft는 아래에서 만든다(안정된 함수) — 여기서는 호출 시점에만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refreshList, refreshCorpus, setText, adoptBase]);

  // ── 저장 ──────────────────────────────────────────────────
  /** 저장 전 내용을 앱 저장소에 남긴다 — 파일마다 하나(다른 파일의 보관본을 덮지 않는다). 남기지 못하면 false */
  const storeDraft = useCallback((cur: WorklogFileRef, t: string, b: string): boolean => {
    const mine: Draft = { folder: cur.folder, name: cur.name, text: t, base: b, at: Date.now() };
    return writeDrafts([mine, ...readDrafts().filter((d) => !sameRef(d, cur))].slice(0, DRAFT_KEEP));
  }, []);

  /**
   * 보관본 지우기. 조건을 주면 맞는 것만 지운다.
   * - before: 그 시각 전에 남긴 것만 — 저장이 끝났을 때, 저장을 시작한 뒤에 더 쓴 내용의 보관본은 남긴다
   * - base: 그 본문에서 출발한 것만 — 디스크 내용을 받기 전에 남긴 "내 내용"은 남긴다
   */
  const clearDraft = useCallback((cur: WorklogFileRef, only: { before?: number; base?: string } = {}) => {
    const all = readDrafts();
    const rest = all.filter(
      (d) => !(sameRef(d, cur) && (only.before === undefined || d.at < only.before) && (only.base === undefined || d.base === only.base)),
    );
    if (rest.length !== all.length) writeDrafts(rest);
  }, []);

  const updateCorpus = useCallback((cur: WorklogEntry, t: string) => {
    setCorpus((c) => {
      const i = c.findIndex((f) => sameRef(f, cur));
      const entry: WorklogFileText = { ...cur, text: t };
      if (i < 0) return [entry, ...c];
      const next = [...c];
      next[i] = entry;
      return next;
    });
  }, []);

  /** 디스크 변경 처리 — 덧붙이기는 합치고, 모르는 변경은 충돌로 멈춘다 */
  const applyExternal = useCallback(
    (change: ExternalChange, meta: { mtimeMs: number; size: number }, disk: string) => {
      const cur = currentRef.current;
      if (!cur) return;
      switch (change.kind) {
        case 'none':
          knownRef.current = meta;
          return;
        case 'reload':
          adoptBase(disk, meta);
          if (change.text !== textRef.current) {
            setText(change.text);
            toast.info('다른 곳에서 바뀐 작업일지 내용을 불러왔습니다.');
          }
          updateCorpus(cur, disk);
          return;
        case 'appended': {
          adoptBase(disk, meta);
          setText(change.text);
          const n = countCases(change.tail);
          toast.success(n > 0 ? `작업일지 루틴이 덧붙인 ■ ${n}개를 편집 중인 내용 끝에 합쳤습니다.` : '파일 끝에 덧붙은 내용을 합쳤습니다.', {
            duration: 8000,
          });
          return;
        }
        case 'conflict':
          knownRef.current = meta;
          setConflict({ disk: change.disk });
          setStatus('conflict');
          storeDraft(cur, textRef.current, baseRef.current);
          return;
      }
    },
    [adoptBase, setText, updateCorpus, storeDraft],
  );

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      const cur = currentRef.current;
      if (!cur || !api?.worklogSave) return false;
      if (savingRef.current) return false;
      if (conflictRef.current && !force) return false;
      const t = textRef.current;
      const b = baseRef.current;
      if (!force && t === b) return true;
      const startedAt = Date.now();
      savingRef.current = true;
      setStatus('saving');
      const r = await api.worklogSave({ folder: cur.folder, name: cur.name, text: t, base: b, bom: fmtRef.current.bom, crlf: fmtRef.current.crlf, force });
      savingRef.current = false;
      if (!sameRef(currentRef.current, cur)) return r.ok;
      if (r.ok) {
        adoptBase(t, { mtimeMs: r.mtimeMs, size: r.size });
        setConflict(null);
        setStatus('saved');
        setSavedAt(Date.now());
        setError(null);
        // 이 저장보다 먼저 남긴 보관본만 지운다 — 저장하는 사이 더 쓰고 남긴 보관본까지 지우면 그 내용을 잃는다
        clearDraft(cur, { before: startedAt });
        updateCorpus(cur, t);
        if (force) toast.success(r.backup ? '덮어썼습니다 — 이전 내용은 백업해 두었습니다.' : '덮어썼습니다.');
        return true;
      }
      if (r.code === 'changed') {
        setStatus('idle'); // 합친 뒤 자동 저장이 다시 잡히게 ('saving'에 멈추지 않게) — 충돌이면 아래에서 'conflict'
        applyExternal(reconcile(b, textRef.current, r.disk), { mtimeMs: r.mtimeMs, size: r.size }, r.disk);
        return false;
      }
      setStatus('error');
      setError(r.error);
      storeDraft(cur, t, b);
      toast.error(`작업일지를 저장하지 못했습니다: ${r.error}`);
      return false;
    },
    [api, adoptBase, applyExternal, clearDraft, storeDraft, updateCorpus],
  );

  saveRef.current = save;

  // 편집을 멈추면 저장 (충돌 중에는 멈춤). 저장 중에 더 쓴 내용은 저장이 끝나 상태가 바뀔 때 다시 잡힌다
  useEffect(() => {
    if (!dirty || conflict || status === 'saving') return;
    const id = window.setTimeout(() => void save(), AUTOSAVE_MS);
    return () => window.clearTimeout(id);
  }, [text, dirty, conflict, status, save]);

  // 저장하지 못한 채 끄는 일이 없게 — 창 닫기 전 확인
  useEffect(() => {
    api?.setDirty?.(dirty);
  }, [api, dirty]);

  // 저장 전 내용은 앱 저장소에도 남긴다 — 충돌로 자동 저장이 멈춘 사이, 자동 저장을 기다리는 사이에 창을 닫아도 잃지 않게.
  // 고친 것을 손으로 되돌려 디스크와 같아졌으면 그 보관본은 지운다(다시 열 때 되살아나지 않게).
  useEffect(() => {
    const cur = currentRef.current;
    if (!cur) return;
    if (!dirty) {
      clearDraft(cur, { base: baseRef.current });
      return;
    }
    const id = window.setTimeout(() => storeDraft(cur, textRef.current, baseRef.current), DRAFT_MS);
    return () => window.clearTimeout(id);
  }, [text, base, dirty, clearDraft, storeDraft]);

  // 창이 닫히는 순간 — 마지막 0.4초 안에 쓴 내용까지 남긴다 (닫히는 창에서는 파일 저장을 기다릴 수 없다)
  useEffect(() => {
    const onUnload = () => {
      const cur = currentRef.current;
      if (cur && textRef.current !== baseRef.current) storeDraft(cur, textRef.current, baseRef.current);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [storeDraft]);

  // ── 바깥 변경 감시 ────────────────────────────────────────
  const checkDisk = useCallback(async () => {
    const cur = currentRef.current;
    if (!cur || !api?.worklogStat || savingRef.current) return;
    const st = await api.worklogStat(cur);
    if (!st.ok || !sameRef(currentRef.current, cur)) return;
    const k = knownRef.current;
    if (k && k.mtimeMs === st.mtimeMs && k.size === st.size) return;
    const r = await api.worklogRead(cur);
    if (!r.ok || !sameRef(currentRef.current, cur) || savingRef.current) return;
    if (conflictRef.current) {
      knownRef.current = { mtimeMs: r.mtimeMs, size: r.size };
      setConflict({ disk: r.text });
      return;
    }
    applyExternal(reconcile(baseRef.current, textRef.current, r.text), { mtimeMs: r.mtimeMs, size: r.size }, r.text);
  }, [api, applyExternal]);

  useEffect(() => {
    if (!current) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void checkDisk();
    };
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [current, checkDisk]);

  // ── 열기·만들기 ───────────────────────────────────────────
  const open = useCallback(
    async (entry: WorklogEntry, opts: { quiet?: boolean } = {}) => {
      if (!api?.worklogRead) return false;
      const prev = currentRef.current;
      // 이미 열려 있는 파일 — 다시 읽지 않는다. 다시 읽으면 아직 저장되지 않은 편집이 디스크 내용으로 덮인다
      // (Ctrl+N 오늘 일지, 목록·검색 결과에서 같은 파일 누르기). 바깥 변경은 3초마다의 디스크 확인이 가져온다
      if (prev && sameRef(prev, entry)) return true;
      if (prev && textRef.current !== baseRef.current) {
        const ok = await save();
        if (!ok) {
          if (!storeDraft(prev, textRef.current, baseRef.current)) {
            // 저장도 보관도 못 했다 — 파일을 바꾸면 그 내용이 사라지므로 바꾸지 않는다
            toast.error(`${prev.name}을 저장하지도, 앱에 보관하지도 못해(앱 저장 공간 부족) 다른 일지를 열지 않았습니다 — 내용을 복사해 두세요.`, { duration: 15000 });
            return false;
          }
          toast.info(`${prev.name}의 저장하지 못한 내용은 앱에 보관했습니다 — 다시 열면 되살릴 수 있습니다.`);
        }
      }
      const r = await api.worklogRead(entry);
      if (!r.ok) {
        if (!opts.quiet) toast.error(`열지 못했습니다: ${r.error}`);
        return false;
      }
      fmtRef.current = { bom: r.bom, crlf: r.crlf, legacyEncoding: r.legacyEncoding };
      knownRef.current = { mtimeMs: r.mtimeMs, size: r.size };
      currentRef.current = entry;
      setCurrent(entry);
      adoptBase(r.text);
      setConflict(null);
      setStatus('idle');
      setSavedAt(null);
      safeSetItem(LAST_KEY, JSON.stringify({ folder: entry.folder, name: entry.name }));
      const draft = readDrafts().find((d) => sameRef(d, entry));
      if (draft && draft.text !== r.text) {
        if (draft.base === r.text) {
          // 디스크는 그대로고 앱에만 남은 내용 — 그대로 되살려 저장한다
          setText(draft.text);
          toast.info('저장하지 못했던 내용을 되살렸습니다.', {
            duration: 10000,
            action: { label: '버리기', onClick: () => void (setTextFor(entry, r.text) && clearDraft(entry)) },
          });
        } else {
          setText(r.text);
          toast.warning('앱에 보관한 저장 전 내용이 있지만, 그 사이 파일도 바뀌었습니다.', {
            duration: 15000,
            action: { label: '보관본 열기', onClick: () => void setTextFor(entry, draft.text, `그 사이 다른 일지를 열었습니다 — ${entry.name}을 다시 열면 보관본을 볼 수 있습니다.`) },
          });
        }
      } else {
        setText(r.text);
        if (draft) clearDraft(entry);
      }
      if (r.legacyEncoding) toast.info('이 파일은 EUC-KR이라 저장하면 UTF-8로 바뀝니다.');
      return true;
    },
    [api, adoptBase, save, setText, setTextFor, storeDraft, clearDraft],
  );

  const todayFiles = useCallback((list: WorklogEntry[] = files) => list.filter((f) => f.date === isoToday()), [files]);

  const create = useCallback(
    async (folder: string, date: string, title: string): Promise<boolean> => {
      if (!api?.worklogCreate) return false;
      const r = await api.worklogCreate({ folder, date, title, text: `[${date}] ${title.trim()}\n\n` });
      const list = await refreshList();
      if (!r.ok && r.code === 'exists') {
        const hit = list.find((f) => f.folder === folder && f.name === r.name);
        if (hit) await open(hit);
        toast.info('그날 일지가 이미 있어 그 파일을 열었습니다 — 같은 날 파일이 둘이면 작업일지 루틴이 그날을 건너뜁니다.');
        return true;
      }
      if (!r.ok) {
        toast.error(`만들지 못했습니다: ${r.error}`);
        return false;
      }
      const hit = list.find((f) => f.folder === folder && f.name === r.name);
      if (hit) await open(hit);
      toast.success(`${folder || '작업일지 폴더'}에 ${r.name}을 만들었습니다.`);
      return true;
    },
    [api, refreshList, open],
  );

  const renameTo = useCallback(
    async (title: string) => {
      const cur = currentRef.current;
      if (!cur || !api?.worklogRename) return;
      if (textRef.current !== baseRef.current) await save();
      const r = await api.worklogRename({ folder: cur.folder, name: cur.name, title });
      if (!r.ok) {
        toast.error(`파일명을 바꾸지 못했습니다: ${r.error}`);
        return;
      }
      const list = await refreshList();
      const hit = list.find((f) => f.folder === cur.folder && f.name === r.name);
      if (hit) {
        currentRef.current = hit;
        setCurrent(hit);
        safeSetItem(LAST_KEY, JSON.stringify({ folder: hit.folder, name: hit.name }));
        setCorpus((c) => c.map((f) => (sameRef(f, cur) ? { ...f, name: hit.name, title: hit.title } : f)));
      }
      toast.success(`파일명을 바꿨습니다: ${r.name}`);
    },
    [api, refreshList, save],
  );

  const applyFix = useCallback(
    (fix: WlFix) => {
      if (fix.kind === 'rename-file') {
        void renameTo(fix.title);
        return;
      }
      const cur = currentRef.current;
      const prev = textRef.current;
      const next = fix.kind === 'set-title-line' ? setTitleLine(prev, fix.line) : mergeCaseBlocks(prev, fix.keep, fix.drop);
      if (!cur || next === prev) return;
      setText(next);
      toast.success(fix.kind === 'merge-case' ? '같은 사안 ■을 하나로 합쳤습니다.' : '1행 제목을 바꿨습니다.', {
        duration: UNDO_MS,
        action: { label: '되돌리기', onClick: () => void setTextFor(cur, prev, '그 사이 다른 일지를 열어 되돌리지 않았습니다.') },
      });
    },
    [renameTo, setText, setTextFor],
  );

  /** 충돌 — 디스크 내용을 받는다 (내 내용은 되돌리기로 되살릴 수 있다) */
  const takeDisk = useCallback(() => {
    const c = conflict;
    const cur = currentRef.current;
    if (!c || !cur) return;
    const mine = textRef.current;
    storeDraft(cur, mine, baseRef.current);
    adoptBase(c.disk);
    setText(c.disk);
    setConflict(null);
    setStatus('idle');
    updateCorpus(cur, c.disk);
    toast.info('파일 내용을 불러왔습니다.', {
      duration: 10000,
      action: {
        label: '내 내용 되살리기',
        onClick: () => void setTextFor(cur, mine, `그 사이 다른 일지를 열었습니다 — ${cur.name}을 다시 열면 보관한 내 내용을 볼 수 있습니다.`),
      },
    });
  }, [conflict, adoptBase, setText, setTextFor, storeDraft, updateCorpus]);

  /** 충돌 — 내 내용으로 덮어쓴다 (백업 후) */
  const keepMine = useCallback(() => void save(true), [save]);

  // ── 처음 ──────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      const c = await loadConfig();
      if (!alive || !c?.root) return;
      const list = await refreshList();
      if (!alive) return;
      const last = readJson<WorklogFileRef>(LAST_KEY);
      const today = list.filter((f) => f.date === isoToday());
      const wanted = opts.initial ? list.find((f) => sameRef(f, opts.initial)) : undefined;
      const target = wanted ?? today[0] ?? list.find((f) => sameRef(f, last)) ?? list[0];
      if (target) await open(target, { quiet: true });
      if (alive) void refreshCorpus();
    })();
    return () => {
      alive = false;
    };
    // 처음 한 번
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 다른 문서 종류로 넘어갈 때 — 마지막 편집을 저장(실패하면 보관)
  useEffect(
    () => () => {
      const cur = currentRef.current;
      if (cur && textRef.current !== baseRef.current) {
        storeDraft(cur, textRef.current, baseRef.current);
        void save();
      }
      window.reportApi?.setDirty?.(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const vocab = useMemo(() => collectVocabulary(corpus), [corpus]);

  return {
    config,
    files,
    corpus,
    vocab,
    current,
    text,
    setText,
    setTextFor,
    dirty,
    status,
    savedAt,
    conflict,
    error,
    legacyEncoding: fmtRef.current.legacyEncoding,
    pickRoot,
    refreshList,
    refreshCorpus,
    open,
    create,
    save,
    todayFiles,
    renameTo,
    applyFix,
    takeDisk,
    keepMine,
  };
}

export type WorklogState = ReturnType<typeof useWorklog>;
