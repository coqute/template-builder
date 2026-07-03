import { useMemo } from 'react';
import { renderEmail } from './render';
import { validateEmail, type EmailValidation } from './validate';
import { getTemplate } from './templates';
import type { EmailDocState, EmailRenderResult, EmailTemplate } from './types';

export interface EmailState {
  template?: EmailTemplate;
  rendered?: EmailRenderResult;
  validation?: EmailValidation;
  error?: string;
}

export function useEmailState(doc: EmailDocState): EmailState {
  return useMemo(() => {
    const template = getTemplate(doc.templateId);
    if (!template) return { error: '알 수 없는 템플릿입니다.' };
    try {
      const rendered = renderEmail(template, doc.fieldValues, doc.bodyHtml, doc.subject);
      const validation = validateEmail(template, doc.fieldValues);
      return { template, rendered, validation };
    } catch (err) {
      return { template, error: err instanceof Error ? err.message : '렌더 오류' };
    }
  }, [doc]);
}
