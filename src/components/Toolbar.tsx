import { Settings } from 'lucide-react';
import { DocTypeSwitch, type DocTypeOption } from './DocTypeSwitch';
import { StampLogo } from './StampLogo';
import { Btn } from './ToolbarButton';
import type { Theme } from '../hooks/useTheme';

interface ToolbarProps {
  options: readonly DocTypeOption[];
  docType: string;
  onDocTypeChange: (id: string) => void;
  /** 로고를 누르면 홈으로 — 탭 줄에는 홈이 없다(v0.27.1). 홈 화면이 등록되지 않았으면 주지 않는다(로고는 그림으로만 남는다) */
  onHome?: () => void;
  /** 지금 홈을 보고 있는가 */
  atHome?: boolean;
  /** 로고에 띄울 설명 */
  homeHint?: string;
  /** 활성 모듈이 버튼을 포털로 렌더할 슬롯 엘리먼트 전달 */
  onToolbarSlot: (el: HTMLDivElement | null) => void;
  onToggleHelp: () => void;
  theme: Theme;
}

/**
 * 툴바 셸 — 문서 타입을 모른다. 좌측(로고/스위치)과 우측 공통(도움말·설정)만 소유하고,
 * 모드별 액션 버튼은 슬롯(onToolbarSlot)에 활성 DocType 모듈이 포털로 렌더한다.
 * 로고는 홈 단추다 — 앱 이름 글자는 두지 않는다(창 제목에 있다).
 */
export function Toolbar({
  options,
  docType,
  onDocTypeChange,
  onHome,
  atHome = false,
  homeHint,
  onToolbarSlot,
  onToggleHelp,
  theme,
}: ToolbarProps) {
  return (
    <header
      className="flex flex-nowrap items-center justify-between gap-2 overflow-hidden border-b border-rule bg-bg px-4"
      style={{ height: 'var(--gap-toolbar, 56px)' }}
    >
      <div className="flex min-w-0 shrink items-center gap-3">
        {onHome ? (
          <button
            type="button"
            className="tb-logo"
            data-testid="home-logo"
            aria-label="홈"
            aria-current={atHome ? 'page' : undefined}
            title={homeHint ? `홈 — ${homeHint}` : '홈'}
            onClick={onHome}
          >
            <StampLogo theme={theme} size={28} />
          </button>
        ) : (
          <StampLogo theme={theme} size={28} />
        )}
        {/* 로고와 탭 줄 사이에는 구분선을 두지 않는다 — 틈만 둔다(v0.27.2) */}
        <DocTypeSwitch options={options} docType={docType} onChange={onDocTypeChange} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* 활성 모듈의 액션 버튼 슬롯 */}
        <div ref={onToolbarSlot} className="flex shrink-0 items-center gap-1.5" />
        <span className="mx-1 h-5 w-px bg-rule" />
        <Btn label="설정" shortcut="F1 · 설정·도움말" icon={<Settings size={14} />} onClick={onToggleHelp} />
      </div>
    </header>
  );
}
