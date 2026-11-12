/**
 * 주간보고 AI 정돈 — 항목의 문장만 다듬는다. 줄의 종류·순서·개수와 항목 구조는 바꾸지 않는다.
 *
 * 보내는 내용은 주간보고 형식 v2(주간보고 형식 명세 §4)를 따른다 (v0.13.1에서 다시 맞춤):
 * - 제목: 메일로 받은 건의 제목은 상대 메일 제목 그대로라 고정이다(§4.1). 그 밖의 제목 — 현장 작업명, 유선·메신저로 받은 건,
 *   괄호 없이 내가 붙인 작업명 — 은 다듬는다. (전에는 현장 방문만 다듬어서, 괄호 없이 작업명을 쓰는 실제 보고서의 제목이 전부 고정됐다.)
 * - 본문 줄: 번호 작업(1)) · 세부(-) · 노트(>) · 목록(-) · 대화 턴(-> <- *<- *-> *==>)의 뜻을 종류별로 알려 준다.
 * - 항목마다 채널·현장 여부·행(지원장소 | 고객사|작업구분)을 함께 보낸다. 담당자(사람 이름)는 보내지 않는다.
 */
import type { ClientItem, ContentBlock, DialogTurn, WeekReport } from '@core/index';
import { NOTE_PREFIX, buildingOf, formatItemHeader, isBlankItem, turnMarker } from '@core/index';
import type { AiCompleteRequest, AiCompleteResult, AiModelId } from '../../electron/ai-types';
import { Masker, missingFacts, sameTokens } from './mask';
import type { ReviewChange, ReviewData, ReviewNote } from './review';
import { estimateUsd } from './settings';
import { site } from '../core/site-config';

/** 한 줄의 위치 — 항목 키(di-bi-ii) 기준 */
type LineRef =
  | { part: 'title' }
  | { part: 'turn'; ci: number; ti: number }
  | { part: 'numTitle'; ci: number }
  | { part: 'detail'; ci: number; k: number }
  | { part: 'bullet'; ci: number; k: number };

interface UnitLine {
  id: string;
  kind: string;
  /** 마스킹한 원문 — 세부·목록의 노트 접두 `> `는 떼고 보낸다(종류는 kind로) */
  text: string;
  ref: LineRef;
  /** 노트 줄 — 적용할 때 앱이 접두를 다시 붙인다. 모델이 접두를 떼거나 붙여도 줄 종류가 바뀌지 않게 */
  note?: boolean;
}

export interface WeeklyUnit {
  key: string;
  /** 보내는 머리 — 담당자·채널은 빼고 마스킹 */
  header: string;
  /** 확인 창에 보일 머리 — 앱 안에서만 쓴다 */
  display: string;
  /** 받은 경로(메일·유선·메신저·현장…) — 없으면 '' */
  channel: string;
  /** 현장 방문 항목 (머리에 건물이 있거나 지원장소가 `고객사(건물)`) */
  onSite: boolean;
  /** 이 항목이 든 행 — `지원장소 | 고객사|작업구분` (마스킹) */
  row: string;
  /** 제목을 다듬어도 되는가 — 메일로 받은 건은 상대 메일 제목이라 false */
  titleEditable: boolean;
  title: string;
  lines: UnitLine[];
}

export interface WeeklyTidyPlan {
  request: AiCompleteRequest;
  units: WeeklyUnit[];
  masker: Masker;
}

function turnKindName(t: DialogTurn): string {
  if (t.kind === 'conclusion') return '결론(*==>)';
  if (t.kind === 'note') return '노트(>)';
  if (t.kind === 'in') return t.pending ? '대기 — 상대 회신 기다림(*->)' : '상대 발화(->)';
  return t.pending ? '미결 — 내 후속 조치 남음(*<-)' : '내 대응(<-)';
}

