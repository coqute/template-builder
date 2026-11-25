/** AI 호출(Claude API) — renderer ↔ main IPC 계약. 키는 main에만 있고 renderer로 돌아가지 않는다. */

/**
 * 지금 주력 모델(강한 순) — 단가·설명은 src/ai/settings.ts.
 * 이 목록에 없는 모델도 Models API(이 키에서 열린 모델 목록)에 있으면 고를 수 있다 — 새 모델이 나와도 앱을 다시 내지 않는다.
 */
export const AI_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type KnownAiModelId = (typeof AI_MODELS)[number];
export type AiModelId = KnownAiModelId | (string & {});

/** 모델 id 모양 — main이 보내기 전에 확인한다(임의 문자열을 API로 넘기지 않게) */
export const AI_MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{1,60}$/;

export function isKnownModel(model: string): model is KnownAiModelId {
  return (AI_MODELS as readonly string[]).includes(model);
}

export type AiEffort = 'low' | 'medium' | 'high';

export interface AiCompleteRequest {
  /** 진행 상황·취소를 이 요청에 묶는 값 — renderer가 만든다(없으면 진행 알림·취소 없음) */
  id?: string;
  model: AiModelId;
  system: string;
  /** 마스킹을 마친 입력 — main은 내용을 바꾸지 않고 그대로 보낸다 */
  user: string;
  /** 구조화 출력 JSON 스키마 */
  schema: Record<string, unknown>;
  effort?: AiEffort;
  /** 응답 본문에 필요한 토큰 — 생각(thinking) 여유는 main이 effort에 맞춰 더한다 */
  maxTokens?: number;
}

/** 청구 단위 하나 — 모델마다 단가가 다르다 */
export interface AiUsagePart {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AiUsage {
  /** 아래 세 값은 모든 청구 단위의 합 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  /** 출력 가운데 생각에 쓴 토큰(output에 들어 있다) */
  thinking?: number;
  /** 청구 단위별 내역 — 대체 모델이 이어 받았거나 한도를 올려 다시 요청하면 2개 이상. 없으면 응답 모델 하나로 계산 */
  parts?: AiUsagePart[];
}

export type AiErrorCode =
  | 'no-key'
  | 'auth'
  | 'no-model'
  | 'rate'
  | 'overloaded'
  | 'network'
  | 'timeout'
  | 'canceled'
  | 'refusal'
  | 'truncated'
  | 'bad-json'
  | 'bad-request'
  | 'error';

export type AiCompleteResult =
  | { ok: true; json: unknown; model: string; usage: AiUsage; fallbackUsed: boolean; ms: number }
  | { ok: false; code: AiErrorCode; message: string };

/** 호출 중 진행 상황 — main → renderer ('ai:progress') */
export interface AiProgress {
  id: string;
  /** connecting 연결 · thinking 생각 · writing 응답 작성 · fallback 대체 모델로 넘어감 · retry 한도를 올려 다시 요청 */
  phase: 'connecting' | 'thinking' | 'writing' | 'fallback' | 'retry';
  /** 지금까지 받은 응답 글자 수 */
  chars: number;
  /** 대체 모델이 이어 받았으면 그 모델 */
  model?: string;
}

/** Models API의 모델 하나 — 이 앱이 쓰는 값만 */
export interface AiModelMeta {
  id: string;
  name: string;
  /** 출시일(ISO) */
  createdAt: string;
  /** 모델 계열(fable·opus·sonnet·haiku …) */
  line: string | null;
  /** max_tokens 상한 */
  maxOutput: number | null;
  /** thinking: adaptive 지원 */
  adaptive: boolean;
  /** 이 앱의 AI 기능(구조화 출력 + effort)을 쓸 수 있는 모델 */
  usable: boolean;
}

export type AiModelsResult =
  | { ok: true; models: AiModelMeta[]; at: number }
  | { ok: false; code: AiErrorCode; message: string };

export interface AiKeyStatus {
  /** 앱에 저장된 키가 있음 */
  stored: boolean;
  /** 저장된 키가 없을 때 환경변수 ANTHROPIC_API_KEY를 쓴다 */
  env: boolean;
  /** 이 PC에서 OS 암호화 저장(safeStorage)을 쓸 수 있음 */
  encryption: boolean;
}
