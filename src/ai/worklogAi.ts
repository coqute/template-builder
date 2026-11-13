/**
 * 작업일지 AI — ① 메신저·카톡 대화를 붙여 넣으면 작업일지 블록(■ ▶ - > ※)으로 정리, ② 지금 일지의 문장 정돈.
 * 형식 규칙은 작업일지 루틴과 같다. 보내기 전에 IP·URL·메일·전화·키와
 * 사람 이름(일지의 요청자 어휘·내 이름·대화 줄 머리의 화자·직함이나 님이 붙은 이름)을 자리표시로 가리고,
 * 돌아온 글에서 되살린다. 호칭 없이 본문에만 나오는 처음 보는 이름은 알아낼 방법이 없어 그대로 나간다 —
 * 대화상자가 그렇게 안내한다.
 */
import type { AiCompleteRequest, AiCompleteResult, AiModelId } from '../../electron/ai-types';
import { Masker, missingFacts, tokensOf } from './mask';
import type { ReviewChange, ReviewData, ReviewNote } from './review';
import { estimateUsd } from './settings';
import { checkLine, stripLineIds } from './weeklyTidy';
import { parseCaseHeader, parseWorklog, type WlLineKind } from '../worklog/format';
import { site } from '../core/site-config';

type OkResult = Extract<AiCompleteResult, { ok: true }>;

/** 알고 있는 이름을 자리표시로 — 긴 이름부터(‘홍길’이 ‘홍길동’을 먼저 먹지 않게) */
export function maskNames(text: string, names: readonly string[], masker: Masker): string {
  let out = text;
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 && !/[⟦⟧]/.test(n)))].sort((a, b) => b.length - a.length);
  for (const n of list) {
    if (!out.includes(n)) continue;
    out = out.split(n).join(masker.reserve('P', n));
  }
  return out;
}

function maskAll(text: string, names: readonly string[], masker: Masker): string {
  return masker.mask(maskNames(text, names, masker));
}

const SURNAMES = '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반라왕금옥육인맹제모탁국어은편용';
const TITLES = '책임|부장|차장|과장|대리|선임|수석|사원|주임|전임|매니저|팀장|이사|대표|프로';
const PARTICLES = '께서|에게|한테|이랑|하고|으로|께|이|가|은|는|을|를|과|와|의|도|만|랑|로';
/** 성으로 시작하는 세 글자 + 직함·님 (+ 조사, '께도'처럼 둘까지) — 뒤가 낱말로 이어지면('프로세스'·'대리점') 이름이 아니다 */
const TITLED_NAME = new RegExp(`(?<![가-힣])([${SURNAMES}][가-힣][가-힣])(?=\\s?(?:(?:${TITLES})님?|님)(?:${PARTICLES}){0,2}(?![가-힣]))`, 'g');
/** 이름으로 보지 않는 것 — 끝이 조사('고객의')·조직('기술팀')이거나 직함·역할 낱말 */
const NOT_NAME = /[의는을를에과와가이도로팀]$|^(?:지사장|이사장|주무관|연구원|위원장|신청자|고객사)$/;

/**
 * 본문에서 직함·님이 붙어 불리는 이름 — `홍길동 책임님께`, `홍길동님이`, `박과장님`.
 * 일지에 없고 대화 줄 머리에도 없는 사람(제3자)의 이름을 가리기 위한 것이다.
 * 이름이 아닌 낱말이 걸려도 자리표시는 돌아온 글에서 원래 글자로 되살아나므로 결과는 달라지지 않는다.
 */
export function titledNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TITLED_NAME)) if (!NOT_NAME.test(m[1])) out.add(m[1]);
  return [...out];
}

// ── ① 대화 → 블록 ─────────────────────────────────────────────

/**
 * 형식 규칙의 출처는 작업일지 루틴의 STEP 4(사안별 묶기·핵심 추출)·STEP 5(파일 형식)다.
 * 루틴이 메일로 만드는 블록과 여기서 대화로 만드는 블록이 한 파일에 섞이므로 같은 규칙이어야 한다 (v0.13.2에서 다시 대조).
 */
