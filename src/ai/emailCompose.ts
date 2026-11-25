/**
 * 이메일 서술 → 서식 — 편하게 적은 글(또는 붙여 넣은 대화)을 고른 서식의 칸에 맞는 글로 바꾼다.
 * 작업일지의 대화 → 블록과 같은 흐름이다: 서술을 가려 보내고, 돌아온 글을 고칠 수 있는 초안으로 보여 준 뒤 서식에 넣는다.
 *
 * 요청 내용은 지금 고른 템플릿의 정의에서 만든다:
 * - 메일 구성(인사말 → 도입 문장 → 표 → 본문 → 맺음말, 제목이 만들어지는 방식)을 템플릿에서 읽어 알려 준다.
 * - 글 칸에는 그 칸의 예시(placeholder)를 표준 표현으로 함께 보낸다.
 * - 칸의 역할은 템플릿이 정한다(`ai`). 없으면 종류로 정한다: 제목·도입·이슈·긴 글 = 글 칸, 날짜·키·라이선스 = 보내지 않는 칸, 나머지 = 사실 칸.
 * 서식별 작성 지침(SPECS)은 실제로 보낸 메일의 모양을 따른다. 서식(JSON)의 칸·예시를 바꾸면 SPECS도 함께 맞춘다.
 *
 * 지어내지 않는다:
 * - 서술에 없는 단락(확인·검토한 내용 등)은 만들지 않고, 빠진 것을 "확인할 점"으로 알린다.
 * - 사실 칸(OS·버전·고객사 등)은 비어 있을 때만, 서술에 그 값이 글자 그대로 있을 때만 채운다.
 * - 날짜, 라이선스·키 칸은 값을 읽지도 보내지도 채우지도 않는다.
 */
import type { EmailDocState, EmailField, EmailTemplate } from '../email/types';
import { htmlToPlain } from '../email/sanitize';
import type { AiCompleteRequest, AiCompleteResult, AiModelId, AiUsage } from '../../electron/ai-types';
import { escapeHtml } from '../lib/html';
import { canonicalClient } from '../core/customer';
import { site } from '../core/site-config';
import { Masker, missingFacts, tokensOf } from './mask';
import { estimateUsd } from './settings';
import { maskNames, speakerNames, titledNames } from './worklogAi';

export type FieldRole = 'prose' | 'fill' | 'locked';

/** 본문 단락의 종류 — 문의 글의 논리 순서(발생한 일 → 확인한 것 → 묻는 것 → 참고) */
export type BodyPart = 'issue' | 'checked' | 'ask' | 'note' | 'text';

/** 이름이 키·라이선스·비밀번호로 끝나는 칸 — 값 그대로여야 하고 밖으로 내보내면 안 된다 */
const SECRET_NAME = /(?:licen[sc]e(?:\s*key)?|라이[선센]스(?:\s*키)?|key|키|token|토큰|password|passwd|비밀번호|secret|시크릿)$/i;

/**
 * 칸의 역할.
 * - prose: 문장이 들어가는 칸(제목·도입·이슈·긴 글) — 서술에서 쓴다
 * - fill: 사실 칸 — 비어 있을 때만 서술에 있는 값으로 채운다
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

/** 비어 있는 칸 — 표의 빈 값 표시 `-`도 빈 것으로 본다 */
function blank(v: string): boolean {
  const t = v.trim();
  return !t || t === '-';
}

function offTable(f: EmailField): boolean {
  return !!(f.subjectOnly || f.bodyLead || f.introLead);
}

/** 이 템플릿으로 메일 한 통이 어떻게 조립되는지 — render.ts(renderEmailHtml·buildEmailSubject)와 같은 순서 */
export function describeLayout(template: EmailTemplate): string {
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
  const subject = only
    ? `메일 제목: ${name(only)} 칸의 값이 그대로 제목이 된다.`
    : `메일 제목: "${template.subjectPattern}" 모양으로 조립된다. {키} 자리에 그 칸의 값이 들어가므로, 칸에는 자기 자리에 들어갈 말만 쓴다.`;
  return `${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${subject}`;
}

// ── 서식별 작성 지침 ────────────────────────────────────────────
// 내장 3종은 팀이 실제로 보낸 메일의 모양을 따른다. 그 밖의 템플릿(팀·개인 JSON)은 템플릿의 이름·설명·예시로 안내한다.

