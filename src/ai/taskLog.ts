/**
 * 할 일 메모 → 작업일지 후속 블록 — 할 일을 처리하고 남긴 짧은 메모를, 그 사안의 이전 일지 블록과 주고받은 메일에 대조해
 * 오늘 일지에 덧붙일 블록(▶ - >)으로 정리한다. 전에는 "▶ 처리 완료" 한 줄만 적었다(v0.29.0).
 *
 * - 형식과 문체는 대화 → 블록(worklogAi.ts)과 같다 — 같은 파일에 섞이므로 문체 규칙(blockStyle)을 함께 쓴다.
 * - ■ 머리줄은 앱이 정한다(원래 사안의 후속 표시). 모델은 그 아래 줄만 쓴다.
 * - 메일은 main이 거르는 도구(sanitizer)를 거친 글만 준다 — `sanitized` 표시가 없는 글은 보내지 않는다.
 *   걸러진 값의 표식(`[IP주소]`·`[사용자]` 등)은 일지에 옮겨 적지 않게 하고, 들어오면 경고한다(일일 루틴과 같은 규칙).
 * - 메모·이전 기록(내가 쓴 글)과 메일의 사람 이름·URL은 앱이 자리표시로 가려 보내고 돌아온 글에서 되살린다.
 */
import type { AiCompleteRequest, AiModelId } from '../../electron/ai-types';
import { site } from '../core/site-config';
import { lineStatus } from '../planner/status';
import type { MailMessage } from '../planner/types';
import { Masker, tokensOf } from './mask';
import { aiMeta, inventedIn, type AiMeta, type OkResult } from './result';
import { blockStyle, cleanRequester, maskNames, titledNames } from './worklogAi';

/** 거르는 도구가 남기는 표식 — 일지에 쓰지 않는다 */
export const SANITIZED_MARK_RE = /\[(?:IP주소|IPv6|MAC주소|사용자|전화번호|호스트명|호스트|내부URL|프로젝트코드|라이선스키|UUID|MASKED|API키|ARN|접속문자열|주민번호|사업자번호|개인키블록)\]/;

/** 메일을 이만큼만 보낸다 — 넘으면 첫 메일과 최근 메일 위주로 */
const MAIL_MAX_CHARS = 24_000;

