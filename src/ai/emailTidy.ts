/**
 * 이메일 AI 정돈 — 제목·도입·이슈 같은 글 칸과 본문을 다듬는다.
 *
 * 요청 내용은 지금 고른 템플릿의 정의에서 만든다 (v0.13.1):
 * - 메일 구성(인사말 → 도입 문장 → 표 → 본문 → 맺음말, 제목이 만들어지는 방식)을 템플릿에서 읽어 알려 준다.
 *   모델이 "이 칸이 메일 어디에 어떤 모양으로 들어가는지" 알아야 인사·맺음말을 되풀이하거나 표의 값을 본문에 옮겨 적지 않는다.
 * - 글 칸에는 그 칸의 예시(placeholder)를 표준 표현으로 함께 보낸다.
 * - 칸의 역할은 템플릿이 정한다(`ai`). 없으면 종류로 정한다: 제목·도입·이슈·긴 글 = 글 칸, 날짜·키·라이선스 = 보내지 않는 칸, 나머지 = 사실 칸.
 *
 * 사실 칸(OS·버전·스펙 등)은 비어 있을 때만, 원문에 그 값이 그대로 있을 때만 채운다.
 * 본문의 이미지·표·코드 블록은 자리표시로 보내고 돌아오면 원본 그대로 되살린다.
 */
import type { EmailDocState, EmailField, EmailTemplate } from '../email/types';
import { htmlToPlain, sanitizeBodyHtml } from '../email/sanitize';
import type { AiCompleteRequest, AiCompleteResult, AiModelId } from '../../electron/ai-types';
import { Masker, missingFacts, sameTokens, tokensOf } from './mask';
import type { ReviewChange, ReviewData, ReviewNote } from './review';
import { estimateUsd } from './settings';
import { site } from '../core/site-config';

export type FieldRole = 'prose' | 'fill' | 'locked';

/** 직접 고쳐 둔 메일 제목(doc.subject)을 가리키는 칸 키 — 템플릿의 칸 키와 겹치지 않는다 */
export const SUBJECT_KEY = '@subject';

interface PlannedField {
  field: EmailField;
  role: FieldRole;
  /** 마스킹한 현재 값 — 보내지 않는 칸은 '' (값을 읽지도 않는다) */
  value: string;
}

export interface EmailTidyPlan {
  request: AiCompleteRequest;
  fields: PlannedField[];
  /** 마스킹한 본문 뼈대 (없으면 '') */
  skeleton: string;
  /** 자리표시 → 원본 HTML(이미지·표·코드) */
  blocks: Map<string, string>;
  /** 원문에 있던 style 값 — 돌아온 본문에서 이 밖의 style은 버린다 */
  styles: Set<string>;
  masker: Masker;
  /** 채움 검증용 원문 전체(마스킹 전) */
  sourceText: string;
  /** 보낸 내용 전체(마스킹 후) — 새로 생긴 숫자·버전을 찾는 데 쓴다 */
  sentText: string;
  /** 지금 본문(확인 창의 '전') */
  bodyHtml: string;
  /** 본문의 이름 — 템플릿의 bodyLabel (확인 창 표시용) */
  bodyLabel: string;
}

/** 이름이 키·라이선스·비밀번호로 끝나는 칸 — 값 그대로여야 하고 밖으로 내보내면 안 된다 */
const SECRET_NAME = /(?:licen[sc]e(?:\s*key)?|라이[선센]스(?:\s*키)?|key|키|token|토큰|password|passwd|비밀번호|secret|시크릿)$/i;

/**
 * 칸의 역할.
 * - prose: 문장이 들어가는 칸(제목·도입·이슈·긴 글) — 다듬는다
 * - fill: 사실 칸 — 비어 있을 때만 원문에 있는 값으로 채운다
 * - locked: 보내지도 바꾸지도 않는다 — 날짜, 그리고 라이선스·키처럼 글자 그대로여야 하는 값
 */