interface ComposeSpec {
  /** 툴바 버튼의 이름 — 작업일지의 "대화 → 블록"과 짝이 맞게 */
  label: string;
  /** 실행 단추 */
  make: string;
  /** 모델에 주는 서식별 지침 */
  guide: (company: string) => string;
  /** questions에 무엇을 적을지 */
  questions: string;
  /** 서술 칸 위에 보여 주는 "적으면 좋은 것" */
  asks: string[];
  /** 서술 칸의 예시(합성 값) */
  placeholder: string;
  /** 본문에 있어야 논리가 서는 단락 — 서술에 없어 빠지면 확인할 점으로 알린다 */
  parts: Array<{ part: BodyPart; missing: string }>;
}

const CRE_SPEC: ComposeSpec = {
  label: '서술 → 문의',
  make: '문의 글 만들기',
  guide: (company) => `상황: ${company} 기술지원 엔지니어가 제조사 지원팀에 고객사 기술 문의를 보내는 메일이다. 받는 사람은 제조사 지원 엔지니어이고, 이 메일만 읽고 바로 조사·답변할 수 있어야 한다. 엔지니어가 고객에게 받은 문의, 발생한 이슈, 스스로 확인하거나 검토한 내용을 순서 없이 적은 글(또는 붙여 넣은 대화)을 받아 아래 칸에 맞는 논리적인 문의 글로 옮긴다.
- 메일 제목(topic): "[${company}] 핵심 현상 또는 요청 (고객사)" 한 줄. 내용의 끝말로 무엇을 원하는지 드러낸다 — "문의"·"개선요청"·"확인요청". 고객사를 알 수 없으면 끝의 괄호를 뺀다.
- 도입 문장(intro): 존댓말 한 문장. 어느 고객사를 지원하다 어떤 종류의 문의·요청이 있었는지만 말하고 "메일 드립니다."로 끝낸다.
- 이슈(issue): 무엇이 문제인지(또는 무엇을 묻는지) 한 줄 요약. 요청내용 맨 위에 굵은 줄로 들어가므로 본문에서 같은 문장을 되풀이하지 않는다.
- 요청내용(body): 아래 순서의 단락으로 쓴다. 서술에 근거가 없는 단락은 만들지 않는다.
  1) part "issue" — 발생한 이슈: 무엇이 어떻게 동작하는지(현상), 언제·어떤 조건에서 그런지, 그래서 고객이 겪는 어려움. 존댓말 평서문 한두 문단. title은 빈 문자열.
  2) part "checked" — 엔지니어나 고객이 이미 확인·테스트·검토·시도한 내용과 그 결과, 검토한 해소 방안. title은 내용에 맞는 짧은 이름("확인 내용", "테스트 환경 확인내용", "조치 내용"). 서술에 그런 내용이 있을 때만 쓴다.
  3) part "ask" — 제조사지원에 묻거나 요청하는 것. title은 문의면 "확인 요청 사항", 개선 요청이면 "요청 사항". 질문·요청이 둘 이상이면 items에 하나씩 나누고, 한 질문의 세부 확인 사항은 그 item의 subs에 쓴다. 하나뿐이면 paras에 한 문단으로 쓴다. 문장은 "~ 확인 부탁드립니다.", "~ 검토 부탁드립니다."처럼 끝낸다.
  4) part "note" — 제조사지원가 답할 때 알아야 할 배경(고객이 왜 묻는지, 어떻게 쓰려는지). 서술에 있을 때만 쓴다.
- 표의 칸(OS·버전·계약 정보)에 들어가는 값은 표가 보여 준다. 본문에 따로 나열하지 않는다(현상을 설명하는 문장에 필요한 버전·이름은 써도 된다).
- 고객사 담당자 개인의 이름은 쓰지 않는다. "고객사에서", "담당자가"로 쓴다.`,
  questions: '제조사지원가 답하려면 더 필요해 보이는데 서술에 없는 정보(예: 재현 절차, 로그 파일, 발생 시각, 에이전트 버전)만 짧게, 최대 5개.',
  asks: ['어느 고객사·프로젝트의 일인지', '무엇이 어떻게 되는지(발생한 이슈)', '언제·어떤 조건에서 그런지', '확인·테스트하거나 검토해 본 것과 그 결과', '제조사지원에 묻거나 요청할 것', '버전·OS처럼 표에 들어갈 값'],
  placeholder:
    '가나스토어 관제개발팀에서 문의. 서버 모니터링 디스크 사용률 이벤트가 임계치 80%를 넘어도 10분쯤 늦게 옴.\n에이전트는 2.9.5, 수집서버는 collector-x.y.z (RHEL 8.10).\n수집 주기를 5초로 바꿔 봤는데 똑같았고, 다른 프로젝트는 바로 옴.\n늦게 오는 게 정상 동작인지, 줄일 수 있는 설정이 있는지 확인 필요.',
  parts: [
    { part: 'issue', missing: '발생한 이슈(현상)가 서술에 드러나지 않아 그 단락은 만들지 않았습니다.' },
    { part: 'checked', missing: '확인·검토하거나 시도한 내용이 서술에 없어 그 단락은 만들지 않았습니다 — 있으면 서술에 덧붙여 다시 만들거나 직접 적으세요.' },
    { part: 'ask', missing: '제조사지원에 묻거나 요청할 내용이 서술에 드러나지 않아 그 단락은 만들지 않았습니다.' },
  ],
};