function blockLines(block: ContentBlock, ci: number, mask: (s: string) => string): UnitLine[] {
  const out: UnitLine[] = [];
  if (block.kind === 'dialog') {
    block.turns.forEach((t, ti) => {
      if (t.text.trim()) out.push({ id: `c${ci}t${ti}`, kind: turnKindName(t), text: mask(t.text), ref: { part: 'turn', ci, ti } });
    });
  } else if (block.kind === 'numbered') {
    if (block.title.trim()) out.push({ id: `c${ci}h`, kind: `번호 작업 제목(${block.index}))`, text: mask(block.title), ref: { part: 'numTitle', ci } });
    block.details.forEach((d, k) => {
      if (!d.trim()) return;
      const note = d.startsWith(NOTE_PREFIX);
      out.push({ id: `c${ci}d${k}`, kind: note ? '세부 노트(>)' : '세부(-)', text: mask(note ? d.slice(NOTE_PREFIX.length) : d), ref: { part: 'detail', ci, k }, note });
    });
  } else {
    block.items.forEach((d, k) => {
      if (!d.trim()) return;
      const note = d.startsWith(NOTE_PREFIX);
      out.push({ id: `c${ci}b${k}`, kind: note ? '목록 노트(>)' : '목록(-)', text: mask(note ? d.slice(NOTE_PREFIX.length) : d), ref: { part: 'bullet', ci, k }, note });
    });
  }
  return out;
}

/** 현장 방문 항목 — 머리에 건물이 있거나 지원장소가 `고객사(건물)` */
function isOnSite(item: ClientItem, locations: string[]): boolean {
  return !!item.site?.trim() || locations.some((l) => !!buildingOf(l));
}

/**
 * 메일로 받은 건 — 제목이 상대 메일 제목이라 글자 그대로 둔다(§4.1). `유선&메일`도 메일 제목이다.
 * 채널이 없거나 유선·메신저·현장이면 제목은 작성자가 붙인 작업명·사안이다.
 */
function isMailTitle(item: ClientItem): boolean {
  return /메일/.test(item.channel ?? '');
}

export function collectWeeklyUnits(report: WeekReport, masker: Masker): WeeklyUnit[] {
  const mask = (s: string) => masker.mask(s);
  const units: WeeklyUnit[] = [];
  report.days.forEach((day, di) =>
    day.blocks.forEach((block, bi) =>
      block.items.forEach((item, ii) => {
        if (isBlankItem(item)) return;
        const lines = item.content.flatMap((c, ci) => blockLines(c, ci, mask));
        units.push({
          key: `${di}-${bi}-${ii}`,
          header: `${day.date} ${mask(formatItemHeader({ ...item, contact: undefined, channel: undefined }))}`,
          display: `${day.date} ${formatItemHeader(item)}`,
          channel: item.channel?.trim() ?? '',
          onSite: isOnSite(item, block.locations),
          row: mask([block.locations.join(' / '), block.customer].map((s) => s.trim()).filter(Boolean).join(' | ')),
          titleEditable: !isMailTitle(item),
          title: mask(item.workType),
          lines,
        });
      }),
    ),
  );
  return units;
}