export function fieldRole(f: EmailField): FieldRole {
  if (f.ai === 'prose' || f.ai === 'fill' || f.ai === 'locked') return f.ai;
  if (f.type === 'date') return 'locked';
  if (SECRET_NAME.test(f.key.trim()) || SECRET_NAME.test(f.label.trim())) return 'locked';
  if (f.subjectOnly || f.introLead || f.bodyLead || f.type === 'textarea') return 'prose';
  return 'fill';
}

/** placeholder → 그 칸의 표준 표현 예시 ("예:" 머리와 안내 괄호를 뗀다) */
function exampleOf(f: EmailField): string {
  return (f.placeholder ?? '')
    .replace(/^\s*예\s*[:：]\s*/, '')
    .replace(/\s*\((?:생략 가능|직접 입력 또는 선택)\)\s*$/, '')
    .trim();
}

const BLOCK_TAGS: Record<string, string> = { IMG: 'IMG', TABLE: 'TABLE', PRE: 'CODE' };

/** 본문 HTML → 모델에 보낼 뼈대: 이미지·표·코드 블록은 자리표시, 속성은 링크 주소와 style만, 글은 마스킹 */
export function bodyToSkeleton(html: string, masker: Masker): { skeleton: string; blocks: Map<string, string>; styles: Set<string> } {
  const blocks = new Map<string, string>();
  const styles = new Set<string>();
  if (!html.trim() || typeof DOMParser === 'undefined') return { skeleton: '', blocks, styles };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        child.textContent = masker.mask(child.textContent ?? '');
        continue;
      }
      if (child.nodeType !== 1) {
        child.parentNode?.removeChild(child);
        continue;
      }
      const el = child as Element;
      const kind = BLOCK_TAGS[el.tagName];
      if (kind) {
        const token = masker.reserve(kind, el.outerHTML);
        blocks.set(token, el.outerHTML);
        el.replaceWith(doc.createTextNode(token));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        if (el.tagName === 'A' && attr.name === 'href') el.setAttribute('href', masker.mask(attr.value));
        // 글자색·굵기·정렬 — 붙여 넣은 글의 서식이 정돈 뒤에도 남게 그대로 보낸다
        else if (attr.name === 'style' && attr.value.trim()) styles.add(attr.value);
        else el.removeAttribute(attr.name);
      }
      walk(el);
    }
  };
  walk(doc.body);
  return { skeleton: doc.body.innerHTML, blocks, styles };
}

/** 글줄로 쓴 `- 라벨 : 값` 줄 수 (목록 태그 <li>는 세지 않는다) */
function hyphenLines(html: string): number {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h3|h4|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .split('\n')
    .filter((l) => /^\s*-\s+\S/.test(l)).length;
}

