export interface DocTypeOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
}

interface Props {
  options: readonly DocTypeOption[];
  docType: string;
  onChange: (next: string) => void;
}

/** 화면 전환 스위치(홈 + 문서 종류) — 옵션은 doctypes 레지스트리에서 주입 */
export function DocTypeSwitch({ options, docType, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="화면"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sharp border border-rule p-0.5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {options.map((opt) => {
        const active = docType === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
            className={[
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sharp px-2 py-0.5 text-[11px] leading-none transition',
              active ? 'font-semibold text-bg' : 'text-fg-soft hover:text-fg',
            ].join(' ')}
            style={active ? { background: 'var(--accent)', color: 'var(--bg)' } : undefined}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
