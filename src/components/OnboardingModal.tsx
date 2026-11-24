import { useState } from 'react';
import { defaultCompany, type UserProfile } from '../email/profile';

interface Props {
  onSubmit: (profile: UserProfile) => void;
}

/** 최초 실행 온보딩 — 프로필(이름) 미설정 시 표시. 이름은 필수, 이메일은 선택 */
export function OnboardingModal({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState(defaultCompany());
  const canSubmit = name.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), email: email.trim(), company: company.trim() || defaultCompany() });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[360px] rounded-card border border-rule bg-bg-elevated p-5" style={{ boxShadow: 'var(--shadow)' }}>
        <h2 className="text-sm font-semibold text-fg">프로필 설정</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          주간보고서 작성자명과 이메일 인사말·기본값에 사용됩니다. 나중에 설정(F1)에서 변경할 수 있습니다.
        </p>
        <div className="mt-4 space-y-2.5">
          <Field label="이름 *" value={name} placeholder="홍길동" onChange={setName} autoFocus onEnter={submit} />
          <Field label="이메일" value={email} placeholder="hong@company.example" onChange={setEmail} onEnter={submit} />
          <Field label="회사" value={company} placeholder={defaultCompany()} onChange={setCompany} onEnter={submit} />
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-sharp px-4 py-1.5 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--bg)' }}
          >
            시작하기
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
  autoFocus,
  onEnter,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  onEnter: () => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-fg-soft">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter();
        }}
        className="min-w-0 flex-1 rounded-sharp border border-rule bg-bg-deep px-2 py-1.5 text-xs text-fg outline-none focus:border-fg"
      />
    </label>
  );
}