/** 원문에 없던 style 속성을 뗀다 — 모델이 새로 만든 서식은 받지 않는다 */
function keepKnownStyles(html: string, styles: ReadonlySet<string>): string {
  if (typeof DOMParser === 'undefined' || !/\sstyle\s*=/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('[style]').forEach((el) => {
    // 이미지·표·코드 원본은 통째로 되살린 것 — 그 안의 style은 원래 것이다
    if (el.closest('table,pre') || el.tagName === 'IMG') return;
    if (!styles.has(el.getAttribute('style') ?? '')) el.removeAttribute('style');
  });
  return doc.body.innerHTML;
}

/** 모델이 돌려준 뼈대 → 본문 HTML. 자리표시는 정확히 한 번씩 있어야 한다 */
export function skeletonToBody(
  out: string,
  plan: Pick<EmailTidyPlan, 'skeleton' | 'blocks' | 'masker'> & { styles?: ReadonlySet<string> },
): { ok: true; html: string } | { ok: false; reason: string } {
  for (const token of plan.blocks.keys()) {
    const n = out.split(token).length - 1;
    if (n !== 1) return { ok: false, reason: `${token} 자리표시가 ${n === 0 ? '빠짐' : `${n}번 나옴`}` };
  }
  if (!sameTokens(plan.skeleton, out)) return { ok: false, reason: '가린 값(⟦…⟧)이 빠지거나 바뀜' };
  const lost = missingFacts(htmlToPlain(plan.skeleton), htmlToPlain(out));
  if (lost.length) return { ok: false, reason: `숫자·버전이 빠짐: ${lost.slice(0, 3).join(', ')}` };
  // `- 다운링크 : …` 같은 줄은 팀이 쓰는 모양 그대로여야 한다 — 목록 태그나 문장으로 바뀌면 받지 않는다
  if (hyphenLines(out) < hyphenLines(plan.skeleton)) return { ok: false, reason: "'- ' 로 시작하는 줄이 목록·문장으로 바뀜" };
  let html = out;
  for (const [token, original] of plan.blocks) {
    // 표·코드 블록이 홀로 든 문단은 문단째 바꾼다 — <p> 안에 블록이 들어가지 않게.
    // 이미지는 글줄 안 요소라 원래처럼 문단 안에 둔다
    const alone = new RegExp(`<p>\\s*${token.replace(/[⟦⟧]/g, '\\$&')}\\s*</p>`);
    html = !token.startsWith('⟦IMG') && alone.test(html) ? html.replace(alone, original) : html.replace(token, original);
  }
  html = plan.masker.unmask(html);
  if (tokensOf(html).length) return { ok: false, reason: '되돌리지 못한 자리표시가 남음' };
  return { ok: true, html: sanitizeBodyHtml(keepKnownStyles(html, plan.styles ?? new Set())) };
}

// ── 템플릿별 작성 지침 ──────────────────────────────────────────
// 내장 3종은 팀이 실제로 보낸 메일의 모양을 따른다. 그 밖의 템플릿(팀·개인 JSON)은 템플릿의 이름·설명·예시로 안내한다.

const TECH_GUIDE = `상황: ${site().company} 기술지원 엔지니어가 제조사 지원팀에 고객사 기술 문의를 보내는 메일이다. 받는 사람은 제조사 지원 엔지니어이고, 이 메일만 읽고 바로 조사·답변할 수 있어야 한다.
- 메일 제목(topic): "[고객사] 핵심 현상 또는 요청" 한 줄. 앞의 [고객사] 표기는 원문 그대로 둔다. 끝에 "문의"·"개선요청"·"확인요청"처럼 무엇을 원하는지 드러낸다.
- 도입 문장(intro): 존댓말 한 문장. 어느 고객사 지원 중 어떤 종류의 요청인지만 말한다.
- 이슈(issue): 현상을 한 줄 명사형으로 요약. 요청내용 맨 위에 굵은 줄로 들어가므로 본문에서 같은 문장을 되풀이하지 않는다.
- 요청내용(본문): 존댓말 평서문. 원문에 있는 내용만으로 "현상 → 발생 조건·재현 상황 → 확인한 내용·시도한 조치 → 요청 사항" 순서로 정리하고, 요청 사항이 여러 개면 번호 목록(<ol>)으로 질문을 하나씩 나눈다. 원문에 없는 단락은 만들지 않는다.
- OS·버전·계약 정보처럼 표의 칸에 들어가는 값은 표가 보여 준다. 본문에 새로 옮겨 적지 않는다(원문 본문에 이미 있던 것은 그대로 둔다).`;

const LICENSE_GUIDE = `상황: 발급된 제조사 수집서버 라이선스 키를 고객(또는 설치 담당자)에게 전달하는 메일이다. 받는 사람은 이 메일의 표에서 키를 복사해 수집서버 설치에 쓴다.
- 메일 제목(topic): 무엇을 전달하는지 한 줄. 문장으로 끝낸다("…전달드립니다.").
- 도입 문장(intro): 존댓말 한두 문장. 라이선스가 발급되어 전달한다는 것과, 받는 사람이 알아야 할 안내(용도·주의)만 쓴다.
- 라이선스 키와 날짜는 보내지 않았다. 그 값을 묻거나 짐작해 쓰지 않는다.`;

const INSTALL_GUIDE = `상황: 수집서버·에이전트·BMS 등의 설치·패치 파일 다운로드 링크를 전달하는 메일이다. 표 없이 본문이 메일 내용의 전부다.
- 메일 제목(topic): 무엇을 전달하는지 한 줄.
- 도입 문장(intro): 생략할 수 있는 한 문장. 비어 있으면 채우지 않는다.
- 본문: 전달물마다 "○○ 전달 드립니다." 한 줄과 그 아래 "- 라벨 : 링크" 줄들로 쓴다. 이 모양(전달 문장 한 줄, 하이픈으로 시작하는 라벨 줄, 라벨과 괄호 안 버전·OS 표기, 줄바꿈)은 그대로 둔다.
- 다듬는 것은 맞춤법·띄어쓰기와, 사용자가 덧붙인 설명 문장뿐이다. 링크·버전·파일명은 글자 그대로 둔다.`;

const GUIDES: Record<string, string> = {
  'tech-inquiry': TECH_GUIDE,
  'license-delivery': LICENSE_GUIDE,
  'install-delivery': INSTALL_GUIDE,
};

function guideFor(template: EmailTemplate): string {
  const own = GUIDES[template.id];
  const base =
    own ??
    `상황: "${template.name}" 양식의 업무 메일이다.${template.note ? ` (${template.note})` : ''}
- 글 칸과 본문을 받는 사람이 바로 이해하도록 간결한 존댓말로 다듬는다. 각 칸의 example이 이 양식의 표준 표현이다.`;
  const presets = (template.bodyPresets ?? []).slice(0, 6);
  if (presets.length === 0) return base;
  // 본문에 [문구 삽입]으로 넣는 표준 문구 — 본문이 이 모양으로 쓰였으면 그대로 둬야 한다
  return `${base}
- 이 양식의 본문 표준 문구 (이 모양으로 쓴 줄은 모양을 바꾸지 않는다):
${presets.map((p) => p.split('\n').map((l) => `    ${l}`).join('\n')).join('\n')}`;
}

function offTable(f: EmailField): boolean {
  return !!(f.subjectOnly || f.bodyLead || f.introLead);
}

/** 이 템플릿으로 메일 한 통이 어떻게 조립되는지 — render.ts(renderEmailHtml·buildEmailSubject)와 같은 순서 */
export function describeLayout(template: EmailTemplate, manualSubject = false): string {
  const all = template.sections.flatMap((s) => s.fields);
  const name = (f: EmailField) => `"${f.label}"(${f.key})`;
  const steps: string[] = ['인사말 — 앱이 자동으로 넣는다(보내는 사람을 밝히는 한 줄).'];
  const intro = all.filter((f) => f.introLead);
  if (intro.length) steps.push(`도입 문장 — ${intro.map(name).join(', ')} 칸. 인사말 바로 아래 한 문단으로 들어간다.`);
  const bullets = template.renderStyle === 'bullets';
  if (!template.bodyOnly) {
    const rows = template.sections
      .map((s) => {
        const visible = s.fields.filter((f) => !offTable(f));
        return visible.length ? `${s.title ? `${s.title}: ` : ''}${visible.map((f) => f.label).join(' · ')}` : '';
      })
      .filter(Boolean);
    if (rows.length) {
      const head = template.tableHeader ? ` [${template.tableHeader[0]} | ${template.tableHeader[1]}]` : '';
      steps.push(`${bullets ? '글머리 목록' : `표${head}`} — ${rows.join(' / ')}. 칸에 적은 값이 그대로 들어간다.`);
    }
  }
  if (template.hasBody) {
    const lead = all.filter((f) => f.bodyLead);
    const label = template.bodyLabel ?? '요청내용';
    if (template.bodyOnly) steps.push(`본문(body) — 표 없이 ${intro.length ? '도입 문장' : '인사말'} 아래에 바로 온다. 메일 내용의 전부다.`);
    else if (bullets) steps.push('본문(body) — 목록 아래에 온다.');
    else {
      const leadText = lead.length ? `맨 위에 굵은 줄 "${lead[0].label} : (${lead[0].key} 칸의 값)", 그 아래에 ` : '';
      steps.push(`표의 마지막 "${label}" 행 — ${leadText}본문(body).`);
    }
  }
  steps.push('맺음말 — 앱이 자동으로 넣는다.');

  const keys = [...template.subjectPattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const only = keys.length === 1 && template.subjectPattern.trim() === `{${keys[0]}}` ? all.find((f) => f.key === keys[0]) : undefined;
  const subject = manualSubject
    ? `메일 제목: 사용자가 직접 적어 둔 제목("메일 제목"(${SUBJECT_KEY}) 칸)이 그대로 쓰인다.`
    : only
      ? `메일 제목: ${name(only)} 칸의 값이 그대로 제목이 된다.`
      : `메일 제목: "${template.subjectPattern}" 모양으로 조립된다. {키} 자리에 그 칸의 값이 들어가므로, 칸에는 자기 자리에 들어갈 말만 쓴다.`;
  return `${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${subject}`;
}

const NOTES_GUIDE: Record<string, string> = {
  'tech-inquiry': '제조사지원가 답하려면 더 필요해 보이는 정보(예: 재현 절차, 로그 파일, 발생 시각)만 짧게, 최대 5개.',
};

export function emailSystem(template: EmailTemplate, opts: { manualSubject?: boolean } = {}): string {
  const notes = NOTES_GUIDE[template.id] ?? '받는 사람이 이 메일만 보고 처리하기에 빠졌거나 헷갈릴 수 있는 점만 짧게, 최대 3개.';
  return `당신은 기술지원 업무 메일을 다듬는 편집자다.

${guideFor(template)}

메일 한 통의 구성 (앱이 아래 순서로 조립한다)
${describeLayout(template, !!opts.manualSubject)}
- 인사말·맺음말·서명은 앱이 붙인다. 도입 문장과 본문에 새로 넣지 않는다.

칸 규칙 (fields)
- role이 "prose"인 칸: 문장을 다듬어 돌려준다. example은 이 양식에서 그 칸을 쓰는 표준 표현이다. 말투·길이·머리 표기를 거기에 맞추고, example에 든 내용(고객사·현상·제품)은 가져오지 않는다. 비어 있는 칸은 원문(다른 칸이나 본문)에 근거가 있을 때만 채운다.
- role이 "fill"인 칸: 지금 값이 비어 있고, 그 값이 원문(다른 칸이나 본문)에 글자 그대로 적혀 있을 때만 그 글자 그대로 채운다. 추측하지 않는다. options가 있으면 그중 하나만. 채울 근거가 없으면 돌려주지 않는다.
- 받지 않은 칸(날짜, 라이선스·키 같은 값)은 돌려주지 않는다.

본문 규칙 (body)
- 쓸 수 있는 태그: p, div, br, ul, ol, li, strong, b, em, i, u, code, a, h3, h4, blockquote, span. 원문의 줄바꿈·강조·목록은 뜻이 같으면 그대로 둔다.
- 속성은 원문에 있던 style과 a의 href만, 원문 그대로 둔다. 새로 만들지 않는다.
- "- 라벨 : 값"처럼 하이픈으로 시작하는 글줄은 그 모양 그대로 둔다. 목록 태그나 문장으로 바꾸지 않는다.
- ⟦IMG1⟧ ⟦TABLE1⟧ ⟦CODE1⟧은 이미지·표·코드 블록 자리다. 각각 정확히 한 번, 원래 맥락 위치에 둔다. 표·코드는 <p>⟦…⟧</p> 단독 문단으로 둔다.
- 본문을 받지 않았거나 비어 있으면 body는 빈 문자열.

공통으로 지킬 것
- 사실을 바꾸거나 더하지 않는다. 버전·OS·수치·로그·설정값·명령어·제품명·고객사명은 글자 그대로.
- ⟦IP1⟧ ⟦URL1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ 같은 자리표시는 가린 값이다. 글자 그대로, 같은 개수만큼 남긴다.

notes: ${notes} 없으면 빈 배열.`;
}

export const EMAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'body', 'notes'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: { key: { type: 'string' }, value: { type: 'string' } },
      },
    },
    body: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function planEmailTidy(template: EmailTemplate, doc: EmailDocState, model: AiModelId): EmailTidyPlan | null {
  const masker = new Masker();
  const manualSubject = (doc.subject ?? '').trim();
  const fields: PlannedField[] = template.sections.flatMap((s) =>
    s.fields.map((field) => {
      // 제목을 직접 고쳐 둔 문서에서는 제목 전용 칸이 메일 어디에도 나가지 않는다 — 다듬을 것은 그 제목이다
      const role = manualSubject && field.subjectOnly ? 'locked' : fieldRole(field);
      // 보내지 않는 칸은 값을 읽지 않는다 (라이선스 키가 가림 사전에도 들어가지 않게)
      return { field, role, value: role === 'locked' ? '' : masker.mask(doc.fieldValues[field.key] ?? '') };
    }),
  );
  if (manualSubject) {
    const topic = template.sections.flatMap((s) => s.fields).find((f) => f.subjectOnly);
    fields.unshift({
      field: { key: SUBJECT_KEY, label: '메일 제목', type: 'text', placeholder: topic?.placeholder },
      role: 'prose',
      value: masker.mask(manualSubject),
    });
  }
  const { skeleton, blocks, styles } = template.hasBody
    ? bodyToSkeleton(doc.bodyHtml, masker)
    : { skeleton: '', blocks: new Map<string, string>(), styles: new Set<string>() };
  const hasProse = fields.some((f) => f.role === 'prose' && f.value.trim()) || skeleton.trim();
  if (!hasProse) return null;
  const sourceText = [
    manualSubject,
    ...template.sections.flatMap((s) => s.fields.map((f) => doc.fieldValues[f.key] ?? '')),
    template.hasBody ? htmlToPlain(doc.bodyHtml) : '',
  ].join('\n');
  const sent = fields.filter((f) => f.role !== 'locked');
  const payload = {
    template: template.name,
    fields: sent.map((f) => {
      const example = f.role === 'prose' ? exampleOf(f.field) : '';
      return {
        key: f.field.key,
        label: f.field.label,
        role: f.role,
        value: f.value,
        ...(example ? { example } : {}),
        ...(f.field.options?.length ? { options: f.field.options } : {}),
      };
    }),
    body: skeleton,
  };
  const user = `아래 메일 입력값을 규칙대로 다듬어 JSON으로 돌려줘. fields에는 바꾸거나 채운 칸만 넣어도 된다.\n\n${JSON.stringify(payload, null, 1)}`;
  return {
    request: {
      model,
      system: emailSystem(template, { manualSubject: !!manualSubject }),
      user,
      schema: EMAIL_SCHEMA as unknown as Record<string, unknown>,
      effort: 'medium',
      maxTokens: Math.min(32000, 4000 + Math.ceil(user.length * 1.5)),
    },
    fields,
    skeleton,
    blocks,
    styles,
    masker,
    sourceText,
    sentText: [...sent.map((f) => f.value), htmlToPlain(skeleton)].join('\n'),
    bodyHtml: doc.bodyHtml,
    bodyLabel: template.bodyLabel ?? '요청내용',
  };
}

