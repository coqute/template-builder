import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errText } from '../lib/err';
import { UNDO_MS } from '../lib/undo';
import { toast } from 'sonner';
import {
  importFromInput,
  parseTolerant,
  renderCombined,
  serialize,
  type WeekReport,
} from '@core/index';
import { useGmailDraft } from './useGmailDraft';
import { loadWeeklyRecipients } from '../lib/weeklyRecipients';
import { josa } from '../lib/josa';
import { useDebounced } from './useDebounced';
import { useReportState, type ReportState } from './useReportState';
import { copyHtmlToClipboard, readClipboard } from './useClipboard';
import { buildWeeklyTemplate } from './useTemplate';
import { readWithFallback, safeRemoveItem, safeSetItem } from '../lib/storage';
import {
  fileBaseName as baseName,
  loadRecentFiles,
  pushRecentFile,
  removeRecentFile,
} from '../lib/recentFiles';
import { loadUserProfile } from '../email/profile';

const STORAGE_KEY_MD = 'tb:md-draft:v1';
const STORAGE_KEY_FILE = 'tb:md-file-path:v1';
const LEGACY_KEY_MD = 'weekly-report-builder:md-draft:v1';

/** 샘플 파일을 읽지 못할 때의 내장 예시 (주간보고 형식 v2) */
export function buildFallbackMd(authorName: string): string {
  return `@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-10
@AUTHOR ${authorName || '작성자'}
@PLAN 2026-05-06 10:00 MX(주간미팅)

# 2026-04-27(월)
@LOC MX(누리사옥)
@CUS MX
@SUM [MX] (누리사옥) (홍길동) 수집서버 패치 작업
1) 수집서버 프로세스 패치
2) Store 서버 이중화
  > 재기동 후 데이터 수집 정상 확인

@LOC 파트너사
@CUS 제트플러스
@SUM [제트플러스] (담당A/메일) 에이전트 이름 변경이 목록에 반영되지 않음
  -> 서버 이름을 바꿔도 목록에 반영이 안 됨
  <- 에이전트 로그 공유 요청
  -> 로그 전달
  *<- 제조사 문의 예정

# 2026-04-28(화)
# 2026-04-29(수)
# 2026-04-30(목)
# 2026-05-01(금)
@HOLIDAY 근로자의 날

# 2026-05-02(토)
@HOLIDAY

# 2026-05-03(일)
@HOLIDAY
`;
}

/** 합본에 추가한 이전 주 보고서 */
export interface CombineEntry {
  filePath: string;
  report: WeekReport;
}

/** 복사·임시보관함에 실제로 쓰이는 출력 — 합본이 있으면 최근 주부터 이어 붙인 결과 */
export interface WeeklyOutput {
  html: string;
  plain: string;
  subject: string;
  weeks: number;
}

export interface WeeklyState {
  md: string;
  setMd: (next: string) => void;
  /** 문서 세대 — 문서를 통째로 바꿀 때마다 오른다. 늦게 눌리는 토스트 액션이 같은 문서에만 적용되게 비교한다 */
  docGen: () => number;
  state: ReportState;
  filePath: string | null;
  dirty: boolean;
  recentFiles: string[];
  loadSample: () => Promise<void>;
  /** 새 주간보고 — 지난 주 월~일의 빈 골격 */
  loadTemplate: () => Promise<void>;
  importGmail: () => Promise<void>;
  /** 바깥에서 만든 .md로 문서 교체 (작업일지 가져오기) — 되돌리기 토스트 */
  replaceWith: (md: string, message: string) => void;
  openFile: () => Promise<void>;
  openRecentFile: (path: string) => Promise<void>;
  saveFile: () => Promise<void>;
  copyHtml: () => Promise<void>;
  /** 합본 — 이전 주 .md들 (현재 문서가 최근 주) */
  extras: CombineEntry[];
  addCombineFiles: () => Promise<void>;
  removeExtra: (filePath: string) => void;
  clearExtras: () => void;
  output?: WeeklyOutput;
  /** Gmail 임시보관함 초안 (받는사람·참조는 도움말에서 설정) */
  createDraft: () => Promise<void>;
  draftBusy: boolean;
}