export const WEEKLY_SYSTEM = `당신은 ${site().company} 기술지원 엔지니어의 주간보고를 다듬는 편집자다. 주간보고는 팀장에게 보내는 한 주의 업무 기록이다. 일자마다 표의 "내용" 칸에 항목이 나열되고, 항목은 머리 한 줄과 그 아래 본문 줄로 이루어진다.

항목의 모양
- 머리: [고객사] (건물) (담당자/채널) 제목. 대괄호에는 고객사나 작업구분(제조사문의·미팅·테스트)이 온다. 건물이 있으면 현장 방문, 채널(메일·유선·메신저·슬랙·문자·카톡·현장)이 있으면 그 경로로 받은 건이다. 담당자 이름은 보내지 않았다.
- row는 그 항목이 든 표의 행이다: "지원장소 | 고객사|작업구분".
- 본문 줄은 kind로 종류가 정해져 있다. 줄 머리의 기호(1) - > -> <- *<- *-> *==>)는 앱이 붙이므로 text에 쓰지 않는다.
  · 번호 작업 제목: 작업 단계·회의 안건·질의 항목 한 줄. 무엇을 했는지(또는 무엇에 관한 것인지) 명사형으로 쓴다.
  · 세부(-)·목록(-): 그 단계의 내용이나 결과 한 줄.
  · 세부 노트(>)·목록 노트(>)·노트(>): 바로 위 줄을 보충하는 설명. 사용 방법·명령어·경로·수치가 그대로 적히는 줄이 많다.
  · 상대 발화(->): 고객이나 제조사이 한 문의·요청·회신·현상 제보.
  · 내 대응(<-): 내가 한 안내·전달·조치·요청·확인. 파일명이나 버전만 적힌 줄은 그 파일을 전달했다는 뜻이다.
  · 미결(*<-): 아직 남은 내 후속 조치. 대기(*->): 상대 회신을 기다리는 중. 결론(*==>): 정리해야 할 과제.

목표: 각 줄을 읽는 사람이 한 번에 이해하도록 간결하고 정확한 업무 문장으로 다듬는다.

문체
- 개조식으로 쓴다. 짧은 구나 명사형으로 끝낸다. 예: "호스트 선택 기능 통합", "스크립트 신규 작성 및 공유", "테스트 결과 정상 확인", "디스크 장애 시 동작 확인요청", "로그 분석 후 제조사 문의 예정".
- "~합니다", "~했습니다", "~드립니다" 같은 문장 끝은 개조식으로 바꾼다.
- 맞춤법·띄어쓰기·오탈자를 고치고, 군더더기 조사와 같은 말 반복을 줄인다.
- 원문이 쓰는 표기(→, ·, /, —, 괄호 안 보충)는 유지한다. 이미 간결한 줄은 바꿔 쓰지 않는다.

지킬 것
- 사실을 바꾸거나 더하지 않는다. 원문에 없는 원인·결과·날짜·수치를 만들지 않는다. 뜻이 모호하면 원문 표현을 살린다.
- 숫자·버전·파일명·명령어·경로·옵션·설정값·제품명·고객사명·사람 이름은 글자 그대로 둔다. 명령어·경로·파일명이 든 줄은 그 부분을 건드리지 않고 설명하는 말만 다듬는다(예: "사용방법 : ./bms list > jobs.csv"는 그대로).
- ⟦IP1⟧ ⟦URL1⟧ ⟦MAIL1⟧ ⟦TEL1⟧ ⟦KEY1⟧ 같은 자리표시는 가린 값이다. 글자 그대로, 같은 개수만큼 남긴다.
- 줄을 합치거나 나누거나 지우지 않는다. 받은 모든 줄을 같은 id로 돌려주고, 고칠 것이 없으면 원문 그대로 돌려준다. 한 줄 안에 줄바꿈(\\n)이 있으면 그 개수와 자리를 그대로 둔다.
- 제목(title): titleEditable이 false인 항목은 상대가 보낸 메일의 제목이다. 원문 그대로 돌려준다. true인 항목의 제목은 작성자가 붙인 작업명·사안이다. 뜻을 유지한 채 간결한 명사형으로 다듬고, 이미 간결하면 그대로 둔다.

notes
- 줄의 종류가 내용과 맞지 않아 보이는 곳(예: 상대 발화로 표시됐는데 내 조치), 미결로 남아야 할 것 같은 줄, 빠진 정보처럼 사람이 직접 판단할 점만 짧게 적는다. 항목당 최대 2개, 전체 최대 6개. 없으면 빈 배열.
- 사람이 읽는 글이다. id(c0t1 같은 줄 번호)는 쓰지 말고, 가리킬 줄은 그 줄의 내용을 짧게 인용한다.`;

export const WEEKLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'notes'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'lines'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: { id: { type: 'string' }, text: { type: 'string' } },
            },
          },
        },
      },
    },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'text'],
        properties: { key: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
} as const;