interface EmailResponse {
  fields: Array<{ key: string; value: string }>;
  body: string;
  notes: string[];
}

function isEmailResponse(v: unknown): v is EmailResponse {
  const o = v as EmailResponse;
  return !!o && Array.isArray(o.fields) && typeof o.body === 'string' && Array.isArray(o.notes);
}

/** 대괄호 머리([고객사])는 바꾸면 안 된다 — 팀 약칭·고객 표기 */
function bracketHead(s: string): string | null {
  const m = s.trim().match(/^\[[^\]]+\]/);
  return m ? m[0] : null;
}

function checkField(pf: PlannedField, afterMasked: string, plan: Pick<EmailTidyPlan, 'sourceText' | 'sentText' | 'masker'>): string | undefined {
  const { masker } = plan;
  if (pf.role === 'prose') {
    if (!afterMasked.trim()) return '빈 값으로 돌아옴';
    if (/[\r\n]/.test(afterMasked.trim()) && !/[\r\n]/.test(pf.value.trim()) && pf.field.type !== 'textarea') return '한 줄 칸에 줄바꿈이 들어감';
    if (!sameTokens(pf.value, afterMasked)) {
      // 비어 있던 칸을 채울 때는 보낸 내용에 있던 자리표시만 쓸 수 있다
      const known = new Set(tokensOf(plan.sentText));
      if (pf.value.trim() || tokensOf(afterMasked).some((t) => !known.has(t))) return '가린 값(⟦…⟧)이 빠지거나 바뀜';
    }
    const lost = missingFacts(pf.value, afterMasked);
    if (lost.length) return `숫자·버전이 빠짐: ${lost.slice(0, 3).join(', ')}`;
    // 보낸 내용 어디에도 없던 숫자·버전 — 지어낸 사실
    const invented = missingFacts(afterMasked, plan.sentText);
    if (invented.length) return `원문에 없는 숫자·버전: ${invented.slice(0, 3).join(', ')}`;
    const head = bracketHead(pf.value);
    if (head && bracketHead(afterMasked) !== head) return `머리 ${masker.unmask(head)}가 바뀜`;
    return undefined;
  }
  // 채움 — 비어 있던 칸만, 근거가 원문에 글자 그대로
  if (pf.value.trim()) return '이미 값이 있는 칸';
  const value = masker.unmask(afterMasked).trim();
  if (!value) return '빈 값';
  if (pf.field.options?.length && pf.field.type === 'select') {
    return pf.field.options.includes(value) ? undefined : '보기에 없는 값';
  }
  if (!plan.sourceText.includes(value)) return '원문에 없는 값(추측)';
  return undefined;
}

