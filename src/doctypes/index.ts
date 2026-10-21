import type { DocTypeModule } from './registry';
import { weeklyModule } from './weekly';
import { emailModule } from './email';
import { worklogModule } from './worklog';

/** 등록된 문서 타입 — 새 타입 추가 = 모듈 구현 후 이 배열에 1줄 */
export const DOC_TYPE_MODULES: readonly DocTypeModule[] = [weeklyModule, emailModule, worklogModule];

export function getDocTypeModule(id: string): DocTypeModule {
  return DOC_TYPE_MODULES.find((m) => m.id === id) ?? DOC_TYPE_MODULES[0];
}

export type { DocTypeModule, DocTypeWorkspaceProps } from './registry';