export function taskLogSystem(company = site().company): string {
  return `당신은 ${company} 기술지원 엔지니어의 작업일지를 정리하는 편집자다. 엔지니어가 할 일 하나를 처리하고 남긴 짧은 메모를, 그 일의 근거 자료(전에 작업일지에 적어 둔 사안 블록, 주고받은 메일)와 대조해 오늘 작업일지에 덧붙일 후속 블록으로 정리한다. 작업일지는 나중에 주간보고와 지식베이스의 근거가 되는 1차 기록이다.

받는 것
- <메모>: 엔지니어가 직접 적은 것 — 이번에 한 일의 중심이다. 짧고 줄임말이 많다.
- <이전 기록>: 같은 사안이 전에 작업일지에 적힌 블록(날짜별). 이미 기록된 일이다.
- <메일>: 그 사안으로 주고받은 메일(오래된 것부터). [나]는 엔지니어가 보낸 메일, [상대]는 받은 메일이다.

후속 블록의 모양 (■ 머리줄·기호·빈 줄은 앱이 붙인다)
※ 배경·참고 한 줄
▶ 내가 한 일
- 그 결과 확정된 사실
  > 그 사실에 꼭 필요한 부연
※ 전달물 이름
(전달물 원문)

칸의 뜻
- acts(▶): 이전 기록 뒤에 엔지니어(나)가 한 일만, 시간 순서로. 메모에 적힌 일을 중심으로 쓰고, 메일에서 [나]가 보낸 문의·회신·안내·자료 전달은 한 일로 쓴다. [상대]가 보낸 메일은 그것을 받아 내가 한 일로 쓴다(예: "제조사지원 회신 내용 확인", "원인 및 조치 방법 고객 안내").
- facts(-): 그 ▶의 결과로 확정된 사실 — 원인 한 줄, 조치 한 줄, 대상·버전·파일명·설정값, 결정 사항, 현재 상태. 메모의 줄임말은 메일·이전 기록에 적힌 정확한 이름·버전·수치로 풀어 쓴다. 상태는 줄 끝에 " — 안내 완료"처럼 붙인다.
- details(>): 그 사실을 이해하는 데 꼭 필요한 부연 한 줄씩.
- notes(※): 머리줄 바로 아래에 두는 배경·참고 — 메모·메일에 그렇게 적혀 있는 것만. 필요할 때만, 많아야 두 줄.
- deliverables(※ 전달물): 엔지니어가 직접 작성해 상대에게 보낸 쿼리·스크립트·설정 스니펫·명령어 묶음. raw에는 메모나 [나]의 메일에 있는 원문을 한 글자도 바꾸지 않고 그대로 넣는다. 없으면 빈 배열.

대조 규칙
- 이전 기록에 이미 있는 일·사실은 되풀이하지 않는다. 그 뒤에 새로 한 일과 새로 확정된 사실만 쓴다.
- 메모와 메일이 같은 일을 가리키면 하나로 쓴다 — 메모의 말에 메일의 정확한 값을 채운다.
- 메모에는 있는데 메일·이전 기록에 없는 일은 메모 그대로 쓴다. 엔지니어가 직접 적은 것이므로 사실로 본다.
- 메모와 메일이 어긋나면(메모는 "적용 완료"인데 메일은 "적용 예정") 지어 맞추지 말고 메모대로 쓰고, 어긋난 점을 questions에 쓴다.
- 메일이 이 할 일과 다른 사안으로 보이면 메일의 내용을 쓰지 말고 questions에 그렇게 쓴다.
- 상태가 "끝냄"이면 마지막 ▶ 묶음의 끝 사실에 결과를 드러내는 상태를 붙인다(" — 안내 완료", " — 적용 완료", " — 해소"). 메모·메일로 무엇이 끝났는지 알 수 없으면 붙이지 않는다.
- 메모가 비어 있고 메일·이전 기록으로도 이번에 한 일을 알 수 없으면 acts를 비운다.

${blockStyle('메모·메일')}

지킬 것
- 메모·메일·이전 기록에 없는 사실·원인·결과·수치를 만들지 않는다. 버전·파일명·서버명·Job명·명령어·설정값·수치는 글자 그대로 쓴다.
- ⟦IP1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ ⟦P1⟧ 같은 자리표시는 가린 값이다(⟦P⟧는 사람 이름). 필요한 곳에 글자 그대로 쓴다. ⟦URL1⟧은 전달물 원문에만 둔다. 문장 안에서 사람을 가리킬 때는 글에 쓰인 호칭을 붙여도 된다("⟦P2⟧ 책임님에게 안내").
- [IP주소]·[사용자]·[전화번호]·[호스트명]·[내부URL]·[프로젝트코드]·[라이선스키]·[UUID]·[MASKED] 같은 대괄호 표식은 메일에서 이미 지워진 값이다. 일지에 옮겨 적지 않는다 — 그 표현을 빼거나 "대상 서버 2대"처럼 일반 낱말로 쓴다.
- questions: 사람이 직접 확인해야 할 점(메모와 메일이 어긋난 곳, 수행 여부가 불분명한 곳)만 짧게. 없으면 빈 배열.`;
}

export const TASKLOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes', 'acts', 'deliverables', 'questions'],
  properties: {
    notes: { type: 'array', items: { type: 'string' } },
    acts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'facts'],
        properties: {
          text: { type: 'string' },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'details'],
              properties: { text: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'raw'],
        properties: { name: { type: 'string' }, raw: { type: 'string' } },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** 고른 메일 스레드 — main이 거르는 도구를 거쳐 준 것 */
export interface TaskLogMail {
  subject: string;
  messages: MailMessage[];
  sanitized: true;
}

export interface TaskLogInput {
  today: string;
  /** 할 일 제목 */
  title: string;
  /** 끝낸 할 일인가 */
  done: boolean;
  /** ■ 머리줄 — 앱이 정한다(원래 사안의 후속 표시 포함) */
  head: string;
  memo: string;
  /** 같은 사안의 이전 일지 블록 — 날짜순. 없으면 [] */
  cases: ReadonlyArray<{ date: string; text: string }>;
  /** 고른 메일 — 없으면 null */
  mail: TaskLogMail | null;
  myName: string;
  /** 가릴 이름 — 할 일의 요청자, 일지의 요청자 */
  knownNames: readonly string[];
}

export interface TaskLogPlan {
  request: AiCompleteRequest;
  masker: Masker;
  /** 보낸 글 전체(가린 뒤) — 돌아온 글에 새로 생긴 숫자·자리표시를 찾는 데 쓴다 */
  sentText: string;
  input: TaskLogInput;
  /** 메일이 길어 일부만 보냈다 */
  mailCut: boolean;
}

/** `"홍길동 책임" <[사용자]@abz.example>` → 이름 부분 `홍길동 책임` (이름이 없으면 '') */
function headerName(addr: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(addr);
  return (m ? m[1] : /@/.test(addr) ? '' : addr).trim();
}

