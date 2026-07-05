import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { setTemplateOverlays, validateTemplateData } from './templates';
import type { EmailTemplateData } from './types';

/** 팀 공유폴더 경로 (선택) — 폴더 안의 templates/*.json을 팀 오버레이로 로드 */
export const TEAM_FOLDER_KEY = 'tb:team-folder:v1';

export function loadTeamFolder(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(TEAM_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveTeamFolder(dir: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (dir.trim()) localStorage.setItem(TEAM_FOLDER_KEY, dir.trim());
    else localStorage.removeItem(TEAM_FOLDER_KEY);
  } catch {
    // ignore
  }
}

function validateBatch(
  files: Array<{ name: string; raw: unknown }>,
  errors: string[],
): EmailTemplateData[] {
  const out: EmailTemplateData[] = [];
  for (const f of files) {
    const v = validateTemplateData(f.raw);
    if (v.ok) out.push(v.data);
    else errors.push(`${f.name}: ${v.error}`);
  }
  return out;
}

/**
 * 앱 기동 시 개인(userData)/팀(공유폴더) 템플릿 오버레이를 로드해 templates 모듈에 주입.
 * 반환값은 버전 카운터 — 렌더 의존성으로 사용 (로드 완료 시 증가).
 */
export function useTemplateOverlays(): { version: number; reload: () => void } {
  const [version, setVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.reportApi;
    if (!api?.loadTemplates) return; // 웹 모드 — 내장 템플릿만
    let cancelled = false;
    void api.loadTemplates(loadTeamFolder() || undefined).then((res) => {
      if (cancelled) return;
      const errors = [...res.errors];
      const team = validateBatch(res.team, errors);
      const personal = validateBatch(res.personal, errors);
      setTemplateOverlays(team, personal);
      setVersion((v) => v + 1);
      if (errors.length > 0) {
        toast.warning(
          `템플릿 파일 ${errors.length}개를 건너뛰었습니다 — ${errors[0]}${errors.length > 1 ? ' 외' : ''}`,
        );
      }
      if (team.length + personal.length > 0) {
        toast.success(`사용자 템플릿 ${team.length + personal.length}개를 불러왔습니다.`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { version, reload: () => setReloadKey((k) => k + 1) };
}
