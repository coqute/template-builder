import type { ComponentType, ReactNode } from 'react';
import type { UserProfile } from '../email/profile';
import type { Theme } from '../hooks/useTheme';
import type { ZoomMode } from '../components/HtmlPreview';

/** 모든 DocType 모듈의 Workspace가 받는 공통 셸 컨텍스트 */
export interface DocTypeWorkspaceProps {
  theme: Theme;
  profile: UserProfile;
  zoom: ZoomMode;
  onZoomChange: (z: ZoomMode) => void;
  /** 템플릿 오버레이 로드 신호 (email 모듈 재해석용, 그 외 무시 가능) */
  templatesVersion: number;
}

/**
 * 문서 타입 플러그인 — 새 문서 타입 추가 = 이 인터페이스 구현 모듈 1개를
 * doctypes/index.ts 목록에 등록. App/Toolbar는 수정 불필요.
 * 모듈은 자신의 상태·툴바 버튼(포털)·메뉴/단축키·상태바를 스스로 소유한다.
 */
export interface DocTypeModule {
  id: string;
  /** DocTypeSwitch 라벨 */
  label: string;
  switchIcon?: ReactNode;
  switchHint?: string;
  Workspace: ComponentType<DocTypeWorkspaceProps>;
}
