import type { EmailField, EmailTemplate } from '../types';

interface Props {
  template: EmailTemplate;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export function EmailFieldForm({ template, values, onChange }: Props) {
  return (
    <div className="space-y-3">
      {template.sections.map((section, si) => (
        <fieldset key={si}>
          {section.title && (
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              {section.title}
            </legend>
          )}
          {/* 2단 그리드 — 짧은 필드 반폭, wide/textarea 전폭 */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {section.fields.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={values[field.key] ?? field.default ?? ''}
                onChange={(v) => onChange(field.key, v)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: EmailField;
  value: string;
  onChange: (v: string) => void;
}) {
  const fullWidth = field.wide || field.type === 'textarea';
  const inputCls =
    'w-full rounded-sharp border border-rule bg-bg-elevated px-2 py-1 text-xs text-fg outline-none focus:border-accent';
  return (
    <label className={['flex flex-col gap-0.5', fullWidth ? 'col-span-2' : ''].join(' ')}>
      <span className="text-[10px] font-medium text-fg-soft">
        {field.label}
        {field.subjectOnly && <span className="text-fg-faint"> · 제목용</span>}
        {field.bodyLead && <span className="text-fg-faint"> · 본문 서두</span>}
        {field.introLead && <span className="text-fg-faint"> · 표 위 문단</span>}
        {field.required && <span style={{ color: 'var(--stamp-red)' }}> *</span>}
      </span>
      {field.type === 'select' ? (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">(선택)</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === 'date' ? (
        <input
          type="date"
          className={inputCls}
          value={value === 'today' ? '' : value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'textarea' ? (
        <textarea
          className={`${inputCls} resize-y`}
          rows={2}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        // text — options가 있으면 datalist로 자유입력+추천 (문의 제품처럼 값이 다양한 필드)
        <>
          <input
            type="text"
            className={inputCls}
            placeholder={field.placeholder}
            value={value}
            list={field.options ? `dl-${field.key}` : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.options && (
            <datalist id={`dl-${field.key}`}>
              {field.options.map((opt) => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
          )}
        </>
      )}
    </label>
  );
}
