import { escapeHtml, MAIL_BORDER, MAIL_TEXT } from '../lib/html';
import { sanitizeBodyHtml, htmlToPlain } from './sanitize';
import type { EmailRenderResult, EmailTemplate } from './types';

/** date 필드의 'today' 기본값은 표/제목에 노출하지 않음 (실제 값 없을 때) */
function fieldValue(values: Record<string, string>, key: string, def?: string): string {
  const raw = (values[key] ?? def ?? '').trim();
  return raw === 'today' ? '' : raw;
}

/** 표/리스트 출력용 — 미입력(선택 안 함 등)이면 실제 제조사지원 표 관례대로 '-' 표기 */
function fieldDisplay(values: Record<string, string>, key: string, def?: string): string {
  return fieldValue(values, key, def) || '-';
}

/** bodyLead 필드 → 요청내용 서두 굵은 줄 `{label} : {value}` (값 있을 때만). 미입력이면 빈 문자열 */
function buildBodyLead(template: EmailTemplate, values: Record<string, string>): string {
  return template.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.bodyLead)
    .map((f) => {
      const v = fieldValue(values, f.key, f.default);
      return v
        ? `<div style="${MAIL_TEXT}font-weight:600;margin:0 0 8px;">${escapeHtml(f.label)} : ${escapeHtml(v).replace(/\n/g, '<br/>')}</div>`
        : '';
    })
    .filter(Boolean)
    .join('');
}

/** subjectPattern의 {key}를 fieldValues로 치환 + 빈 괄호/중복 공백 정리 */
export function buildEmailSubject(
  template: EmailTemplate,
  values: Record<string, string>,
): string {
  let s = template.subjectPattern.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = (values[key] ?? '').trim();
    return v === 'today' ? '' : v; // 'today' 토큰 누출 방어 (date 기본값)
  });
  s = s.replace(/\(\s*\)/g, ''); // 빈 괄호 제거
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

const TD = `border:${MAIL_BORDER};padding:7px 10px;vertical-align:top;${MAIL_TEXT}`;
const TD_LABEL = `${TD}background:#DCE3F2;font-weight:600;color:#111827;white-space:nowrap;`;
const TD_SECTION = `${TD}background:#B0C2E2;font-weight:700;color:#111827;text-align:center;vertical-align:middle;white-space:nowrap;`;

// 본문 내 표·코드 블록을 Gmail/미리보기에서 보이도록 인라인 스타일 주입 (contenteditable은 테두리 미포함)
const BODY_TABLE_STYLE = 'border-collapse:collapse;';
const BODY_CELL_STYLE = `border:${MAIL_BORDER};padding:6px 9px;vertical-align:top;`;
const BODY_TH_EXTRA = 'background:#DCE3F2;font-weight:600;';
const BODY_PRE_STYLE = `font-family:'Courier New',Consolas,monospace;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:4px;padding:8px 10px;white-space:pre-wrap;`;
const BODY_CODE_STYLE = `font-family:'Courier New',Consolas,monospace;background:#f6f8fa;padding:1px 4px;border-radius:3px;`;

/** style 속성에 defaults의 프로퍼티를 idempotent하게 병합 (이미 있는 prop은 보존) */
function mergeStyle(el: Element, defaults: string): void {
  const existing = (el.getAttribute('style') ?? '').trim().replace(/;\s*$/, '');
  const have = new Set(
    existing
      .split(';')
      .map((d) => d.split(':')[0]?.trim().toLowerCase())
      .filter(Boolean),
  );
  const add = defaults
    .split(';')
    .filter(Boolean)
    .filter((d) => !have.has(d.split(':')[0]?.trim().toLowerCase()));
  const merged = [existing, ...add].filter(Boolean).join(';');
  if (merged) el.setAttribute('style', `${merged};`);
}

/**
 * 새니타이즈된 본문 HTML의 표·코드 블록에 인라인 스타일 주입.
 * idempotent (재적용 안정). DOMParser 미가용 시 원본 반환.
 */
export function decorateBodyHtml(safeHtml: string): string {
  if (!safeHtml || typeof DOMParser === 'undefined') return safeHtml;
  const doc = new DOMParser().parseFromString(safeHtml, 'text/html');
  doc.querySelectorAll('table').forEach((t) => mergeStyle(t, BODY_TABLE_STYLE));
  doc.querySelectorAll('td').forEach((c) => mergeStyle(c, BODY_CELL_STYLE));
  doc.querySelectorAll('th').forEach((c) => mergeStyle(c, BODY_CELL_STYLE + BODY_TH_EXTRA));
  doc.querySelectorAll('pre').forEach((p) => mergeStyle(p, BODY_PRE_STYLE));
  doc.querySelectorAll('code').forEach((c) => {
    if (c.parentElement && c.parentElement.tagName === 'PRE') return; // pre 내부 code는 중복 스타일 생략
    mergeStyle(c, BODY_CODE_STYLE);
  });
  return doc.body.innerHTML;
}