/** 머리글의 이름 가운데 사람 이름으로 보이는 것 — 한글 2~4자(호칭을 뗀 뒤) 또는 `First Last`. 팀·그룹 이름("제조사 지원")은 가리지 않는다 */
function personNames(messages: readonly MailMessage[]): string[] {
  const out = new Set<string>();
  for (const m of messages) {
    for (const part of [m.from, ...m.to.split(/,(?![^<]*>)/)]) {
      const name = cleanRequester(headerName(part));
      if (/^[가-힣]{2,4}$/.test(name) || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

function mailText(messages: readonly MailMessage[], hide: (s: string) => string): { text: string; cut: boolean } {
  const label = (addr: string) => hide(headerName(addr)) || '(이름 없음)';
  const blocks = messages.map((m) => {
    const to = m.to
      .split(/,(?![^<]*>)/)
      .map((x) => headerName(x))
      .filter(Boolean)
      .slice(0, 4)
      .map(hide)
      .join(', ');
    const who = m.mine ? '나' : `상대 — ${label(m.from)}`;
    return `[${who}${to ? ` → ${to}` : ''}] ${m.date}\n${hide(m.body)}`.trim();
  });
  let total = blocks.reduce((n, b) => n + b.length, 0);
  if (total <= MAIL_MAX_CHARS) return { text: blocks.join('\n\n'), cut: false };
  // 길면 가운데(오래된 왕복)부터 뺀다 — 첫 메일(원 문의)과 최근 메일이 판단에 가장 쓸모 있다
  const keep = blocks.map(() => true);
  for (let i = 1; i < blocks.length - 1 && total > MAIL_MAX_CHARS; i++) {
    keep[i] = false;
    total -= blocks[i].length;
  }
  const kept = blocks.filter((_b, i) => keep[i]).map((b) => (b.length > MAIL_MAX_CHARS / 2 ? `${b.slice(0, MAIL_MAX_CHARS / 2)}\n[뒤는 길어 생략]` : b));
  return { text: kept.join('\n\n[사이의 메일 생략]\n\n'), cut: true };
}

/** 보낼 것이 없으면 null — 메모도 메일도 없으면 대조할 것이 없다 */
export function planTaskLog(input: TaskLogInput, model: AiModelId): TaskLogPlan | null {
  const memo = input.memo.trim();
  // 걸러졌다는 표시가 없는 메일은 쓰지 않는다
  const mail = input.mail?.sanitized === true && input.mail.messages.length > 0 ? input.mail : null;
  if (!memo && !mail) return null;
  const masker = new Masker();
  const allText = [memo, input.title, input.head, ...input.cases.map((c) => c.text), ...(mail ? mail.messages.map((m) => m.body) : [])].join('\n');
  const names = [...input.knownNames, input.myName, ...(mail ? personNames(mail.messages) : []), ...titledNames(allText)].flatMap((n) => n.split(/\s*[,·]\s*/));
  const hide = (s: string) => masker.mask(maskNames(s, names, masker));
  const parts: string[] = [
    `오늘: ${input.today}`,
    `할 일: ${hide(input.title)}`,
    `상태: ${input.done ? '끝냄 (이번에 마무리한 일이다)' : '진행 중 (아직 끝나지 않았다)'}`,
    `후속 블록의 머리줄(앱이 붙인다): ${hide(input.head)}`,
    '',
    '<메모>',
    memo ? hide(memo) : '(메모 없음)',
    '</메모>',
  ];
  if (input.cases.length) {
    parts.push('', '<이전 기록>', ...input.cases.map((c) => `[${c.date} 일지]\n${hide(c.text.trim())}`), '</이전 기록>');
  }
  let mailCut = false;
  if (mail) {
    const body = mailText(mail.messages, hide);
    mailCut = body.cut;
    parts.push('', `<메일 제목="${hide(mail.subject)}">`, body.text, '</메일>');
  }
  parts.push('', '메모를 이전 기록·메일과 대조해 오늘 일지에 덧붙일 후속 블록을 JSON으로 돌려줘.');
  const user = parts.join('\n');
  return {
    request: {
      model,
      system: taskLogSystem(),
      user,
      schema: TASKLOG_SCHEMA as unknown as Record<string, unknown>,
      effort: 'medium',
      maxTokens: Math.min(16000, 3000 + Math.ceil(user.length * 0.5)),
    },
    masker,
    sentText: user,
    input,
    mailCut,
  };
}

interface TaskLogResponse {
  notes: string[];
  acts: Array<{ text: string; facts: Array<{ text: string; details: string[] }> }>;
  deliverables: Array<{ name: string; raw: string }>;
  questions: string[];
}

function isTaskLogResponse(v: unknown): v is TaskLogResponse {
  const o = v as TaskLogResponse;
  return !!o && Array.isArray(o.notes) && Array.isArray(o.acts) && Array.isArray(o.deliverables) && Array.isArray(o.questions);
}

export interface TaskLogResult extends AiMeta {
  /** 오늘 일지에 덧붙일 블록 (■ 머리줄 포함) */
  text: string;
  warnings: string[];
  questions: string[];
  /** ▶ 줄 수 */
  acts: number;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const stripMark = (s: string) => s.trim().replace(/^(?:■|▶|※|-|>)\s*/, '');

/** 응답 → 일지 블록. 메모·메일에 없는 숫자, 알 수 없는 자리표시, 걸러진 값의 표식, 바뀐 전달물 원문은 경고로 남긴다 */
export function renderTaskLog(plan: TaskLogPlan, res: OkResult): TaskLogResult {
  if (!isTaskLogResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const { masker, sentText, input } = plan;
  const warnings: string[] = [];
  const known = new Set(tokensOf(sentText));
  const um = (s: string) => masker.unmask(stripMark(s));
  let urlWarned = false;
  let markWarned = false;
  const check = (s: string, where: string) => {
    const { numbers, tokens } = inventedIn(s, sentText, known);
    if (numbers.length) warnings.push(`${where}: 메모·메일에 없는 숫자·버전 ${numbers.slice(0, 3).join(', ')} — 확인하세요.`);
    if (tokens.length) warnings.push(`${where}: 알 수 없는 자리표시 ${tokens.join(', ')}`);
    if (/⟦URL\d+⟧/.test(s) && !urlWarned) {
      urlWarned = true;
      warnings.push('URL이 본문 줄에 들어갔습니다 — 작업일지에는 URL을 쓰지 않습니다(전달물 원문만 예외). 지우거나 전달물로 옮기세요.');
    }
    if (SANITIZED_MARK_RE.test(s) && !markWarned) {
      markWarned = true;
      warnings.push('메일에서 가려진 값의 표식([IP주소]·[사용자] 등)이 들어 있습니다 — 지우거나 실제 값을 직접 적으세요.');
    }
  };
  const lines: string[] = [input.head];
  for (const n of res.json.notes) {
    if (!n.trim()) continue;
    lines.push(`※ ${um(n)}`);
    check(n, '※');
  }
  let acts = 0;
  let closed = false;
  for (const a of res.json.acts) {
    if (!a.text.trim()) continue;
    acts++;
    lines.push('', `▶ ${um(a.text)}`);
    check(a.text, '▶');
    closed = lineStatus(um(a.text))?.cls === 'done';
    for (const f of a.facts ?? []) {
      if (!f.text.trim()) continue;
      lines.push(`- ${um(f.text)}`);
      check(f.text, '-');
      closed = lineStatus(um(f.text))?.cls === 'done';
      for (const d of f.details ?? []) {
        if (!d.trim()) continue;
        lines.push(`  > ${um(d)}`);
        check(d, '>');
      }
    }
  }
  if (acts === 0 && input.done) {
    // 한 일을 찾지 못했다 — 끝낸 할 일이면 전과 같이 완료만 적는다
    lines.push('', '▶ 처리 완료');
    acts = 1;
    closed = true;
    warnings.push('메모·메일에서 이번에 한 일을 찾지 못해 완료만 적었습니다 — 필요하면 직접 덧붙이세요.');
  }
  // 끝낸 할 일인데 마지막 줄이 닫는 상태로 끝나지 않으면 한 줄을 붙인다 — 홈이 이 사안을 다시 열린 후보로 올리지 않게
  if (input.done && acts > 0 && !closed) lines.push('- 처리 완료');
  for (const d of res.json.deliverables) {
    const raw = d.raw.replace(/\s+$/, '');
    if (!raw.trim()) continue;
    if (!squash(sentText).includes(squash(raw))) {
      warnings.push(`전달물 "${um(d.name)}"은 메모·메일의 원문과 달라 넣지 않았습니다 — 원문을 직접 붙여 넣으세요.`);
      continue;
    }
    if (SANITIZED_MARK_RE.test(raw) && !markWarned) {
      markWarned = true;
      warnings.push('메일에서 가려진 값의 표식([IP주소]·[사용자] 등)이 들어 있습니다 — 지우거나 실제 값을 직접 적으세요.');
    }
    lines.push('', `※ ${um(d.name)}`, masker.unmask(raw));
  }
  if (plan.mailCut) warnings.push('메일이 길어 첫 메일과 최근 메일 위주로 보냈습니다 — 빠진 경과가 없는지 확인하세요.');
  return {
    text: acts > 0 ? lines.join('\n') : '',
    warnings: [...new Set(warnings)],
    questions: res.json.questions.map((q) => masker.unmask(q.trim())).filter(Boolean),
    acts,
    ...aiMeta(res, masker),
  };
}
