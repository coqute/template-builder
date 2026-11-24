import type { DocTypeModule } from './registry';
import { homeModule } from './home';
import { weeklyModule } from './weekly';
import { emailModule } from './email';
import { worklogModule } from './worklog';

/**
 * 등록된 화면 — 맨 앞은 홈, 그 뒤가 문서 종류. 새 타입 추가 = 모듈 구현 후 이 배열에 1줄.
 * (공개 사본 규칙이 배열 끝 항목을 걷어 내므로 새 모듈은 끝이 아니라 그 앞에 넣는다)
 */
export const DOC_TYPE_MODULES: readonly DocTypeModule[] = [homeModule, weeklyModule, emailModule, worklogModule];

export function getDocTypeModule(id: string): DocTypeModule {
  return DOC_TYPE_MODULES.find((m) => m.id === id) ?? DOC_TYPE_MODULES[0];
}

export type { DocTypeModule, DocTypeWorkspaceProps } from './registry';