const LICENSE_SPEC: ComposeSpec = {
  label: '서술 → 메일',
  make: '메일 글 만들기',
  guide: () => `상황: 발급된 제조사 수집서버 라이선스 키를 고객(또는 설치 담당자)에게 전달하는 메일이다. 받는 사람은 이 메일의 표에서 키를 복사해 수집서버 설치에 쓴다.
- 메일 제목(topic): 무엇을 전달하는지 한 줄. 문장으로 끝낸다("…전달드립니다.").
- 도입 문장(intro): 존댓말 한두 문장. 라이선스가 발급되어 전달한다는 것과, 받는 사람이 알아야 할 안내(용도·주의)만 쓴다.
- 라이선스 키와 날짜 칸은 받지 않았다. 서술에 그 값이나 ⟦KEY1⟧ 같은 자리표시가 있어도 어느 칸에도 옮겨 적지 않는다 — 사용자가 직접 넣는다.`,
  questions: '받는 사람이 이 메일만 보고 처리하기에 빠졌거나 헷갈릴 수 있는 점만 짧게, 최대 3개.',
  asks: ['어느 고객·프로젝트에 보내는지', '라이선스 유형(POC용 등)', '수집서버 IP', '받는 사람이 알아야 할 안내'],
  placeholder: '가나통신 관제개발팀(PoC) POC용 라이선스 발급돼서 전달. 수집서버 설치할 때 써야 하니 복사할 수 있게 표로 보낸다고 안내.',
  parts: [],
};

const INSTALL_SPEC: ComposeSpec = {
  label: '서술 → 메일',
  make: '메일 글 만들기',
  guide: () => `상황: 수집서버·에이전트·BMS 등의 설치·패치 파일 다운로드 링크를 전달하는 메일이다. 표 없이 본문이 메일 내용의 전부다.
- 메일 제목(topic): 무엇을 전달하는지 한 줄.
- 도입 문장(intro): 생략할 수 있는 한 문장. 서술에 그런 말이 없으면 돌려주지 않는다.
- 본문(body): 전달물마다 part "text" 단락 하나. paras의 한 문단에 "○○ 전달 드립니다." 한 줄과 그 아래 "- 라벨 : 링크" 줄들을 \\n으로 이어 쓴다. 라벨에는 서술에 적힌 버전·OS 표기를 괄호로 쓴다. 링크(⟦URL1⟧)·버전·파일명은 글자 그대로 둔다.
- 서술에 덧붙인 안내(설치 순서, 유의 사항)가 있으면 마지막에 part "text" 단락으로 쓴다. 없으면 만들지 않는다.`,
  questions: '받는 사람이 이 메일만 보고 처리하기에 빠졌거나 헷갈릴 수 있는 점만 짧게, 최대 3개.',
  asks: ['무엇을 전달하는지(제품·버전·OS)', '다운로드 링크', '받는 사람이 알아야 할 안내'],
  placeholder: '수집서버 3.1.1 설치파일이랑 서버모니터링 에이전트(Linux v2.9.5) 보냄.\n수집서버 https://files.example.com/server-3.1.1.tar.gz\n에이전트 https://files.example.com/agent/linux',
  parts: [],
};

const SPECS: Record<string, ComposeSpec> = {
  'tech-inquiry': CRE_SPEC,
  'license-delivery': LICENSE_SPEC,
  'install-delivery': INSTALL_SPEC,
};