export const BLOCK_SYSTEM = `당신은 ${site().company} 기술지원 엔지니어의 작업일지를 정리하는 편집자다. 엔지니어가 메신저·카카오톡 대화나 유선·현장·회의 메모를 붙여 넣으면, 거기서 엔지니어가 실제로 수행한 작업을 작업일지 블록으로 정리한다. 작업일지는 나중에 주간보고와 지식베이스의 근거가 되는 1차 기록이다.

블록 하나의 모양 (기호와 빈 줄은 앱이 붙인다)
■ (요청자/채널) 사안
※ 배경·참고·상태 한 줄
▶ 내가 한 일
- 그 결과 확정된 사실
  > 그 사실에 꼭 필요한 부연
※ 전달물 이름
(전달물 원문)

칸의 뜻
- title(■ 사안): 무엇을 해야 했는가 — 요청·문의·장애·패치 한 줄. 예: "프로세스 감시 이벤트 발송 설정 문의", "이상 탐지 v1.1.6 패치 적용", "수집서버 전체 프로젝트를 조회해 목록으로 만드는 방법 문의". '메시지 수신'·'안내 수신'처럼 받았다는 사실은 쓰지 않는다. 회의·방문 메모면 "{회의명} 회의", "{고객팀} 방문"으로 쓴다.
- requester: 요청한 사람(상대)의 이름. 대화에 자리표시(⟦P1⟧)로 있으면 그 자리표시를 그대로 쓴다. 여러 명이면 쉼표로. 요청자 없이 스스로 한 작업이나 회의·방문이면 빈 문자열.
- followup: 이 사안이 이전 날짜에 접수된 건의 후속이라는 것이 대화에 드러나 있을 때만 쓴다. 최초 접수일이 대화에 적혀 있으면 "M/D"(예: "10/15"), 날짜는 없고 후속인 것만 분명하면 "후속", 그 밖에는 빈 문자열.
- notes(※): ■ 바로 아래에 두는 배경·참고·지금 상태. 필요할 때만 쓰고 보통 한 줄, 많아야 두 줄. 예: "event DB 접속 불가로 담당자에게 조회 요청 예정".
- acts(▶): 엔지니어(나)가 한 일만, 시간 순서로 — 검토, 패치 적용, 오류 조치, 문의 발송, 원인·조치 방법 확인, 안내·회신, 자료 전달, 회의에서의 정리·협의. 상대가 보낸 안내·회신은 그것을 받아 내가 한 일로 쓴다(예: "원인 및 조치 방법 확인", "제조사지원 회신 내용 고객 안내").
- facts(-): 그 ▶의 결과로 확정된 사실 — 결정 사항, 대상 서버·pid·Job명, 버전·파일명, 원인 한 줄, 조치 한 줄, 현재 상태. "원인: …", "조치: …", "대상: …"처럼 머리말을 붙여도 된다. 상태는 줄 끝에 " — 제조사지원 회신 대기"처럼 붙인다.
- details(>): 그 사실을 이해하는 데 꼭 필요한 부연 한 줄씩.
- deliverables(※ 전달물): 엔지니어가 직접 작성해 상대에게 보낸 쿼리·스크립트·설정 스니펫·명령어 묶음. raw에는 대화에 있는 원문을 한 글자도 바꾸지 않고 그대로 넣는다. 전달물로 남긴 내용은 facts로 다시 요약하지 않는다(대상 범위·목적처럼 원문에 드러나지 않는 것만 사실 한 줄로 쓴다). 없으면 빈 배열.

문체
- 개조식, 명사형으로 끝낸다("~ 확인", "~ 안내", "~ 적용", "~하여 해소", "~ 확인 요청"). "~했습니다" 같은 문장 끝은 쓰지 않는다.
- 상태는 대화에 근거한 실제 상태만 쓴다: 안내 완료, 전달 완료, 패치 전달, 제조사지원 회신 대기, 고객 회신 대기, 문의 예정, 대응 예정, 조회 요청 예정, 적용 여부 확인 필요.
- 메시지가 오간 시각(14:31·오후 2시)과 요일은 어디에도 쓰지 않는다. 마크다운 기호·이모지·URL을 쓰지 않는다(전달물 원문 안은 예외).
- 정해진 일정은 대화에 적힌 날짜를 M/D로 쓴다("11/18 패치 적용 예정"). "다음 주 화요일"·"내일"처럼 날짜 없이 적힌 일정은 날짜를 계산해 넣지 말고 대화의 표현 그대로 쓰고, questions에 날짜 확인을 남긴다.
- 핵심만 쓴다. 분량은 내용이 정한다. 인사·잡담·확인 응답("네", "감사합니다"), 배경 설명, 상대의 사과·안내 문구는 버린다.
- 상대가 보낸 절차·설정 안내는 조치를 특정하는 최소한만 옮긴다 — 원인 한 줄과 조치 한 줄, 결정적인 키=값 한두 개. 옵션·명령어를 나열하지 않는다.

지킬 것
- 대화에 없는 사실·원인·결과·수치를 만들지 않는다. 버전·파일명·서버명·pid·Job명·명령어·수치는 글자 그대로, 빠뜨리지 않고 쓴다.
- ⟦IP1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ ⟦P1⟧ 같은 자리표시는 가린 값이다(⟦P⟧는 사람 이름). 필요한 곳에 글자 그대로 쓴다. ⟦URL1⟧은 전달물 원문에만 둔다. 문장 안에서 사람을 가리킬 때는 대화에 쓰인 호칭을 붙여도 된다("⟦P2⟧ 대리님에게 조회 요청 예정").
- 대화 안에 서로 다른 사안이 여럿이면 blocks를 여러 개로 나눈다. 한 사안에 관한 여러 메시지는 블록 하나로 묶는다. 시간 순서를 이유로 한 사안을 여러 블록으로 쪼개지 않는다.
- 엔지니어가 무엇을 했는지 대화로 알 수 없으면 acts를 비우고 notes에 상태만 쓴다: 요청·문의면 "대응 예정", 패치·설정 안내를 받았을 뿐이면 "현장 적용 여부 확인 필요".
- questions: 사람이 직접 확인해야 할 점(수행 여부가 불분명한 곳, 빠진 결과 등)만 짧게. 없으면 빈 배열.`;

