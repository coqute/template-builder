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

/** 표에 렌더하지 않는 필드 — 제목전용/본문서두/도입문장 */
function isOffTable(f: { subjectOnly?: boolean; bodyLead?: boolean; introLead?: boolean }): boolean {
  return !!(f.subjectOnly || f.bodyLead || f.introLead);
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

/** introLead 필드 → 인사말 아래·표 위 문단 (라벨 없이 값만, 값 있을 때만) */
function buildIntroLead(template: EmailTemplate, values: Record<string, string>): string {
  return template.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.introLead)
    .map((f) => {
      const v = fieldValue(values, f.key, f.default);
      return v
        ? `<p style="${MAIL_TEXT}margin:0 0 14px;">${escapeHtml(v).replace(/\n/g, '<br/>')}</p>`
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

// 본문 내 표·코드·리스트를 Gmail/미리보기에서 보이도록 인라인 스타일 주입 (contenteditable은 테두리 미포함)
// 표는 본문 셀 전폭 사용 — 내용 폭만큼 좁게 고정되지 않도록 (에디터 CSS와 동일)
const BODY_TABLE_STYLE = 'border-collapse:collapse;width:100%;';
// 삽입 표 셀은 가로·세로 중앙 정렬 — 좌상단 고정으로 보이던 문제 해소
const BODY_CELL_STYLE = `border:${MAIL_BORDER};padding:6px 9px;text-align:center;vertical-align:middle;`;
const BODY_TH_EXTRA = 'background:#DCE3F2;font-weight:600;';
const BODY_PRE_STYLE = `font-family:'Courier New',Consolas,monospace;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:4px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:break-word;`;
const BODY_CODE_STYLE = `font-family:'Courier New',Consolas,monospace;background:#f6f8fa;padding:1px 4px;border-radius:3px;`;
// 리스트 들여쓰기/마커를 인라인으로 고정 — Outlook 등 기본값이 다른 클라이언트 대비
const BODY_UL_STYLE = 'list-style:disc;margin:4px 0 8px;padding-left:22px;';
const BODY_OL_STYLE = 'list-style:decimal;margin:4px 0 8px;padding-left:22px;';
const BODY_LI_STYLE = 'margin:2px 0;';
const BODY_BLOCKQUOTE_STYLE =
  'margin:4px 0 8px;padding:4px 10px;border-left:3px solid #c5cfdd;color:#4b5563;';
// 링크는 인라인 색·밑줄 고정 — Gmail/Outlook 등 클라이언트 기본값 편차 없이 링크로 보이도록
const BODY_A_STYLE = 'color:#2563eb;text-decoration:underline;';

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
  doc.querySelectorAll('ul').forEach((el) => mergeStyle(el, BODY_UL_STYLE));
  doc.querySelectorAll('ol').forEach((el) => mergeStyle(el, BODY_OL_STYLE));
  doc.querySelectorAll('li').forEach((el) => mergeStyle(el, BODY_LI_STYLE));
  doc.querySelectorAll('blockquote').forEach((el) => mergeStyle(el, BODY_BLOCKQUOTE_STYLE));
  // href가 있는 앵커만 링크 스타일 — sanitize가 위험 스킴 href를 제거해 남은 href 없는 <a>를
  // 파란 밑줄로 칠하면 '클릭되는 것처럼 보이는' 가짜 링크가 되므로 제외
  doc.querySelectorAll('a').forEach((el) => {
    if (el.getAttribute('href')) mergeStyle(el, BODY_A_STYLE);
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

  const introP = buildIntroLead(template, values);

  // bullets 스타일 — 출입정보 등 실제 글머리 리스트 메일과 일치
  if (template.renderStyle === 'bullets') {
    const items = template.sections
      .flatMap((s) => s.fields)
      .filter((f) => !isOffTable(f))
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
    return `<div style="${MAIL_TEXT}">${greetingP}${introP}${list}${bodyBlock}${closingP}</div>`;
  }

  // bodyOnly — 표 없이 인사말 + 도입문장 + 본문 + 맺음말 (설치파일 전달 등)
  if (template.bodyOnly) {
    const bodyBlock =
      template.hasBody && bodyHtml.trim()
        ? `<div style="${MAIL_TEXT}margin:0 0 4px;">${decorateBodyHtml(sanitizeBodyHtml(bodyHtml))}</div>`
        : '';
    return `<div style="${MAIL_TEXT}">${greetingP}${introP}${bodyBlock}${closingP}</div>`;
  }

  const hasSections = template.sections.some((s) => s.title);
  const trs: string[] = [];

  // 표 헤더 행 [구분 | 상세내용] — hasSections면 구분 컬럼이 있으므로 2번째 헤더가 colspan=2
  if (template.tableHeader) {
    const [h1, h2] = template.tableHeader;
    trs.push(
      `<tr><td style="${TD_SECTION}">${escapeHtml(h1)}</td>` +
        `<td style="${TD_SECTION}"${hasSections ? ' colspan="2"' : ''}>${escapeHtml(h2)}</td></tr>`,
    );
  }

  for (const section of template.sections) {
    const visible = section.fields.filter((f) => !isOffTable(f));
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

  const greeting = greetingP;
  const closing = closingP;

  // 표 행이 하나도 없으면(전부 subjectOnly + 본문 없음) 표 생략
  if (trs.length === 0) {
    return `<div style="${MAIL_TEXT}">${greeting}${introP}${closing}</div>`;
  }

  // 라벨 컬럼만 고정, 내용 컬럼은 가변(잔여 폭 전부) + 표는 컨테이너 전폭 —
  // 요청내용이 좁은 고정폭(430px)에서 줄바꿈되던 불편 해소. Gmail에서도 메일 폭에 맞춰 확장
  const colgroup = hasSections
    ? `<colgroup><col style="width:90px"/><col style="width:150px"/><col/></colgroup>`
    : `<colgroup><col style="width:150px"/><col/></colgroup>`;
  const table = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:${MAIL_BORDER};width:100%;">${colgroup}<tbody>${trs.join('')}</tbody></table>`;

  return `<div style="${MAIL_TEXT}">${greeting}${introP}${table}${closing}</div>`;
}

export function renderEmailPlain(
  template: EmailTemplate,
  values: Record<string, string>,
  bodyHtml: string,
): string {
  const lines: string[] = [template.greeting, ''];
  // 도입 문장 (표 위)
  for (const f of template.sections.flatMap((s) => s.fields).filter((f) => f.introLead)) {
    const v = fieldValue(values, f.key, f.default);
    if (v) lines.push(v, '');
  }
  // bodyOnly — 표 생략, 본문만
  if (template.bodyOnly) {
    if (template.hasBody) lines.push(htmlToPlain(bodyHtml));
    lines.push('', template.closing);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  if (template.tableHeader) lines.push(`[${template.tableHeader[0]} / ${template.tableHeader[1]}]`);
  for (const section of template.sections) {
    const visible = section.fields.filter((f) => !isOffTable(f));
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