function specFor(template: EmailTemplate): ComposeSpec {
  return (
    SPECS[template.id] ?? {
      label: '서술 → 메일',
      make: '메일 글 만들기',
      guide: () => `상황: "${template.name}" 서식의 업무 메일이다.${template.note ? ` (${template.note})` : ''}
- 글 칸과 본문을 받는 사람이 바로 이해하도록 간결한 존댓말로 쓴다. 각 칸의 example이 이 서식의 표준 표현이다.
- 본문은 part "text" 단락으로 쓴다.`,
      questions: '받는 사람이 이 메일만 보고 처리하기에 빠졌거나 헷갈릴 수 있는 점만 짧게, 최대 3개.',
      asks: ['누구에게 무엇을 알리거나 요청하는지', '날짜·수치·이름처럼 메일에 들어갈 사실'],
      placeholder: '',
      parts: [],
    }
  );
}

/** 화면에 쓰는 이름·안내 — 버튼, 실행 단추, 서술 칸의 안내 */
export function composeNames(template: EmailTemplate | undefined): Pick<ComposeSpec, 'label' | 'make' | 'asks' | 'placeholder'> {
  const s = template ? specFor(template) : CRE_SPEC;
  return { label: s.label, make: s.make, asks: s.asks, placeholder: s.placeholder };
}

function guideFor(template: EmailTemplate, company: string): string {
  const base = specFor(template).guide(company);
  const presets = (template.bodyPresets ?? []).slice(0, 6);
  if (presets.length === 0) return base;
  // 본문에 [문구 삽입]으로 넣는 표준 문구 — 본문은 이 모양으로 쓴다
  return `${base}
- 이 서식의 본문 표준 문구 (본문의 줄은 이 모양으로 쓴다):
${presets.map((p) => p.split('\n').map((l) => `    ${l}`).join('\n')).join('\n')}`;
}

export function composeSystem(template: EmailTemplate, company = site().company): string {
  return `당신은 기술지원 엔지니어가 편하게 적은 글을 업무 메일의 서식에 맞는 글로 옮겨 적는 편집자다. 서술에 있는 내용만으로 쓴다.

${guideFor(template, company || site().company)}

메일 한 통의 구성 (앱이 아래 순서로 조립한다)
${describeLayout(template)}
- 인사말·맺음말·서명은 앱이 붙인다. 도입 문장과 본문에 새로 넣지 않는다.

칸 규칙 (fields)
- role이 "prose"인 칸: 서술에서 그 칸에 들어갈 글을 쓴다. example은 이 서식에서 그 칸을 쓰는 표준 표현이다. 말투·길이·머리 표기를 거기에 맞추고, example에 든 내용(고객사·현상·제품)은 가져오지 않는다. value가 있으면 사용자가 이미 적어 둔 글이다 — 그 뜻을 살려 서술과 함께 다시 쓴다. 서술에 근거가 없으면 돌려주지 않는다.
- role이 "fill"인 칸: 그 값이 서술에 글자 그대로 적혀 있을 때만 그 글자 그대로 돌려준다. 추측하거나 바꿔 적지 않는다. options가 있으면 서술에 나온 낱말과 같은 보기만. value가 있는 칸은 이미 채워진 칸이다 — 돌려주지 않고, 글을 쓸 때 참고만 한다.
- 받지 않은 칸(날짜, 라이선스·키 같은 값)은 돌려주지 않는다.
- customers가 있으면 서술에 나온 고객사의 표준 표기다. 메일 제목의 괄호와 고객사 칸에는 이 표기를 쓴다.

본문 규칙 (body) — 단락의 배열. 단락 이름의 [ ]와 ■, 항목의 번호와 -, 참고의 ※, 단락 사이 빈 줄은 앱이 붙인다. 쓰지 않는다.
- part: "issue"(발생한 일·현상) | "checked"(확인·검토·시도한 내용) | "ask"(묻거나 요청하는 것) | "note"(참고) | "text"(그 밖의 글)
- title: 단락 이름 한 마디. 필요 없으면 빈 문자열.
- paras: 문단들. 한 문단 안에서 줄을 바꾸려면 \\n을 쓴다.
- items: 번호를 붙일 항목들 — text와 그 아래 세부 줄 subs. 없으면 빈 배열.
- 본문이 없는 서식이면 body는 빈 배열.

지킬 것
- 서술에 없는 사실·원인·결과·수치·검토 내용을 만들지 않는다. 확인하거나 시도한 내용이 서술에 없으면 그런 단락을 만들지 않는다 — 있는 것처럼 꾸미지 않는다.
- 버전·OS·수치·로그·설정값·명령어·파일명·제품명·고객사명은 서술에 적힌 글자 그대로 쓴다.
- ⟦IP1⟧ ⟦URL1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ ⟦P1⟧ 같은 자리표시는 가린 값이다(⟦P⟧는 사람 이름). 필요한 곳에 글자 그대로 쓰고, 새로 만들지 않는다.
- 인사("안녕하세요")·맺음("감사합니다")·메시지가 오간 시각·잡담은 버린다. 마크다운 기호를 쓰지 않는다.

questions: ${specFor(template).questions} 없으면 빈 배열.`;
}