export function planWeeklyTidy(report: WeekReport, model: AiModelId): WeeklyTidyPlan | null {
  const masker = new Masker();
  const units = collectWeeklyUnits(report, masker);
  if (units.length === 0) return null;
  const payload = {
    week: `${report.prevWeekRange.start} ~ ${report.prevWeekRange.end}`,
    items: units.map((u) => ({
      key: u.key,
      header: u.header,
      ...(u.row ? { row: u.row } : {}),
      ...(u.channel ? { channel: u.channel } : {}),
      ...(u.onSite ? { onSite: true } : {}),
      titleEditable: u.titleEditable,
      title: u.title,
      lines: u.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text })),
    })),
  };
  const user = `아래 주간보고 항목들을 규칙대로 다듬어 같은 구조의 JSON으로 돌려줘.\n\n${JSON.stringify(payload, null, 1)}`;
  // 출력은 입력과 비슷한 길이 — 여유를 두되 상한 안에서
  const maxTokens = Math.min(32000, 4000 + Math.ceil(user.length * 1.5));
  return {
    request: { model, system: WEEKLY_SYSTEM, user, schema: WEEKLY_SCHEMA as unknown as Record<string, unknown>, effort: 'medium', maxTokens },
    units,
    masker,
  };
}

interface WeeklyResponse {
  items: Array<{ key: string; title: string; lines: Array<{ id: string; text: string }> }>;
  notes: Array<{ key: string; text: string }>;
}

function isWeeklyResponse(v: unknown): v is WeeklyResponse {
  const o = v as WeeklyResponse;
  return !!o && Array.isArray(o.items) && Array.isArray(o.notes);
}

const LEADING_MARKER = /^\s*(?:\*?<-|\*?->|\*==>|>(?=\s))\s*/;
// 세부·목록 줄 앞의 `- ` `> ` — 줄 종류는 앱이 정하므로 모델이 붙인 접두는 뗀다
const LEADING_BULLET = /^\s*(?:-|>)\s+/;
// 번호 작업 제목 앞의 `1) ` — 번호도 앱이 붙인다
const LEADING_NUMBER = /^\s*\d{1,2}\)\s+/;

const lineCount = (s: string) => s.trim().split('\n').length;

/** 한 줄 검증 — 통과 못 하면 이유. 자리표시·숫자가 빠졌거나 비었으면 받지 않는다 */
export function checkLine(beforeMasked: string, afterMasked: string): string | undefined {
  if (!afterMasked.trim()) return '빈 줄로 돌아옴';
  // 여러 줄 턴(마커 없이 이어지는 줄)은 줄 수가 구조다 — 합치거나 나누면 표의 줄바꿈이 달라진다
  if (lineCount(beforeMasked) !== lineCount(afterMasked)) return '줄바꿈 수가 바뀜';
  if (!sameTokens(beforeMasked, afterMasked)) return '가린 값(⟦…⟧)이 빠지거나 바뀜';
  const lost = missingFacts(beforeMasked, afterMasked);
  if (lost.length) return `숫자·버전이 빠짐: ${lost.slice(0, 3).join(', ')}`;
  if (afterMasked.length > beforeMasked.length * 2.5 + 40) return '원문보다 지나치게 길어짐';
  return undefined;
}

function lineLabel(kind: string): string {
  return kind.replace(/\(.*\)$/, '').replace(/ — .*/, '');
}

function itemOf(report: WeekReport, key: string): ClientItem | undefined {
  const [di, bi, ii] = key.split('-').map(Number);
  return report.days[di]?.blocks[bi]?.items[ii];
}

function markerOf(item: ClientItem, ref: LineRef): string {
  if (ref.part !== 'turn') return '';
  const block = item.content[ref.ci];
  return block?.kind === 'dialog' ? turnMarker(block.turns[ref.ti]) : '';
}

