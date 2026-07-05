import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { importFromInput, serialize } from '@core/index';
import { useDebounced } from './useDebounced';
import { useReportState, type ReportState } from './useReportState';
import { copyHtmlToClipboard, readClipboard } from './useClipboard';
import { buildWeeklyTemplate } from './useTemplate';
import { readWithFallback } from '../lib/storage';
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

export function buildFallbackMd(authorName: string): string {
  return `@PREV 2026-04-27 ~ 2026-05-03
@CURRENT 2026-05-04 ~ 2026-05-08
@AUTHOR ${authorName || '작성자'}

# 2026-04-27(월)
@LOC 남산 데이터센터
@CUS 남산 IDC
@SUM [ABZ+] (이영희) 신규 수집 서버 설치 완료 후, 후속 작업 진행 (PoC)
1) 모니터링 에이전트 설치 방법 시연 및 안내
- Rocky 9, Ubuntu 22.04, Windows 각각 OS별 설치 가이드
2) 관리 콘솔 설치 진행
- 초기 설정 전, 서비스만 실행 중

# 2026-05-01(금)
@HOLIDAY 근로자의 날
`;
}

export interface WeeklyState {
  md: string;
  setMd: (next: string) => void;
  state: ReportState;
  filePath: string | null;
  dirty: boolean;
  recentFiles: string[];
  newDoc: () => void;
  loadSample: () => Promise<void>;
  loadTemplate: () => void;
  importGmail: () => Promise<void>;
  openFile: () => Promise<void>;
  openRecentFile: (path: string) => Promise<void>;
  saveFile: () => Promise<void>;
  copyHtml: () => Promise<void>;
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

  const debouncedMd = useDebounced(md, 200);
  const state = useReportState(debouncedMd);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_MD, md);
    }
  }, [md]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (filePath) localStorage.setItem(STORAGE_KEY_FILE, filePath);
    else localStorage.removeItem(STORAGE_KEY_FILE);
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
  useEffect(() => {
    const api = window.reportApi;
    if (!filePath || savedSnapshot !== null || !api?.readPath) return;
    let cancelled = false;
    void api.readPath(filePath).then((r) => {
      if (cancelled) return;
      if (r.ok) setSavedSnapshot(r.content);
      else setFilePath(null);
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
  }, []);

  const newDoc = useCallback(() => {
    detachFile();
    setMd('');
  }, [detachFile]);

  const loadSample = useCallback(async () => {
    detachFile();
    if (window.reportApi?.loadSample) {
      const sample = await window.reportApi.loadSample();
      if (sample) {
        setMd(sample);
        toast.success('샘플을 불러왔습니다.');
        return;
      }
    }
    setMd(buildFallbackMd(author));
    toast.success('내장 샘플을 불러왔습니다.');
  }, [detachFile, author]);

  const loadTemplate = useCallback(() => {
    detachFile();
    const { md: tpl, prevStart, prevEnd } = buildWeeklyTemplate({ authorName: author });
    setMd(tpl);
    toast.success(`지난 주 (${prevStart} ~ ${prevEnd}) 빈 템플릿을 생성했습니다.`);
  }, [author, detachFile]);

  const importGmail = useCallback(async () => {
    try {
      const { html, plain } = await readClipboard();
      if (!html && !plain) {
        toast.error('클립보드가 비어 있습니다. Gmail 본문을 먼저 복사하세요.');
        return;
      }
      const { report, warnings } = importFromInput({ html, plain, defaultAuthor: author });
      const generated = serialize(report);
      detachFile();
      setMd(generated);
      if (warnings.length > 0) {
        toast.warning(`가져왔습니다 (경고 ${warnings.length}건). 검증 결과를 확인하세요.`);
      } else {
        toast.success('Gmail 본문을 .md로 변환했습니다.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'import 실패');
    }
  }, [detachFile, author]);

  const openFile = useCallback(async () => {
    if (!window.reportApi?.openMd) {
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
      return;
    }
    const result = await window.reportApi.openMd();
    if (result.canceled) return;
    setMd(result.content);
    setFilePath(result.filePath);
    setSavedSnapshot(result.content);
    setRecentFiles(pushRecentFile(result.filePath));
    toast.success(`불러옴: ${baseName(result.filePath)}`);
  }, []);

  // 최근 파일 — 다이얼로그 없이 직접 열기. 실패(삭제/이동) 시 목록에서 제거
  const openRecentFile = useCallback(async (path: string) => {
    const api = window.reportApi;
    if (!api?.readPath) {
      toast.error('데스크탑 모드에서만 파일 열기를 지원합니다.');
      return;
    }
    const result = await api.readPath(path);
    if (!result.ok) {
      setRecentFiles(removeRecentFile(path));
      toast.error(`파일을 열 수 없어 목록에서 제거했습니다: ${baseName(path)}`);
      return;
    }
    setMd(result.content);
    setFilePath(path);
    setSavedSnapshot(result.content);
    setRecentFiles(pushRecentFile(path));
    toast.success(`불러옴: ${baseName(path)}`);
  }, []);

  const saveFile = useCallback(async () => {
    const api = window.reportApi;
    if (!api?.save) {
      toast.error('데스크탑 모드에서만 파일 저장을 지원합니다.');
      return;
    }
    // 기존 파일이 확정돼 있으면 다이얼로그 없이 그 경로에 덮어쓰기
    if (filePath && api.saveToPath) {
      const result = await api.saveToPath(filePath, md);
      if (result.ok) {
        setSavedSnapshot(md);
        setRecentFiles(pushRecentFile(result.filePath));
        toast.success(`저장됨: ${baseName(result.filePath)}`);
        return;
      }
      // 경로가 사라졌거나 쓰기 실패 → 무효화 후 아래 "다른 이름으로 저장"으로 폴백
      toast.error(`기존 경로에 저장하지 못했습니다 — 위치를 다시 지정하세요. (${result.error})`);
      setFilePath(null);
    }
    // 신규/경로 미확정 — 다른 이름으로 저장 다이얼로그
    const defaultName = state.subject
      ? state.subject.replace(/[\\/:*?"<>|]/g, '_')
      : 'weekly-report';
    const result = await api.save({ defaultName, content: md, kind: 'md' });
    if (!result.canceled) {
      setFilePath(result.filePath);
      setSavedSnapshot(md);
      setRecentFiles(pushRecentFile(result.filePath));
      toast.success(`저장됨: ${baseName(result.filePath)}`);
    }
  }, [md, state.subject, filePath]);

  const copyHtml = useCallback(async () => {
    if (!state.rendered) {
      toast.error('렌더링할 내용이 없습니다.');
      return;
    }
    try {
      await copyHtmlToClipboard({
        html: state.rendered.html,
        plain: state.rendered.plain,
      });
      toast.success('HTML 복사 완료 — Gmail/Outlook 본문에 Ctrl+V 하세요.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '복사 실패');
    }
  }, [state.rendered]);

  return {
    md,
    setMd,
    state,
    filePath,
    dirty,
    recentFiles,
    newDoc,
    loadSample,
    loadTemplate,
    importGmail,
    openFile,
    openRecentFile,
    saveFile,
    copyHtml,
  };
}