export const COMPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'body', 'questions'],
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
    body: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'title', 'paras', 'items'],
        properties: {
          part: { type: 'string', enum: ['issue', 'checked', 'ask', 'note', 'text'] },
          title: { type: 'string' },
          paras: { type: 'array', items: { type: 'string' } },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'subs'],
              properties: { text: { type: 'string' }, subs: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

interface PlannedField {
  field: EmailField;
  role: FieldRole;
  /** 지금 칸의 값 — 보내지 않는 칸은 '' (값을 읽지도 않는다) */
  current: string;
  /** 마스킹한 지금 값 */
  value: string;
}

export interface ComposeInput {
  template: EmailTemplate;
  /** 지금 입력값 — 이미 채워진 칸을 알려 주고, 빈 칸만 채운다 */
  doc: EmailDocState;
  /** 서술 — 편하게 적은 글이나 붙여 넣은 대화 */
  text: string;
  /** 내 이름 (가림용) */
  myName?: string;
  /** 회사 — 제목 머리에 쓴다. 비면 설정의 기본값 */
  company?: string;
}

export interface ComposePlan {
  request: AiCompleteRequest;
  template: EmailTemplate;
  fields: PlannedField[];
  masker: Masker;
  maskedText: string;
  /** 보낸 내용(서술 + 지금 칸의 값, 마스킹 후) — 돌아온 글에 새로 생긴 숫자·버전·자리표시를 찾는 데 쓴다 */
  sentText: string;
  /** 서술 원문 — 사실 칸에 채울 값이 글자 그대로 있는지 본다 */
  sourceText: string;
  /** 서술과 고객사 칸에서 알아본 고객사의 표준 표기 */
  customers: string[];
}

/** 고객사 칸인가 — 표준 표기로 바꿔 넣는다 */
function isCustomerField(f: EmailField): boolean {
  return /customer/i.test(f.key) || /고객/.test(f.label);
}

/** 글에 나온, 표기를 아는 고객사의 표준 표기 (site-config의 별칭) */
function customersIn(text: string): string[] {
  const k = text.replace(/[\s/·.]/g, '').toLowerCase();
  return site()
    .customers.filter((a) => {
      a.pattern.lastIndex = 0;
      const hit = a.pattern.test(k) || k.includes(a.key);
      a.pattern.lastIndex = 0;
      return hit;
    })
    .map((a) => a.canonical);
}

export function planCompose(input: ComposeInput, model: AiModelId): ComposePlan | null {
  const { template, doc } = input;
  const text = input.text.trim();
  if (!text) return null;
  const masker = new Masker();
  // 대화를 붙여 넣기도 한다 — 대화 → 블록과 같은 규칙으로 이름을 가린다
  const names = [input.myName ?? '', ...speakerNames(text), ...titledNames(text)].flatMap((n) => n.split(/\s*[,·]\s*/));
  const hide = (s: string) => masker.mask(maskNames(s, names, masker));
  const maskedText = hide(text);
  const fields: PlannedField[] = template.sections.flatMap((s) =>
    s.fields.map((field) => {
      const role = fieldRole(field);
      // 보내지 않는 칸은 값을 읽지 않는다 (라이선스 키가 가림 사전에도 들어가지 않게)
      const current = role === 'locked' ? '' : (doc.fieldValues[field.key] ?? '');
      return { field, role, current, value: blank(current) ? '' : hide(current) };
    }),
  );
  const sent = fields.filter((f) => f.role !== 'locked');
  const customers = [...new Set([...customersIn(text), ...sent.filter((f) => isCustomerField(f.field) && !blank(f.current)).map((f) => canonicalClient(f.current))])];
  const payload = {
    template: template.name,
    ...(customers.length ? { customers } : {}),
    fields: sent.map((f) => {
      const example = f.role === 'prose' ? exampleOf(f.field) : '';
      return {
        key: f.field.key,
        label: f.field.label,
        role: f.role,
        ...(f.value ? { value: f.value } : {}),
        ...(example ? { example } : {}),
        ...(f.field.options?.length ? { options: f.field.options } : {}),
      };
    }),
  };
  const user = [
    `아래 서술을 "${template.name}" 서식에 맞는 글로 바꿔 JSON으로 돌려줘.`,
    '',
    JSON.stringify(payload, null, 1),
    '',
    '<서술>',
    maskedText,
    '</서술>',
  ].join('\n');
  return {
    request: {
      model,
      system: composeSystem(template, input.company),
      user,
      schema: COMPOSE_SCHEMA as unknown as Record<string, unknown>,
      effort: 'medium',
      maxTokens: Math.min(16000, 4000 + Math.ceil(maskedText.length * 1.5)),
    },
    template,
    fields,
    masker,
    maskedText,
    sentText: [maskedText, ...sent.map((f) => f.value)].join('\n'),
    sourceText: text,
    customers,
  };
}

interface BodySection {
  part: BodyPart;
  title: string;
  paras: string[];
  items: Array<{ text: string; subs: string[] }>;
}

interface ComposeResponse {
  fields: Array<{ key: string; value: string }>;
  body: BodySection[];
  questions: string[];
}

function isComposeResponse(v: unknown): v is ComposeResponse {
  const o = v as ComposeResponse;
  return !!o && Array.isArray(o.fields) && Array.isArray(o.body) && Array.isArray(o.questions);
}

/** 넣을 글 칸 하나 — 결과 화면에서 고칠 수 있다 */
export interface DraftField {
  key: string;
  label: string;
  /** 지금 칸에 적혀 있는 값 (비어 있으면 '') */
  before: string;
  value: string;
  /** 여러 줄을 쓸 수 있는 칸 */
  multiline: boolean;
}

/** 표의 빈 칸에 채울 값 하나 — 서술에 글자 그대로 있던 값 */
export interface DraftFill {
  key: string;
  label: string;
  value: string;
}

export interface ComposeResult {
  fields: DraftField[];
  fills: DraftFill[];
  /** 본문 초안 — 서식의 줄 모양([이름]·■·번호·※) 그대로인 글. 고친 뒤 bodyTextToHtml로 본문에 넣는다 */
  body: string;
  /** 사람이 꼭 봐야 할 것 — 서술에 없는 숫자, 알 수 없는 자리표시, 넣지 않은 값 */
  warnings: string[];
  /** 서술에 없어 만들지 않은 단락 */
  gaps: string[];
  /** 받는 쪽이 더 필요로 할 정보 */
  questions: string[];
  model: string;
  usage: AiUsage;
  usd: number;
  ms: number;
  fallbackUsed: boolean;
  masked: Record<string, number>;
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 모델이 지침과 달리 붙여 온 기호를 뗀다 — 기호는 앱이 붙인다 */
const cleanTitle = (s: string) =>
  s
    .trim()
    .replace(/^■\s*/, '')
    .replace(/^\[\s*([^\]]+?)\s*\]$/, '$1')
    .trim();
const cleanItem = (s: string) => s.trim().replace(/^\d{1,2}\s*[.)]\s+/, '');
const cleanSub = (s: string) => s.trim().replace(/^[-·•]\s*/, '');
const cleanNote = (s: string) => s.trim().replace(/^※\s*/, '');
const cleanPara = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

