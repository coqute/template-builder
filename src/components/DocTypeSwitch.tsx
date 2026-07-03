import { FileSpreadsheet, Mail } from 'lucide-react';
import type { DocType } from '../hooks/useDocType';

interface Props {
  docType: DocType;
  onChange: (next: DocType) => void;
}

const OPTIONS: Array<{ value: DocType; label: string; icon: React.ReactNode; hint: string }> = [
  {
    value: 'weekly',
    label: '주간보고서',
    icon: <FileSpreadsheet size={12} />,
    hint: '주간보고서 .md → HTML 표',
  },
  {
    value: 'email',
    label: '이메일',
    icon: <Mail size={12} />,
    hint: '반복 이메일 템플릿 → Gmail 작성',
  },
];

export function DocTypeSwitch({ docType, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="문서 종류"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sharp border border-rule p-0.5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {OPTIONS.map((opt) => {
        const active = docType === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
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
