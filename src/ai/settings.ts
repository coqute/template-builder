/** AI 설정 — 모델 선택과 모델 목록(이 키에서 열린 모델)만 브라우저 저장소에 둔다. 키는 main의 암호화 저장소. */
import {
  AI_MODELS,
  AI_MODEL_RE,
  isKnownModel,
  type AiModelId,
  type AiModelMeta,
  type AiUsage,
  type AiUsagePart,
  type KnownAiModelId,
} from '../../electron/ai-types';
import { safeSetItem } from '../lib/storage';

const KEY = 'tb:ai:v1';
const MODELS_KEY = 'tb:ai:models:v1';

export interface ModelPrice {
  /** 100만 토큰당 USD */
  inUsd: number;
  outUsd: number;
  /** 캐시 읽기 = 입력 단가 × 이 값 */
  cacheRead: number;
  /** 프롬프트(입력+캐시)가 이 토큰 수를 넘는 요청에 붙는 단가 */
  over?: { tokens: number; inUsd: number; outUsd: number };
}

/** 5분 캐시 쓰기 = 입력 단가 × 1.25 (모든 모델 공통) */
const CACHE_WRITE = 1.25;

/**
 * 모델 단가 — platform.claude.com/docs/en/about-claude/pricing (2026-11-10 확인).
 * 예전 모델도 둔다: 거부 시 대체 모델(Opus 5·4.8 등)이 이어 받으면 그 모델 단가로 청구된다.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-2': { inUsd: 8, outUsd: 40, cacheRead: 0.025 },
  'claude-fable-5-1': { inUsd: 10, outUsd: 50, cacheRead: 0.025 },
  'claude-fable-5': { inUsd: 10, outUsd: 50, cacheRead: 0.1 },
  'claude-opus-5-5': { inUsd: 4, outUsd: 20, cacheRead: 0.05 },
  'claude-opus-5': { inUsd: 5, outUsd: 25, cacheRead: 0.1 },
  'claude-opus-4-8': { inUsd: 5, outUsd: 25, cacheRead: 0.1 },
  'claude-opus-4-7': { inUsd: 5, outUsd: 25, cacheRead: 0.1 },
  'claude-opus-4-6': { inUsd: 5, outUsd: 25, cacheRead: 0.1 },
  'claude-opus-4-5': { inUsd: 5, outUsd: 25, cacheRead: 0.1 },
  'claude-sonnet-5-5': { inUsd: 2, outUsd: 10, cacheRead: 0.05 },
  'claude-sonnet-5': { inUsd: 2, outUsd: 10, cacheRead: 0.1 },
  'claude-sonnet-4-6': { inUsd: 3, outUsd: 15, cacheRead: 0.1 },
  'claude-sonnet-4-5': { inUsd: 3, outUsd: 15, cacheRead: 0.1 },
  'claude-haiku-5-5': { inUsd: 0.1, outUsd: 0.5, cacheRead: 0.1, over: { tokens: 100_000, inUsd: 0.5, outUsd: 2.5 } },
  'claude-haiku-4-5': { inUsd: 1, outUsd: 5, cacheRead: 0.1 },
};

/** 계열별 지금 모델 — 표에 없는 새 모델의 단가를 어림할 때만 쓴다 */
const LINE_CURRENT: Record<string, KnownAiModelId> = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

/**
 * 모델 단가. exact=false는 표에 없는 모델을 같은 계열의 지금 단가로 어림한 값이다.
 * 날짜가 붙은 id(claude-opus-4-5-20251101)는 날짜를 뗀 모델과 같다.
 */
export function priceOf(model: string): { price: ModelPrice; exact: boolean } | null {
  const base = model.replace(/-\d{8}$/, '');
  if (PRICES[base]) return { price: PRICES[base], exact: true };
  const line = /^claude-([a-z]+)-/.exec(base)?.[1];
  const current = line ? LINE_CURRENT[line] : undefined;
  return current ? { price: PRICES[current], exact: false } : null;
}

export const MODEL_INFO: Record<KnownAiModelId, { label: string; hint: string; note: string }> = {
  'claude-fable-5-2': {
    label: 'Claude Fable 5.2',
    hint: '가장 깊게 생각 · 느림',
    note: 'Opus 5.5로 부족한 어려운 글에 씁니다. 보안·AI 관련 내용에 더 엄격해서, 거부되면 Opus 계열이 이어 받습니다. 사용 한도가 따로(더 낮게) 잡혀 있고 데이터 보관 0일(ZDR) 조직에서는 쓸 수 없습니다.',
  },
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    hint: '정확 · 기본',
    note: '대부분의 정돈·정리에 권장합니다. 거부되면 대체 모델이 이어 받습니다.',
  },
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    hint: '빠름 · 절반 가격',
    note: '주간보고·작업일지처럼 짧은 정돈에 충분합니다. 거부되면 대체 모델이 이어 받습니다.',
  },
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    hint: '가장 빠르고 저렴',
    note: '가벼운 맞춤법·문장 정돈용입니다. 거부되면 대체 모델로 이어 받지 않습니다.',
  },
};