/** 주간보고서 문서 상태 컨테이너 — 파일 연결(Ctrl+S 덮어쓰기)·최근 파일·dirty 추적 포함 */
export function useWeeklyState(author: string): WeeklyState {
  const [md, setMd] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return buildFallbackMd('');
    return readWithFallback(STORAGE_KEY_MD, LEGACY_KEY_MD) ?? buildFallbackMd(loadUserProfile().name);
  });
  // 현재 편집 중인 .md의 디스크 경로 (열기/다른이름저장으로 확정 → Ctrl+S 덮어쓰기 대상)
  const [filePath, setFilePath] = useState<string | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY_FILE) || null;
  });
  // 마지막으로 디스크에 저장한 내용 (수정 여부 ● 표시용)
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // 최근 파일 MRU (최대 5) — 열기/저장 성공 시 갱신, 열기 실패 시 제거
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  // toast 액션 등 늦게 실행되는 콜백이 항상 최신 md를 쓰도록
  const mdRef = useRef(md);
  mdRef.current = md;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  /**
   * 문서 세대 — 문서를 통째로 바꿀 때(열기·새 주간보고·가져오기·되돌리기)마다 올린다.
   * 토스트의 [되돌리기]·[덮어쓰기]는 몇 초 뒤에 눌릴 수 있다. 그 사이 다른 문서를 열었으면
   * 옛 문서의 내용을 지금 문서에 덮어쓰게 되므로, 만들 때의 세대와 누를 때의 세대가 같을 때만 실행한다.
   */
  const docGenRef = useRef(0);
  const docGen = useCallback(() => docGenRef.current, []);
  const warnedQuotaRef = useRef(false);

  const debouncedMd = useDebounced(md, 200);
  const state = useReportState(debouncedMd);
  const [extras, setExtras] = useState<CombineEntry[]>([]);
  const draft = useGmailDraft();

  const output = useMemo<WeeklyOutput | undefined>(() => {
    if (!state.rendered) return undefined;
    if (extras.length === 0 || !state.report) {
      return { html: state.rendered.html, plain: state.rendered.plain, subject: state.subject ?? '', weeks: 1 };
    }
    return renderCombined([state.report, ...extras.map((e) => e.report)]);
  }, [state.rendered, state.report, state.subject, extras]);

  // 초안 자동 보존 — 이메일 본문의 큰 이미지가 quota를 채운 경우 예외를 삼키고 1회만 경고
  // (effect 안에서 던지면 ErrorBoundary가 없어 앱 전체가 흰 화면이 된다)
  useEffect(() => {
    if (safeSetItem(STORAGE_KEY_MD, md)) {
      warnedQuotaRef.current = false;
      return;
    }
    if (!warnedQuotaRef.current) {
      warnedQuotaRef.current = true;
      toast.warning('초안 자동 보존 용량 초과 — .md로 저장해 두세요. (편집·복사는 정상, 이메일 본문의 큰 이미지가 원인일 수 있음)');
    }
  }, [md]);

  useEffect(() => {
    if (filePath) safeSetItem(STORAGE_KEY_FILE, filePath);
    else safeRemoveItem(STORAGE_KEY_FILE);
  }, [filePath]);

  const dirty = filePath != null && savedSnapshot != null && md !== savedSnapshot;

  // main 프로세스에 dirty 통지 — 창 닫기 전 확인 다이얼로그용.
  // 모듈 언마운트(모드 전환) 시 해제 — 초안은 localStorage에 보존되므로 닫기 차단 대상 아님
  useEffect(() => {
    window.reportApi?.setDirty?.(dirty);
  }, [dirty]);
  useEffect(() => () => window.reportApi?.setDirty?.(false), []);

  // (재)마운트 시 filePath만 복원되고 savedSnapshot이 없으면 디스크 내용을 snapshot으로 —
  // dirty(●)/종료확인이 재시작·모드 전환 후에도 정확. 파일 소실 시 연결 해제.
  // 디스크 내용이 앱 초안과 다르면(앱을 닫은 사이 외부 편집 가능성) 알리고 파일 내용으로 교체할 기회를 준다 —
  // 어느 쪽이 최신인지 판단할 수 없으므로 조용히 초안으로 덮어쓰지 않는다.
  useEffect(() => {
    const api = window.reportApi;
    if (!filePath || savedSnapshot !== null || !api?.readPath) return;
    let cancelled = false;
    const draft = md;
    const target = filePath;
    const gen = docGenRef.current;
    void api.readPath(target).then((r) => {
      // 읽는 사이 다른 문서를 열었으면 이 결과는 그 문서의 것이 아니다
      if (cancelled || docGenRef.current !== gen) return;
      if (!r.ok) {
        setFilePath(null);
        return;
      }
      setSavedSnapshot(r.content);
      if (r.content !== draft) {
        toast.warning(
          `${baseName(target)}: 파일 내용이 앱 초안과 다릅니다 (외부에서 수정됐을 수 있음). 저장 전 확인하세요.`,
          {
            duration: 12000,
            action: {
              label: '파일 내용 불러오기',
              onClick: () => {
                if (docGenRef.current !== gen) {
                  toast.info('그 사이 다른 문서를 열어 불러오지 않았습니다.');
                  return;
                }
                setMd(r.content);
              },
            },
          },
        );
      }
    });
    return () => {
      cancelled = true;
    };
    // mount 1회 — filePath/savedSnapshot은 복원 직후 값만 대상
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 새 콘텐츠 로드 시 기존 파일 연결 해제 → 다음 Ctrl+S는 "다른 이름으로 저장"
  const detachFile = useCallback(() => {
    setFilePath(null);
    setSavedSnapshot(null);
    setExtras([]); // 합본은 현재 문서 기준 — 문서가 바뀌면 해제
  }, []);

  /**
   * 현재 문서를 다른 내용으로 교체 — 초안은 localStorage 한 벌뿐이라 교체 즉시 사라지므로
   * 토스트의 [되돌리기]로 직전 내용·파일 연결·합본을 복원할 수 있게 한다.
   */
  const replaceDoc = useCallback(
    (next: string, message: string, level: 'success' | 'warning' = 'success') => {
      const prev = { md: mdRef.current, filePath, savedSnapshot, extras };
      detachFile();
      setMd(next);
      const gen = ++docGenRef.current;
      const undoable = prev.md.trim() !== '' && prev.md !== next;
      const opts = undoable
        ? {
            duration: UNDO_MS,
            action: {
              label: '되돌리기',
              onClick: () => {
                if (docGenRef.current !== gen) {
                  toast.info('그 사이 다른 문서를 열어 되돌리지 않았습니다.');
                  return;
                }
                docGenRef.current++;
                setMd(prev.md);
                setFilePath(prev.filePath);
                setSavedSnapshot(prev.savedSnapshot);
                setExtras(prev.extras);
              },
            },
          }
        : undefined;
      if (level === 'warning') toast.warning(message, opts);
      else toast.success(message, opts);
    },
    [detachFile, filePath, savedSnapshot, extras],
  );

  const loadSample = useCallback(async () => {
    const sample = window.reportApi?.loadSample ? await window.reportApi.loadSample() : null;
    replaceDoc(sample || buildFallbackMd(author), '샘플을 불러왔습니다.');
  }, [replaceDoc, author]);

  const loadTemplate = useCallback(async () => {
    const { md: tpl, prevStart, prevEnd } = buildWeeklyTemplate({ authorName: author });
    replaceDoc(tpl, `새 주간보고 — 지난 주 ${prevStart} ~ ${prevEnd} (토·일 휴일)`);
  }, [author, replaceDoc]);

  const importGmail = useCallback(async () => {
    try {
      const { html, plain } = await readClipboard();
      if (!html && !plain) {
        toast.error('클립보드가 비어 있습니다. Gmail 본문을 먼저 복사하세요.');
        return;
      }
      const { report, warnings } = importFromInput({ html, plain, defaultAuthor: author });
      const generated = serialize(report);
      if (warnings.length > 0) {
        replaceDoc(generated, `가져왔습니다 (경고 ${warnings.length}건). 검증 결과를 확인하세요.`, 'warning');
      } else {
        replaceDoc(generated, 'Gmail 본문을 .md로 변환했습니다.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'import 실패');
    }
  }, [replaceDoc, author]);

  const openFile = useCallback(async () => {
    if (!window.reportApi?.openMd) {
      toast.error('파일 열기는 데스크톱 앱에서만 됩니다.');
      return;
    }
    try {
      const result = await window.reportApi.openMd();
      if (result.canceled) {
        if (result.error) toast.error(result.error);
        return;
      }
      docGenRef.current++;
      setMd(result.content);
      setFilePath(result.filePath);
      setSavedSnapshot(result.content);
      setExtras([]);
      setRecentFiles(pushRecentFile(result.filePath));
      toast.success(`불러옴: ${baseName(result.filePath)}`);
    } catch (err) {
      toast.error(`파일을 열지 못했습니다: ${errText(err)}`);
    }
  }, []);

  // 최근 파일 — 다이얼로그 없이 직접 열기. 실패(삭제/이동) 시 목록에서 제거
  const openRecentFile = useCallback(async (path: string) => {
    const api = window.reportApi;
    if (!api?.readPath) {
      toast.error('파일 열기는 데스크톱 앱에서만 됩니다.');
      return;
    }
    try {
      const result = await api.readPath(path);
      if (!result.ok) {
        setRecentFiles(removeRecentFile(path));
        toast.error(`파일을 열 수 없어 목록에서 제거했습니다: ${baseName(path)}`);
        return;
      }
      docGenRef.current++;
      setMd(result.content);
      setFilePath(path);
      setSavedSnapshot(result.content);
      setExtras([]);
      setRecentFiles(pushRecentFile(path));
      toast.success(`불러옴: ${baseName(path)}`);
    } catch (err) {
      toast.error(`파일을 열지 못했습니다: ${errText(err)}`);
    }
  }, []);

  /** 확정 경로에 현재 md 덮어쓰기. 실패 시 파일 연결을 쌍으로 해제(다음 Ctrl+S는 다른 이름으로 저장) */
  const overwrite = useCallback(
    async (target: string): Promise<boolean> => {
      const api = window.reportApi;
      if (!api?.saveToPath) return false;
      const content = mdRef.current;
      const result = await api.saveToPath(target, content);
      if (result.ok) {
        setSavedSnapshot(content);
        setRecentFiles(pushRecentFile(result.filePath));
        toast.success(`저장됨: ${baseName(result.filePath)}`);
        return true;
      }
      toast.error(`기존 경로에 저장하지 못했습니다 — 위치를 다시 지정하세요. (${result.error})`);
      // filePath만 지우면 savedSnapshot이 남아 dirty 판정이 영구 false — 쌍으로 해제
      detachFile();
      return false;
    },
    [detachFile],
  );

  const saveFile = useCallback(async () => {
    const api = window.reportApi;
    if (!api?.save) {
      toast.error('파일 저장은 데스크톱 앱에서만 됩니다.');
      return;
    }
    try {
      // 기존 파일이 확정돼 있으면 다이얼로그 없이 그 경로에 덮어쓰기
      if (filePath) {
        // 저장 직전 디스크 대조 — 앱이 열려 있는 동안 외부(VS Code 등)에서 수정된 파일을 경고 없이 덮어쓰지 않도록
        if (savedSnapshot !== null) {
          const cur = await api.readPath(filePath);
          if (cur.ok && cur.content !== savedSnapshot && cur.content !== md) {
            const target = filePath;
            const gen = docGenRef.current;
            toast.warning(`${josa(baseName(target), '이/가')} 외부에서 변경되었습니다. 현재 내용으로 덮어쓸까요?`, {
              duration: 15000,
              action: {
                label: '덮어쓰기',
                onClick: () => {
                  // 그 사이 새 문서·다른 파일로 바꿨으면 그 내용을 이 경로에 쓰게 된다 — 같은 문서일 때만 덮어쓴다
                  if (docGenRef.current !== gen || filePathRef.current !== target) {
                    toast.info(`그 사이 다른 문서를 열어 ${baseName(target)}에는 덮어쓰지 않았습니다.`);
                    return;
                  }
                  void overwrite(target);
                },
              },
            });
            return;
          }
        }
        if (await overwrite(filePath)) return;
        // 경로가 사라졌거나 쓰기 실패 → 연결 해제됨. 아래 "다른 이름으로 저장"으로 폴백
      }
      // 신규/경로 미확정 — 다른 이름으로 저장 다이얼로그
      const defaultName = state.subject
        ? state.subject.replace(/[\\/:*?"<>|]/g, '_')
        : 'weekly-report';
      const result = await api.save({ defaultName, content: md, kind: 'md' });
      if (result.canceled) {
        if (result.error) toast.error(result.error);
        return;
      }
      setFilePath(result.filePath);
      setSavedSnapshot(md);
      setRecentFiles(pushRecentFile(result.filePath));
      toast.success(`저장됨: ${baseName(result.filePath)}`);
    } catch (err) {
      toast.error(`저장 중 오류: ${errText(err)}`);
    }
  }, [md, state.subject, filePath, savedSnapshot, overwrite]);

  const copyHtml = useCallback(async () => {
    if (!output) {
      toast.error('렌더링할 내용이 없습니다.');
      return;
    }
    try {
      await copyHtmlToClipboard({ html: output.html, plain: output.plain });
      toast.success(
        output.weeks > 1
          ? `${output.weeks}주 합본 HTML 복사 완료 — 제목: ${output.subject}`
          : 'HTML 복사 완료 — Gmail/Outlook 본문에 Ctrl+V 하세요.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '복사 실패');
    }
  }, [output]);

  /** 합본 추가 — 이전 주 .md 여러 개 선택. 문법 오류·현재 문서와 같은 주는 건너뛴다 */
  const addCombineFiles = useCallback(async () => {
    const api = window.reportApi;
    if (!api?.openMdMulti) {
      toast.error('합본 파일 선택은 데스크톱 앱에서만 됩니다.');
      return;
    }
    try {
      const res = await api.openMdMulti();
      if (res.canceled) {
        if (res.error) toast.error(res.error);
        return;
      }
      const skipped = [...res.errors];
      const added: CombineEntry[] = [];
      const currentStart = state.report?.prevWeekRange.start;
      for (const f of res.files) {
        const { report, diagnostics } = parseTolerant(f.content, { defaultAuthor: author });
        if (diagnostics.some((d) => d.severity === 'error')) {
          skipped.push(`${baseName(f.filePath)}: 문법 오류`);
        } else if (report.prevWeekRange.start === currentStart) {
          skipped.push(`${baseName(f.filePath)}: 현재 문서와 같은 주`);
        } else {
          added.push({ filePath: f.filePath, report });
        }
      }
      setExtras((prev) => {
        const byWeek = new Map(prev.map((e) => [e.report.prevWeekRange.start, e] as const));
        for (const e of added) byWeek.set(e.report.prevWeekRange.start, e); // 같은 주는 새로 고른 파일로 교체
        return [...byWeek.values()].sort((a, b) => b.report.prevWeekRange.start.localeCompare(a.report.prevWeekRange.start));
      });
      if (added.length > 0) toast.success(`합본에 ${added.length}주를 추가했습니다 — 미리보기에서 확인하세요.`);
      if (skipped.length > 0) toast.warning(`건너뜀 ${skipped.length}건 — ${skipped[0]}${skipped.length > 1 ? ' 외' : ''}`);
    } catch (err) {
      toast.error(`합본 파일을 열지 못했습니다: ${errText(err)}`);
    }
  }, [author, state.report]);

  const removeExtra = useCallback((path: string) => {
    setExtras((prev) => prev.filter((e) => e.filePath !== path));
  }, []);
  const clearExtras = useCallback(() => setExtras([]), []);

  const createDraftRef = useRef<(() => Promise<void>) | null>(null);
  const createDraft = useCallback(async () => {
    if (!output) {
      toast.error('렌더링할 내용이 없습니다.');
      return;
    }
    const { to, cc } = loadWeeklyRecipients();
    await draft.createDraft(
      { key: output.subject, to, cc, subject: output.subject, html: output.html, plain: output.plain },
      // [다시 시도]는 실패한 그때의 글이 아니라 지금 글로 다시 만든다(이메일과 같게 — v0.27.0)
      { note: to ? '' : ' (받는사람 미설정 — 설정(F1)에서 지정)', retry: () => void createDraftRef.current?.() },
    );
  }, [output, draft]);
  createDraftRef.current = createDraft;

  return {
    md,
    setMd,
    /** 문서 세대 — 늦게 눌리는 토스트 액션이 같은 문서에만 적용되게 비교한다 */
    docGen,
    state,
    filePath,
    dirty,
    recentFiles,
    loadSample,
    loadTemplate,
    importGmail,
    replaceWith: replaceDoc,
    openFile,
    openRecentFile,
    saveFile,
    copyHtml,
    extras,
    addCombineFiles,
    removeExtra,
    clearExtras,
    output,
    createDraft,
    draftBusy: draft.busy,
  };
}
