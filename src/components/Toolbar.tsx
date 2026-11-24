import { Settings } from 'lucide-react';
import { DocTypeSwitch, type DocTypeOption } from './DocTypeSwitch';
import { StampLogo } from './StampLogo';
import { Btn } from './ToolbarButton';
import type { Theme } from '../hooks/useTheme';

interface ToolbarProps {
  options: readonly DocTypeOption[];
  docType: string;
  onDocTypeChange: (id: string) => void;
  /** 활성 모듈이 버튼을 포털로 렌더할 슬롯 엘리먼트 전달 */
  onToolbarSlot: (el: HTMLDivElement | null) => void;
  onToggleHelp: () => void;
  theme: Theme;
}

/**
 * 툴바 셸 — 문서 타입을 모른다. 좌측(로고/스위치)과 우측 공통(도움말·설정)만 소유하고,
 * 모드별 액션 버튼은 슬롯(onToolbarSlot)에 활성 DocType 모듈이 포털로 렌더한다.
 */
export function Toolbar({
  options,
  docType,
  onDocTypeChange,
  onToolbarSlot,
  onToggleHelp,
  theme,
}: ToolbarProps) {
  const isMono = theme === 'mono';
  return (
    <header
      className="flex flex-nowrap items-center justify-between gap-2 overflow-hidden border-b border-rule bg-bg px-4"
      style={{ height: 'var(--gap-toolbar, 56px)' }}
    >
      <div className="flex min-w-0 shrink items-center gap-2">
        <StampLogo theme={theme} size={28} />
        <h1
          className={[
            'hidden whitespace-nowrap text-fg lg:block',
            isMono ? 'text-sm font-semibold' : 'font-display text-base',
          ].join(' ')}
        >
          {isMono ? '$ template-builder' : 'Template Builder'}
        </h1>
        <span className="mx-1 h-5 w-px shrink-0 bg-rule" />
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
