import { Circle, Moon } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';

interface Props {
  theme: Theme;
  onChange: (next: Theme) => void;
}

const OPTIONS: Array<{ value: Theme; label: string; icon: React.ReactNode; hint: string }> = [
  { value: 'paper', label: 'White', icon: <Circle size={12} />, hint: 'Minimalist White (극단적 단순함)' },
  { value: 'mono', label: 'Mono', icon: <Moon size={12} />, hint: '엔지니어 콘솔 (다크)' },
];

export function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="앱 테마"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sharp border border-rule p-0.5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            title={opt.hint}
            className={[
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sharp px-2 py-0.5 text-[10px] leading-none transition',
              active
                ? 'font-semibold text-bg'
                : 'text-fg-soft hover:text-fg',
            ].join(' ')}
            style={
              active
                ? { background: 'var(--accent)', color: 'var(--bg)' }
                : undefined
            }
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