/** 단락 하나 → 서식의 줄 모양 (실제로 보낸 문의 메일과 같은 기호) */
function sectionText(s: BodySection): string {
  const paras = (s.paras ?? []).map(cleanPara).filter(Boolean);
  const items = (s.items ?? []).filter((it) => it.text.trim());
  const title = cleanTitle(s.title ?? '');
  const hasSubs = items.some((it) => it.subs.some((x) => x.trim()));
  // 항목이 하나뿐이고 세부 줄이 없으면 번호를 붙이지 않는다
  const single = items.length === 1 && !hasSubs;
  const numbered = items.map((it, n) => [`${n + 1}. ${cleanItem(it.text)}`, ...it.subs.filter((x) => x.trim()).map((x) => ` - ${cleanSub(x)}`)].join('\n'));
  // 묻는 항목과 세부 줄이 딸린 항목은 한 줄씩 띄우고, 확인한 것을 늘어놓은 짧은 목록은 붙여 쓴다
  const itemBlocks = single ? [cleanItem(items[0].text)] : s.part === 'ask' || hasSubs ? numbered : numbered.length ? [numbered.join('\n')] : [];
  if (s.part === 'ask') return [`■ ${title || '확인 요청 사항'}`, ...paras, ...itemBlocks].join('\n\n');
  if (s.part === 'note') return [...paras.map((p, i) => (i === 0 ? `※ ${cleanNote(p)}` : p)), ...itemBlocks].join('\n\n');
  const head = s.part === 'checked' ? `[${title || '확인 내용'}]` : title ? `[${title}]` : '';
  const blocks = [...paras, ...itemBlocks];
  if (!head) return blocks.join('\n\n');
  // 단락 이름은 첫 문단 바로 위 줄에 붙인다
  return [blocks.length ? `${head}\n${blocks[0]}` : head, ...blocks.slice(1)].join('\n\n');
}