/** 인사말 + 표(섹션 rowspan) + 본문 + 맺음말 → Gmail 붙여넣기용 HTML */
export function renderEmailHtml(
  template: EmailTemplate,
  values: Record<string, string>,
  bodyHtml: string,
): string {
  const greetingP = `<p style="${MAIL_TEXT}margin:0 0 14px;">${escapeHtml(template.greeting).replace(/\n/g, '<br/>')}</p>`;
  const closingP = `<p style="${MAIL_TEXT}margin:14px 0 0;">${escapeHtml(template.closing).replace(/\n/g, '<br/>')}</p>`;

  // bullets 스타일 — 출입정보 등 실제 글머리 리스트 메일과 일치
  if (template.renderStyle === 'bullets') {
    const items = template.sections
      .flatMap((s) => s.fields)
      .filter((f) => !f.subjectOnly && !f.bodyLead)
      .map(
        (f) =>
          `<li style="${MAIL_TEXT}margin:0 0 2px;">${escapeHtml(f.label)}: ${escapeHtml(
            fieldDisplay(values, f.key, f.default),
          )}</li>`,
      )
      .join('');
    const list = `<ul style="margin:0 0 12px;padding-left:20px;">${items}</ul>`;
    const bodyBlock =
      template.hasBody && bodyHtml.trim()
        ? `<div style="${MAIL_TEXT}margin:12px 0 0;">${decorateBodyHtml(sanitizeBodyHtml(bodyHtml))}</div>`
        : '';
    return `<div style="${MAIL_TEXT}">${greetingP}${list}${bodyBlock}${closingP}</div>`;
  }

  const hasSections = template.sections.some((s) => s.title);
  const trs: string[] = [];

  for (const section of template.sections) {
    const visible = section.fields.filter((f) => !f.subjectOnly && !f.bodyLead);
    visible.forEach((field, idx) => {
      const cells: string[] = [];
      if (hasSections) {
        if (section.title && idx === 0) {
          cells.push(`<td style="${TD_SECTION}" rowspan="${visible.length}">${escapeHtml(section.title)}</td>`);
        } else if (!section.title) {
          // 섹션 없는 행 — 섹션 컬럼을 라벨이 흡수 (colspan)
        }
      }
      const labelColspan = hasSections && !section.title ? ' colspan="2"' : '';
      cells.push(`<td style="${TD_LABEL}"${labelColspan}>${escapeHtml(field.label)}</td>`);
      cells.push(`<td style="${TD}">${escapeHtml(fieldDisplay(values, field.key, field.default)).replace(/\n/g, '<br/>')}</td>`);
      trs.push(`<tr>${cells.join('')}</tr>`);
    });
  }

  // 본문(요청내용) 행 — 이슈 서두(bodyLead) + 표·코드 인라인 스타일 주입
  if (template.hasBody) {
    const lead = buildBodyLead(template, values);
    const safeBody = decorateBodyHtml(sanitizeBodyHtml(bodyHtml));
    const labelColspan = hasSections ? ' colspan="2"' : '';
    const cell = safeBody || (lead ? '' : '<span style="color:#9ca3af;">(내용 없음)</span>');
    trs.push(
      `<tr><td style="${TD_LABEL}"${labelColspan}>${escapeHtml(template.bodyLabel ?? '요청내용')}</td>` +
        `<td style="${TD}">${lead}${cell}</td></tr>`,
    );
  }

  const greeting = `<p style="${MAIL_TEXT}margin:0 0 14px;">${escapeHtml(template.greeting).replace(/\n/g, '<br/>')}</p>`;
  const closing = `<p style="${MAIL_TEXT}margin:14px 0 0;">${escapeHtml(template.closing).replace(/\n/g, '<br/>')}</p>`;

  // 표 행이 하나도 없으면(전부 subjectOnly + 본문 없음) 표 생략
  if (trs.length === 0) {
    return `<div style="${MAIL_TEXT}">${greeting}${closing}</div>`;
  }

  const colgroup = hasSections
    ? `<colgroup><col style="width:90px"/><col style="width:150px"/><col style="width:430px"/></colgroup>`
    : `<colgroup><col style="width:150px"/><col style="width:470px"/></colgroup>`;
  const table = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:${MAIL_BORDER};">${colgroup}<tbody>${trs.join('')}</tbody></table>`;

  return `<div style="${MAIL_TEXT}">${greeting}${table}${closing}</div>`;
}

export function renderEmailPlain(
  template: EmailTemplate,
  values: Record<string, string>,
  bodyHtml: string,
): string {
  const lines: string[] = [template.greeting, ''];
  for (const section of template.sections) {
    const visible = section.fields.filter((f) => !f.subjectOnly && !f.bodyLead);
    if (visible.length === 0) continue;
    if (section.title) lines.push(`[${section.title}]`);
    for (const field of visible) {
      lines.push(`${field.label}: ${fieldDisplay(values, field.key, field.default)}`);
    }
  }
  if (template.hasBody) {
    // 이슈 서두(bodyLead) → 본문 앞 `{label} : {value}` 줄
    const leadLines = template.sections
      .flatMap((s) => s.fields)
      .filter((f) => f.bodyLead)
      .map((f) => {
        const v = fieldValue(values, f.key, f.default);
        return v ? `${f.label} : ${v}` : '';
      })
      .filter(Boolean);
    lines.push('', `[${template.bodyLabel ?? '요청내용'}]`, ...leadLines, htmlToPlain(bodyHtml));
  }
  lines.push('', template.closing);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderEmail(
  template: EmailTemplate,
  values: Record<string, string>,
  bodyHtml: string,
  subjectOverride?: string,
): EmailRenderResult {
  const override = (subjectOverride ?? '').trim();
  return {
    subject: override || buildEmailSubject(template, values),
    html: renderEmailHtml(template, values, bodyHtml),
    plain: renderEmailPlain(template, values, bodyHtml),
  };
}