export function reviewEmail(plan: EmailTidyPlan, res: Extract<AiCompleteResult, { ok: true }>): ReviewData {
  if (!isEmailResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const { masker } = plan;
  const changes: ReviewChange[] = [];
  const byKey = new Map(plan.fields.map((f) => [f.field.key, f]));
  for (const got of res.json.fields) {
    const pf = byKey.get(got.key);
    if (!pf || pf.role === 'locked') continue;
    if (got.value.trim() === pf.value.trim()) continue;
    const reason = checkField(pf, got.value, plan);
    changes.push({
      id: `field:${pf.field.key}`,
      group: '칸',
      label: pf.role === 'fill' ? `${pf.field.label} (빈 칸 채움)` : pf.field.label,
      before: masker.unmask(pf.value),
      after: masker.unmask(got.value.trim()),
      ok: !reason,
      reason,
    });
  }
  const body = res.json.body.trim();
  if (plan.skeleton.trim() && body && body !== plan.skeleton.trim()) {
    const restored = skeletonToBody(body, plan);
    changes.push({
      id: 'body',
      group: '본문',
      label: plan.bodyLabel,
      before: plan.bodyHtml,
      after: restored.ok ? restored.html : '',
      html: true,
      ok: restored.ok,
      reason: restored.ok ? undefined : restored.reason,
    });
  }
  const notes: ReviewNote[] = res.json.notes.filter((n) => n.trim()).map((n) => ({ group: '', text: masker.unmask(n.trim()) }));
  return {
    changes,
    notes,
    model: res.model,
    usage: res.usage,
    usd: estimateUsd(res.model, res.usage),
    ms: res.ms,
    fallbackUsed: res.fallbackUsed,
    masked: masker.summary(),
  };
}

/** 고른 변경만 반영한 새 문서 */
export function applyEmail(doc: EmailDocState, review: ReviewData, picked: Set<string>): EmailDocState {
  const fieldValues = { ...doc.fieldValues };
  let bodyHtml = doc.bodyHtml;
  let subject = doc.subject;
  for (const ch of review.changes) {
    if (!ch.ok || !picked.has(ch.id)) continue;
    if (ch.id === 'body') bodyHtml = ch.after;
    else if (ch.id === `field:${SUBJECT_KEY}`) subject = ch.after;
    else if (ch.id.startsWith('field:')) fieldValues[ch.id.slice('field:'.length)] = ch.after;
  }
  return { ...doc, fieldValues, bodyHtml, subject };
}