export const BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks', 'questions'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requester', 'title', 'followup', 'notes', 'acts', 'deliverables'],
        properties: {
          requester: { type: 'string' },
          title: { type: 'string' },
          followup: { type: 'string' },
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
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface BlockInput {
  chat: string;
  channel: string;
  /** 사용자가 적은 요청자 (비면 모델이 대화에서 고른다) */
  requester: string;
  /** 대화 속 내 이름 — 내 메시지를 가려내는 데 쓴다 */
  myName: string;
  date: string;
  /** 일지의 요청자 어휘 — 이름 가림용 */
  knownNames: readonly string[];
}

export interface BlockPlan {
  request: AiCompleteRequest;
  masker: Masker;
  maskedChat: string;
  input: BlockInput;
}

/**
 * 대화 줄 머리의 화자 이름 — 카카오톡·메신저에서 복사한 모양(이름 + 시각)에서만 읽는다.
 * 일지에 아직 없는 사람(처음 대화한 담당자)의 이름도 가려서 보내기 위한 것이다.
 * `원인: …`처럼 이름처럼 보이는 낱말을 잘못 가리지 않도록, 시각이 붙은 줄 머리만 본다.
 */
export function speakerNames(chat: string): string[] {
  const out = new Set<string>();
  for (const line of chat.split(/\r?\n/)) {
    const t = line.trim();
    const m =
      // [홍길동] [오후 2:31] 내용 — 카카오톡 PC 복사
      /^\[([^\]\n]{2,20})\]\s*\[(?:오전|오후)?\s*\d{1,2}:\d{2}\]/.exec(t) ??
      // 2026. 10. 20. 오후 2:31, 홍길동 : 내용 — 카카오톡 내보내기
      /^\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*[.일]?\s*(?:오전|오후)?\s*\d{1,2}:\d{2}\s*,\s*([^:\n]{2,20}?)\s*:/.exec(t) ??
      // 홍길동 오후 2:31 — 이름과 시각만 있는 줄(메신저 복사)
      /^([가-힣]{2,5}(?:\s[가-힣]{1,4})?)\s+\[?(?:오전|오후)\s*\d{1,2}:\d{2}\]?$/.exec(t) ??
      // [오후 2:31] 홍길동 — 시각이 앞에 오는 줄(메신저 복사)
      /^\[(?:\d{4}[-./]\s?\d{1,2}[-./]\s?\d{1,2}\.?\s+)?(?:오전|오후)?\s*\d{1,2}:\d{2}\]\s*([가-힣]{2,5}(?:\s[가-힣]{1,4})?)$/.exec(t);
    if (!m) continue;
    const name = cleanRequester(m[1].replace(/\s*\([^)]*\)\s*$/, ''));
    if (name.length < 2 || name.length > 12 || /[\d⟦⟧]/.test(name)) continue;
    out.add(name);
    // '개발팀 홍길동'처럼 소속이 붙은 머리 — 본문에서는 이름만 불리므로 이름도 따로 가린다
    const last = name.split(/\s+/).pop() ?? '';
    if (last !== name && /^[가-힣]{2,4}$/.test(last)) out.add(last);
  }
  return [...out];
}

