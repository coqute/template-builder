import { createContext, useContext, useEffect, useRef, type MutableRefObject } from 'react';

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

export interface DocTypeHostValue {
  /** 활성 모듈이 툴바 버튼을 렌더할 슬롯 (Toolbar 셸의 우측 영역) */
  toolbarSlot: HTMLElement | null;
  /** 핸들러 ref 등록 — cleanup 반환. ref 간접화로 항상 최신 클로저 실행 */
  registerHandlers: (ref: MutableRefObject<DocTypeHandlers>) => () => void;
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
