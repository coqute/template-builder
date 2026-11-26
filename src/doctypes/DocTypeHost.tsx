import { createContext, useContext, useEffect, useRef, type MutableRefObject } from 'react';
import type { WorklogAnchor } from '../planner/types';

/**
 * DocType 모듈 ↔ 앱 셸 사이의 호스트 계약.
 * 모듈은 자신의 툴바 버튼을 slot에 포털로 렌더하고, 메뉴/단축키 핸들러를 등록한다.
 * App은 활성 모듈 하나만 마운트하므로 등록은 항상 단일이다.
 */

export interface DocTypeHandlers {
  /** menu:* 채널 핸들러 — 미등록 채널은 무시. (menu:help는 App 전역 처리) */
  menu: Record<string, (() => void) | undefined>;
  /** Ctrl(+Shift) 단축키 — combo 예: 's' · 'shift+c' · 'enter'. true 반환 시 preventDefault */
  shortcut?: (combo: string) => boolean;
}

/**
 * 다른 화면으로 넘어가며 "이것을 열어라"를 전한다 — 받는 모듈이 처리한 뒤 `clearIntent()`로 비운다.
 * (활성 모듈 하나만 마운트되므로 넘어간 뒤의 모듈이 받는다. 렌더 중에 꺼내 비우지 않는 것은
 *  개발 모드의 이중 렌더·이중 effect에서 두 번째 실행이 빈 값을 받지 않게 하려는 것이다)
 */
export type DocIntent =
  /** 작업일지 탭: 그 파일의 그 사안 */
  | { kind: 'worklog-open'; anchor: WorklogAnchor }
  /** 홈: 그 할 일·일정을 눈에 띄게 */
  | { kind: 'home-focus'; taskId?: string; eventKey?: string };

export interface DocTypeHostValue {
  /** 활성 모듈이 툴바 버튼을 렌더할 슬롯 (Toolbar 셸의 우측 영역) */
  toolbarSlot: HTMLElement | null;
  /** 핸들러 ref 등록 — cleanup 반환. ref 간접화로 항상 최신 클로저 실행 */
  registerHandlers: (ref: MutableRefObject<DocTypeHandlers>) => () => void;
  /** 다른 화면으로 — intent가 있으면 그 화면이 받는다 */
  navigate: (docType: string, intent?: DocIntent) => void;
  /** 넘어오며 전달받은 것 (없으면 null) — 자기 종류일 때만 처리한다 */
  intent: DocIntent | null;
  /** 전달받은 것을 처리했다 */
  clearIntent: () => void;
}

const Ctx = createContext<DocTypeHostValue | null>(null);

export const DocTypeHostProvider = Ctx.Provider;

export function useDocTypeHost(): DocTypeHostValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDocTypeHost는 DocTypeHostProvider 안에서만 사용할 수 있습니다');
  return v;
}

/** 모듈이 메뉴/단축키 핸들러를 호스트에 등록 (마운트 동안 유지, 최신 클로저 보장) */
export function useRegisterDocTypeHandlers(handlers: DocTypeHandlers): void {
  const { registerHandlers } = useDocTypeHost();
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => registerHandlers(ref), [registerHandlers]);
}