export function planBlockFromChat(input: BlockInput, model: AiModelId): BlockPlan | null {
  if (!input.chat.trim()) return null;
  const masker = new Masker();
  const names = [...input.knownNames, input.requester, input.myName, ...speakerNames(input.chat), ...titledNames(input.chat)].flatMap((n) => n.split(/\s*[,·]\s*/));
  const maskedChat = maskAll(input.chat.trim(), names, masker);
  const me = input.myName.trim() ? maskNames(input.myName.trim(), names, masker) : '';
  const requester = input.requester.trim() ? maskNames(input.requester.trim(), names, masker) : '';
  const user = [
    `일자: ${input.date}`,
    `채널: ${input.channel || '메신저'}`,
    me ? `대화 속 엔지니어(나): ${me}` : '대화 속 엔지니어(나): 알 수 없음 — 문맥으로 판단',
    requester ? `요청자: ${requester} (이 값을 requester로 쓴다)` : '요청자: 대화에서 고른다',
    '',
    '아래 대화를 작업일지 블록으로 정리해 JSON으로 돌려줘.',
    '<대화>',
    maskedChat,
    '</대화>',
  ].join('\n');
  const maxTokens = Math.min(16000, 3000 + Math.ceil(maskedChat.length * 1.2));
  return { request: { model, system: BLOCK_SYSTEM, user, schema: BLOCK_SCHEMA as unknown as Record<string, unknown>, effort: 'medium', maxTokens }, masker, maskedChat, input };
}

interface BlockResponse {
  blocks: Array<{
    requester: string;
    title: string;
    followup?: string;
    notes: string[];
    acts: Array<{ text: string; facts: Array<{ text: string; details: string[] }> }>;
    deliverables: Array<{ name: string; raw: string }>;
  }>;
  questions: string[];
}

function isBlockResponse(v: unknown): v is BlockResponse {
  const o = v as BlockResponse;
  return !!o && Array.isArray(o.blocks) && Array.isArray(o.questions);
}

const HONORIFIC_TAIL = /\s*(님|책임|부장|차장|과장|대리|선임|수석|사원|주임|전임|매니저|팀장|이사|대표|프로)$/;
const squash = (s: string) => s.replace(/\s+/g, '');