export const DEFAULT_MODEL: KnownAiModelId = 'claude-opus-5-5';

export function loadAiModel(): AiModelId {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const m = raw ? (JSON.parse(raw) as { model?: unknown }).model : undefined;
    return typeof m === 'string' && AI_MODEL_RE.test(m) ? m : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function saveAiModel(model: AiModelId): void {
  safeSetItem(KEY, JSON.stringify({ model }));
}

export interface ModelList {
  /** 조회한 시각(ms) */
  at: number;
  models: AiModelMeta[];
}

/** 마지막으로 조회한 "이 키에서 열린 모델" 목록 */
export function loadModelList(): ModelList | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MODELS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ModelList>) : null;
    if (!v || typeof v.at !== 'number' || !Array.isArray(v.models)) return null;
    return { at: v.at, models: v.models.filter((m) => m && typeof m.id === 'string' && AI_MODEL_RE.test(m.id)) };
  } catch {
    return null;
  }
}

export function saveModelList(list: ModelList): void {
  safeSetItem(MODELS_KEY, JSON.stringify(list));
}

function partUsd(p: AiUsagePart): number {
  const price = (priceOf(p.model) ?? priceOf(DEFAULT_MODEL)!).price;
  // 프롬프트 길이는 캐시 읽기·쓰기를 포함한 입력 전체로 센다
  const tier = price.over && p.input + p.cacheRead + p.cacheWrite > price.over.tokens ? price.over : price;
  return (
    (p.input * tier.inUsd + p.cacheRead * tier.inUsd * price.cacheRead + p.cacheWrite * tier.inUsd * CACHE_WRITE + p.output * tier.outUsd) /
    1_000_000
  );
}

/**
 * 대략 비용(USD). 청구 단위(usage.parts)가 있으면 단위마다 그 모델 단가로 더한다 —
 * 대체 모델이 이어 받았거나 한도를 올려 다시 요청한 경우 앞 시도도 청구되기 때문이다.
 * input은 캐시 읽기·쓰기를 뺀 값이고, 생각(thinking) 토큰은 output에 들어 있다.
 */
export function estimateUsd(model: string, usage: AiUsage): number {
  const parts = usage.parts?.length
    ? usage.parts
    : [{ model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite ?? 0 }];
  return parts.reduce((sum, p) => sum + partUsd(p), 0);
}

/** id → 읽는 이름. 목록에 없으면 id에서 만든다(claude-opus-4-8 → Claude Opus 4.8) */
export function modelLabel(model: string): string {
  if (isKnownModel(model)) return MODEL_INFO[model].label;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return model;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** "$4 / $20" — 입력/출력 100만 토큰당. 표에 없는 모델은 어림값임을 밝힌다 */
export function priceText(model: string): string {
  const p = priceOf(model);
  if (!p) return '단가 미확인';
  const text = `$${p.price.inUsd} / $${p.price.outUsd}`;
  return p.exact ? text : `${text} 추정`;
}

export interface ModelChoice {
  id: string;
  label: string;
  /** 이 키에서 쓸 수 있는가 — 목록을 아직 조회하지 않았으면 null */
  available: boolean | null;
}

/**
 * 모델 고르기 목록 — 주력 모델은 항상 보이고, 그 밖에 이 키에서 열려 있고 이 기능을 쓸 수 있는 모델을 최신순으로 덧붙인다.
 * 지금 고른 모델이 어디에도 없으면(목록 조회 전 등) others 맨 앞에 넣어 선택이 사라지지 않게 한다.
 */
export function modelChoices(list: ModelList | null, selected: string): { current: ModelChoice[]; others: ModelChoice[] } {
  const live = new Map((list?.models ?? []).map((m) => [m.id, m]));
  const current: ModelChoice[] = AI_MODELS.map((id) => ({
    id,
    label: MODEL_INFO[id].label,
    available: list ? (live.get(id)?.usable ?? false) : null,
  }));
  const others: ModelChoice[] = [...live.values()]
    .filter((m) => !isKnownModel(m.id) && m.usable)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({ id: m.id, label: m.name || modelLabel(m.id), available: true }));
  if (!isKnownModel(selected) && !others.some((o) => o.id === selected)) {
    others.unshift({ id: selected, label: modelLabel(selected), available: list ? false : null });
  }
  return { current, others };
}