/** 단락의 글만(앱이 붙이는 번호·기호 없이) — 서술에 없는 숫자·자리표시를 찾을 때 본다 */
function sectionRaw(s: BodySection): string {
  return [cleanTitle(s.title ?? ''), ...(s.paras ?? []).map(cleanPara), ...(s.items ?? []).flatMap((it) => [cleanItem(it.text), ...it.subs.map(cleanSub)])].join('\n');
}

const GREETING = /(?:^|\n)\s*안녕하세요|감사합니다\.?\s*$/;

/** 응답 → 고칠 수 있는 초안. 서술에 없는 숫자·알 수 없는 자리표시·근거 없는 채움은 경고로 남기거나 뺀다 */
export function renderCompose(plan: ComposePlan, res: Extract<AiCompleteResult, { ok: true }>): ComposeResult {
  if (!isComposeResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const { masker, template } = plan;
  const warnings: string[] = [];
  const known = new Set(tokensOf(plan.sentText));
  const um = (s: string) => masker.unmask(s);
  const check = (masked: string, where: string) => {
    const invented = missingFacts(masked, plan.sentText);
    if (invented.length) warnings.push(`${where}: 서술에 없는 숫자·버전 ${invented.slice(0, 3).join(', ')} — 확인하세요.`);
    const unknown = [...new Set(tokensOf(masked).filter((t) => !known.has(t)))];
    if (unknown.length) warnings.push(`${where}: 알 수 없는 자리표시 ${unknown.join(', ')} — 지우거나 고치세요.`);
  };

  const byKey = new Map(plan.fields.map((f) => [f.field.key, f]));
  const fields: DraftField[] = [];
  const fills: DraftFill[] = [];
  const seen = new Set<string>();
  for (const got of res.json.fields) {
    const pf = byKey.get(got.key);
    if (!pf || pf.role === 'locked' || seen.has(got.key)) continue;
    seen.add(got.key);
    const multiline = pf.field.type === 'textarea';
    const masked = (multiline ? got.value : got.value.replace(/\s*[\r\n]+\s*/g, ' ')).trim();
    if (!masked) continue;
    if (pf.role === 'prose') {
      check(masked, pf.field.label);
      if (GREETING.test(masked)) warnings.push(`${pf.field.label}: 인사말·맺음말은 앱이 붙입니다 — 들어 있으면 지우세요.`);
      const value = um(masked);
      if (value !== pf.current.trim()) fields.push({ key: pf.field.key, label: pf.field.label, before: blank(pf.current) ? '' : pf.current, value, multiline });
      continue;
    }
    // 채움 — 비어 있던 칸만, 근거가 서술에 글자 그대로
    if (!blank(pf.current)) continue;
    let value = um(masked);
    if (tokensOf(value).length) continue;
    const customer = isCustomerField(pf.field);
    if (customer) value = canonicalClient(value);
    if (pf.field.type === 'select' && !pf.field.options?.includes(value)) continue;
    const src = squash(plan.sourceText);
    const parts = pf.field.type === 'select' ? value.split(/\s*,\s*/) : [value];
    const found = parts.every((p) => src.includes(squash(p))) || (customer && plan.customers.includes(value));
    if (!found) {
      warnings.push(`${pf.field.label}: "${value}"은(는) 서술에 그대로 없는 값이라 넣지 않았습니다.`);
      continue;
    }
    fills.push({ key: pf.field.key, label: pf.field.label, value });
  }
  // 서식에 적힌 순서대로
  const order = new Map(plan.fields.map((f, i) => [f.field.key, i]));
  const byOrder = (a: { key: string }, b: { key: string }) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
  fields.sort(byOrder);
  fills.sort(byOrder);

  const sections = template.hasBody ? res.json.body.filter((s) => sectionRaw(s).trim()) : [];
  for (const s of sections) check(sectionRaw(s), template.bodyLabel ?? '요청내용');
  const bodyMasked = sections.map(sectionText).filter(Boolean).join('\n\n');
  if (GREETING.test(bodyMasked)) warnings.push(`${template.bodyLabel ?? '요청내용'}: 인사말·맺음말은 앱이 붙입니다 — 들어 있으면 지우세요.`);

  const have = new Set(sections.filter((s) => (s.paras ?? []).some((p) => p.trim()) || (s.items ?? []).some((it) => it.text.trim())).map((s) => s.part));
  const gaps = template.hasBody ? specFor(template).parts.filter((p) => !have.has(p.part)).map((p) => p.missing) : [];

  return {
    fields,
    fills,
    body: um(bodyMasked),
    warnings: [...new Set(warnings)],
    gaps,
    questions: res.json.questions.map((q) => um(q.trim())).filter(Boolean),
    model: res.model,
    usage: res.usage,
    usd: estimateUsd(res.model, res.usage),
    ms: res.ms,
    fallbackUsed: res.fallbackUsed,
    masked: masker.summary(),
  };
}

/** 되살리지 못한 자리표시가 남았는가 — 남은 글은 서식에 넣지 않는다 */
export function hasPlaceholder(text: string): boolean {
  return tokensOf(text).length > 0;
}

/**
 * 본문 초안(글) → 본문 HTML.
 * 빈 줄로 나뉜 덩어리가 한 문단, 덩어리 안의 줄바꿈은 그대로 줄바꿈. 단락 이름(`[확인 내용]`)과 제목(`■ 확인 요청 사항`) 줄은 굵게.
 * 번호(`1.`)·세부(` - `)·참고(`※`)는 글자 그대로 둔다 — 팀이 보내는 메일의 모양이다.
 */
export function bodyTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter((l) => l.trim())
        .map((l) => {
          const t = l.trim();
          if (/^■\s*\S/.test(t) || /^\[[^\]]+\]$/.test(t)) return `<strong>${escapeHtml(t)}</strong>`;
          // 들여 쓴 세부 줄 — 메일에서도 한 칸 들어가 보이게
          if (/^\s+[-·]\s/.test(l)) return `&nbsp;${escapeHtml(t)}`;
          return escapeHtml(t);
        })
        .join('<br>'),
    )
    .filter(Boolean)
    .map((p) => `<p>${p}</p>`)
    .join('');
}