/** 출처 괄호 이름 — 호칭 떼기 */
export function cleanRequester(s: string): string {
  return s
    .split(/\s*[,·]\s*/)
    .map((n) => {
      // '대리님'처럼 겹친 호칭까지 — 더 떼어지지 않을 때까지
      let s = n.trim();
      for (let prev = ''; prev !== s; ) [prev, s] = [s, s.replace(HONORIFIC_TAIL, '').trim()];
      return s;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * ■ 끝의 후속 표시 — 루틴 형식: `(M/D 문의 후속)`(최초 접수일을 알 때) 또는 `(후속)`.
 * 날짜는 대화에 그 날짜가 적혀 있을 때만 쓴다(지어낸 날짜를 일지에 남기지 않는다).
 */
export function followSuffix(raw: string | undefined, chat: string): string {
  const f = (raw ?? '').trim();
  if (!f) return '';
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(f);
  if (!m) return ' (후속)';
  const mo = Number(m[1]);
  const d = Number(m[2]);
  // 2.10.15 같은 버전 안의 숫자를 날짜로 읽지 않는다
  const seen = new RegExp(`(?<![\\d.])0?${mo}\\s*[/.월-]\\s*0?${d}(?!\\d|\\.\\d)`).test(chat);
  return seen ? ` (${mo}/${d} 문의 후속)` : ' (후속)';
}

export interface BlockResult {
  text: string;
  warnings: string[];
  questions: string[];
  model: string;
  usd: number;
  ms: number;
  masked: Record<string, number>;
  blocks: number;
}

/** 응답 → 작업일지 텍스트. 원문에 없는 숫자·되살리지 못한 자리표시·바뀐 전달물 원문은 경고로 남긴다 */
export function renderBlocks(plan: BlockPlan, res: OkResult): BlockResult {
  if (!isBlockResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const { masker, maskedChat, input } = plan;
  const warnings: string[] = [];
  const out: string[] = [];
  const known = new Set(tokensOf(maskedChat));
  const srcFacts = maskedChat;
  const um = (s: string) => masker.unmask(s.trim());
  let urlWarned = false;
  const checkInvented = (s: string, where: string) => {
    const invented = missingFacts(s, srcFacts);
    if (invented.length) warnings.push(`${where}: 대화에 없는 숫자·버전 ${invented.slice(0, 3).join(', ')} — 확인하세요.`);
    const unknown = tokensOf(s).filter((t) => !known.has(t));
    if (unknown.length) warnings.push(`${where}: 알 수 없는 자리표시 ${unknown.join(', ')}`);
    // 일지 본문에는 URL을 쓰지 않는다(전달물 원문만 예외) — 넣기 전에 사람이 지우거나 옮기게 알린다
    if (/⟦URL\d+⟧/.test(s) && !urlWarned) {
      urlWarned = true;
      warnings.push('URL이 본문 줄에 들어갔습니다 — 작업일지에는 URL을 쓰지 않습니다(전달물 원문만 예외). 지우거나 전달물로 옮기세요.');
    }
  };
  for (const b of res.json.blocks) {
    if (!b.title.trim()) continue;
    const who = cleanRequester(um(b.requester || input.requester));
    const channel = input.channel.trim() || '메신저';
    const title = `${um(b.title)}${followSuffix(b.followup, maskedChat)}`;
    const head = who ? `■ (${who}/${channel}) ${title}` : `■ ${title}`;
    checkInvented(b.title, '사안');
    const lines: string[] = [head];
    for (const n of b.notes) {
      if (!n.trim()) continue;
      lines.push(`※ ${um(n)}`);
      checkInvented(n, '※');
    }
    for (const a of b.acts) {
      if (!a.text.trim()) continue;
      lines.push('', `▶ ${um(a.text)}`);
      checkInvented(a.text, '▶');
      for (const f of a.facts) {
        if (!f.text.trim()) continue;
        lines.push(`- ${um(f.text)}`);
        checkInvented(f.text, '-');
        for (const d of f.details) {
          if (!d.trim()) continue;
          lines.push(`  > ${um(d)}`);
          checkInvented(d, '>');
        }
      }
    }
    for (const d of b.deliverables) {
      const raw = d.raw.replace(/\s+$/, '');
      if (!raw.trim()) continue;
      // 전달물은 원문 그대로여야 한다 — 대화 안에 글자 그대로 없으면 넣지 않는다
      if (!squash(maskedChat).includes(squash(raw))) {
        warnings.push(`전달물 "${um(d.name)}"은 대화 원문과 달라 넣지 않았습니다 — 원문을 직접 붙여 넣으세요.`);
        continue;
      }
      lines.push('', `※ ${um(d.name)}`, masker.unmask(raw));
    }
    out.push(lines.join('\n'));
  }
  return {
    text: out.join('\n\n'),
    warnings,
    questions: res.json.questions.map((q) => um(q)).filter(Boolean),
    model: res.model,
    usd: estimateUsd(res.model, res.usage),
    ms: res.ms,
    masked: masker.summary(),
    blocks: out.length,
  };
}

// ── ② 일지 문장 정돈 ──────────────────────────────────────────

const TIDY_KINDS: Partial<Record<WlLineKind, string>> = {
  case: '사안(■)',
  note: '참고(※)',
  act: '수행(▶)',
  fact: '사실(-)',
  detail: '부연(>)',
};

interface TidyLine {
  id: string;
  no: number;
  kind: WlLineKind;
  /** 마커·출처 괄호를 뺀 원문 */
  text: string;
  prefix: string;
  suffix: string;
  group: string;
}

export interface WorklogTidyPlan {
  request: AiCompleteRequest;
  masker: Masker;
  lines: TidyLine[];
  maskedById: Map<string, string>;
}

/** 줄 → 앞(마커·출처)/본문/뒤(끝 표시) — 적용할 때 앞뒤는 그대로 둔다 */
export function splitLine(raw: string, kind: WlLineKind): { prefix: string; text: string; suffix: string } | null {
  if (kind === 'case') {
    const body = raw.replace(/^■\s*/, '');
    const { title } = parseCaseHeader(body);
    if (!title) return null;
    const at = raw.indexOf(title, raw.length - body.length);
    if (at < 0) return null;
    return { prefix: raw.slice(0, at), text: title, suffix: raw.slice(at + title.length) };
  }
  const re = kind === 'act' ? /^▶\s*/ : kind === 'fact' ? /^-\s+/ : kind === 'detail' ? /^\s*>\s?/ : kind === 'note' ? /^※\s*/ : null;
  const m = re?.exec(raw);
  if (!m) return null;
  const text = raw.slice(m[0].length).replace(/\s+$/, '');
  if (!text.trim()) return null;
  return { prefix: m[0], text, suffix: raw.slice(m[0].length + text.length) };
}

export const TIDY_SYSTEM = `당신은 ${site().company} 기술지원 엔지니어의 작업일지를 다듬는 편집자다. 작업일지는 사안(■) 아래 수행(▶)을 시간순으로, 그 결과 확정된 사실(-)과 부연(>), 참고(※)를 줄 단위로 적은 업무 기록이다.

목표: 각 줄을 나중에 다시 읽는 사람이 한 번에 이해하도록 간결하고 정확한 개조식 문장으로 다듬는다.

문체
- 명사형으로 끝낸다("~ 확인", "~ 안내", "~ 적용", "~ 요청", "~ 예정"). "~했습니다", "~함" 같은 끝은 명사형으로 바꾼다.
- 맞춤법·띄어쓰기·오탈자를 고치고 군더더기와 같은 말 반복을 줄인다. 시각·요일은 쓰지 않는다.

지킬 것
- 사실을 바꾸거나 더하지 않는다. 원문에 없는 원인·결과·수치를 만들지 않는다. 뜻이 모호하면 원문 표현을 살린다.
- 숫자·버전·파일명·명령어·설정값·서버명·Job명·제품명·고객사명은 글자 그대로 둔다.
- ⟦IP1⟧ ⟦URL1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ ⟦P1⟧ 같은 자리표시는 가린 값(⟦P⟧는 사람 이름)이다. 글자 그대로, 같은 개수만큼 남긴다.
- 줄을 합치거나 나누거나 지우지 않는다. 받은 모든 줄을 같은 id로 돌려주고, 고칠 것이 없으면 원문 그대로 돌려준다.

notes
- 같은 사안으로 보이는 ■가 둘로 나뉜 곳, ▶가 비어 수행 내용을 보강해야 할 사안, 줄 종류가 내용과 맞지 않는 곳처럼 사람이 판단할 점만 짧게. 최대 5개. 없으면 빈 배열.
- 사람이 읽는 글이다. id는 쓰지 말고 가리킬 줄은 내용을 짧게 인용한다.`;

export const TIDY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'notes'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function planWorklogTidy(text: string, knownNames: readonly string[], model: AiModelId): WorklogTidyPlan | null {
  const doc = parseWorklog(text);
  const masker = new Masker();
  const lines: TidyLine[] = [];
  const maskedById = new Map<string, string>();
  const groupOf = new Map<number, string>();
  for (const b of doc.blocks) groupOf.set(b.index, b.kind === 'case' ? `■ ${b.header}` : `${b.title}`);
  // 요청자 어휘에 없는 사람도 직함·님이 붙어 있으면 가린다 (대화 → 블록과 같은 규칙)
  const names = [...knownNames, ...titledNames(text)];
  for (const l of doc.lines) {
    if (!TIDY_KINDS[l.kind]) continue;
    const parts = splitLine(l.text, l.kind);
    if (!parts) continue;
    const id = `L${l.no}`;
    lines.push({ id, no: l.no, kind: l.kind, ...parts, group: groupOf.get(l.block) ?? '(사안 밖)' });
    maskedById.set(id, maskAll(parts.text, names, masker));
  }
  if (lines.length === 0) return null;
  const payload = lines.map((l) => ({ id: l.id, kind: TIDY_KINDS[l.kind], text: maskedById.get(l.id) }));
  const user = `아래 작업일지 줄들을 규칙대로 다듬어 같은 id의 JSON으로 돌려줘.\n\n${JSON.stringify({ date: doc.titleLine?.date ?? '', lines: payload }, null, 1)}`;
  const maxTokens = Math.min(32000, 3000 + Math.ceil(user.length * 1.4));
  return {
    request: { model, system: TIDY_SYSTEM, user, schema: TIDY_SCHEMA as unknown as Record<string, unknown>, effort: 'medium', maxTokens },
    masker,
    lines,
    maskedById,
  };
}

function isTidyResponse(v: unknown): v is { lines: Array<{ id: string; text: string }>; notes: string[] } {
  const o = v as { lines: unknown; notes: unknown };
  return !!o && Array.isArray(o.lines) && Array.isArray(o.notes);
}

const LEADING_MARK = /^\s*(?:■|▶|※|-|>)\s*/;

export function reviewWorklogTidy(plan: WorklogTidyPlan, res: OkResult): ReviewData {
  if (!isTidyResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const { masker, lines, maskedById } = plan;
  const got = new Map(res.json.lines.map((l) => [l.id, l.text]));
  const changes: ReviewChange[] = [];
  for (const l of lines) {
    const raw = got.get(l.id);
    if (raw === undefined) continue;
    const before = maskedById.get(l.id) ?? '';
    const after = raw.replace(LEADING_MARK, '').trim();
    if (after === before.trim()) continue;
    const reason = checkLine(before, after);
    changes.push({
      id: l.id,
      group: masker.unmask(l.group) || l.group,
      label: `${l.no}행 ${TIDY_KINDS[l.kind] ?? ''}`,
      before: masker.unmask(before),
      after: masker.unmask(after),
      ok: !reason,
      reason,
    });
  }
  const notes: ReviewNote[] = res.json.notes
    .map((n) => masker.unmask(stripLineIds(n.replace(/\bL\d+\b/g, ''))))
    .filter(Boolean)
    .map((text) => ({ group: '', text }));
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

/** 고른 줄만 바꾼 새 본문 — 줄 번호가 그대로인 원문에만 적용한다 */
export function applyWorklogTidy(text: string, plan: WorklogTidyPlan, review: ReviewData, picked: Set<string>): string {
  const lines = text.split('\n');
  const byId = new Map(plan.lines.map((l) => [l.id, l]));
  for (const c of review.changes) {
    if (!c.ok || !picked.has(c.id)) continue;
    const l = byId.get(c.id);
    if (!l) continue;
    lines[l.no - 1] = `${l.prefix}${c.after}${l.suffix}`;
  }
  return lines.join('\n');
}