/** 응답 → 확인 창 목록. 원문과 같은 줄은 빼고, 검증 못 한 줄은 이유와 함께 보여 준다 */
export function reviewWeekly(report: WeekReport, plan: WeeklyTidyPlan, res: Extract<AiCompleteResult, { ok: true }>): ReviewData {
  const { units, masker } = plan;
  const changes: ReviewChange[] = [];
  const notes: ReviewNote[] = [];
  if (!isWeeklyResponse(res.json)) throw new Error('응답 형식이 예상과 다릅니다.');
  const byKey = new Map(res.json.items.map((it) => [it.key, it]));
  for (const unit of units) {
    const got = byKey.get(unit.key);
    if (!got) continue;
    const item = itemOf(report, unit.key);
    if (!item) continue;
    const group = unit.display;
    if (unit.titleEditable && got.title.trim() && got.title.trim() !== unit.title.trim()) {
      const reason = checkLine(unit.title, got.title);
      changes.push({
        id: `${unit.key}:title`,
        group,
        label: '제목',
        before: masker.unmask(unit.title),
        after: masker.unmask(got.title.trim()),
        ok: !reason,
        reason,
      });
    }
    const lineById = new Map(got.lines.map((l) => [l.id, l.text]));
    for (const line of unit.lines) {
      const raw = lineById.get(line.id);
      if (raw === undefined) continue;
      const after =
        line.ref.part === 'turn'
          ? raw.replace(LEADING_MARKER, '')
          : line.ref.part === 'detail' || line.ref.part === 'bullet'
            ? raw.replace(LEADING_BULLET, '')
            : line.ref.part === 'numTitle'
              ? raw.replace(LEADING_NUMBER, '')
              : raw;
      if (after.trim() === line.text.trim()) continue;
      const reason = checkLine(line.text, after);
      const marker = markerOf(item, line.ref);
      changes.push({
        id: `${unit.key}:${line.id}`,
        group,
        label: marker ? `${marker} ${lineLabel(line.kind)}` : lineLabel(line.kind),
        before: masker.unmask(line.text),
        after: masker.unmask(after.trim()),
        ok: !reason,
        reason,
      });
    }
  }
  const groupOfKey = new Map(units.map((u) => [u.key, u.display]));
  for (const n of res.json.notes) {
    const text = stripLineIds(n.text);
    if (text) notes.push({ group: groupOfKey.get(n.key) ?? '', text: masker.unmask(text) });
  }
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

/** 안내 글에 섞여 나온 내부 줄 번호(c0t1·c1d1·c2h…)를 지운다 — 사람에게는 의미 없는 기호 */
export function stripLineIds(text: string): string {
  return text
    .replace(/\(?\s*\b(?:c\d+(?:[tdb]\d+|h))(?:\s*[,·/]\s*c\d+(?:[tdb]\d+|h))*\b\s*\)?\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 고른 변경만 반영한 새 보고서 — 원본은 건드리지 않는다 */
export function applyWeekly(report: WeekReport, plan: WeeklyTidyPlan, review: ReviewData, picked: Set<string>): WeekReport {
  const next = structuredClone(report);
  const lineOf = new Map<string, UnitLine>();
  for (const u of plan.units) for (const l of u.lines) lineOf.set(`${u.key}:${l.id}`, l);
  for (const ch of review.changes) {
    if (!ch.ok || !picked.has(ch.id)) continue;
    const [key, lineId] = ch.id.split(':');
    const item = itemOf(next, key);
    if (!item) continue;
    if (lineId === 'title') {
      item.workType = ch.after;
      continue;
    }
    const line = lineOf.get(ch.id);
    const ref = line?.ref;
    if (!ref || ref.part === 'title') continue;
    const text = line?.note ? `${NOTE_PREFIX}${ch.after}` : ch.after;
    const block = item.content[ref.ci];
    if (!block) continue;
    if (ref.part === 'turn' && block.kind === 'dialog' && block.turns[ref.ti]) block.turns[ref.ti].text = ch.after;
    else if (ref.part === 'numTitle' && block.kind === 'numbered') block.title = ch.after;
    else if (ref.part === 'detail' && block.kind === 'numbered' && ref.k < block.details.length) block.details[ref.k] = text;
    else if (ref.part === 'bullet' && block.kind === 'bullets' && ref.k < block.items.length) block.items[ref.k] = text;
  }
  return next;
}
