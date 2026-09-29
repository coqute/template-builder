import { buildEmailSubject } from './render';
import { josa } from '../lib/josa';
import type { EmailTemplate } from './types';

export interface EmailIssue {
  severity: 'warning';
  message: string;
}

export interface EmailValidation {
  ok: boolean;
  issues: EmailIssue[];
}

/** required 미입력·빈 제목 → warning (차단 아님) */
export function validateEmail(
  template: EmailTemplate,
  values: Record<string, string>,
): EmailValidation {
  const issues: EmailIssue[] = [];

  for (const section of template.sections) {
    for (const field of section.fields) {
      if (!field.required) continue;
      const raw = (values[field.key] ?? field.default ?? '').trim();
      const v = raw === 'today' ? '' : raw;
      if (!v) {
        issues.push({ severity: 'warning', message: `${josa(field.label, '이/가')} 비어 있습니다.` });
      }
    }
  }

  if (!buildEmailSubject(template, values).trim()) {
    issues.push({ severity: 'warning', message: '제목이 비어 있습니다.' });
  }

  return { ok: issues.length === 0, issues };
}