/** 본문에 글이나 그림이 들어 있는가 */
export function hasBodyContent(html: string): boolean {
  return /<(?:img|table|pre)\b/i.test(html) || htmlToPlain(html).trim().length > 0;
}

export interface ComposePick {
  /** 넣을 칸 — 키 → 값 (결과 화면에서 고친 것) */
  fields: Record<string, string>;
  /** 넣을 본문(글) — 비면 본문은 그대로 둔다 */
  body?: string;
  /** 지금 본문에 내용이 있을 때 — 'above' 그 위에 넣기(기본) / 'replace' 바꾸기 */
  bodyMode?: 'above' | 'replace';
}

/** 고른 것만 넣은 새 문서. 날짜·라이선스 칸과 서식에 없는 칸은 건드리지 않는다 */
export function applyCompose(template: EmailTemplate, doc: EmailDocState, pick: ComposePick): EmailDocState {
  const roles = new Map(template.sections.flatMap((s) => s.fields).map((f) => [f.key, fieldRole(f)]));
  const fieldValues = { ...doc.fieldValues };
  let subject = doc.subject;
  for (const [key, raw] of Object.entries(pick.fields)) {
    const role = roles.get(key);
    const value = raw.trim();
    if (!role || role === 'locked' || !value || hasPlaceholder(value)) continue;
    fieldValues[key] = value;
    // 제목에 들어가는 칸을 넣었으면 직접 고쳐 둔 제목은 자동으로 돌린다 — 새 제목이 보이게
    if (template.subjectPattern.includes(`{${key}}`)) subject = undefined;
  }
  let bodyHtml = doc.bodyHtml;
  const body = (pick.body ?? '').trim();
  if (template.hasBody && body && !hasPlaceholder(body)) {
    const html = bodyTextToHtml(body);
    bodyHtml = pick.bodyMode !== 'replace' && hasBodyContent(doc.bodyHtml) ? `${html}${doc.bodyHtml}` : html;
  }
  return { ...doc, fieldValues, bodyHtml, subject };
}
