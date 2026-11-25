/**
 * AI 정돈 (v0.6.0) — 마스킹·검증·주간보고 계획→응답→적용·확인 창. (이메일은 v0.25.0에서 서술 → 문의로 바뀌었다 — email-compose.test.tsx)
 * Claude API 호출 자체는 앱(main)에서 실측한다 — 여기서는 보내는 내용과 받은 결과를 다루는 규칙을 고정한다.
 * 픽스처의 주소·이름은 모두 합성 값이다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTolerant, serialize } from '../src/core/index';
import { Masker, missingFacts, sameTokens } from '../src/ai/mask';
import { applyWeekly, checkLine, planWeeklyTidy, reviewWeekly, stripLineIds } from '../src/ai/weeklyTidy';
import { estimateUsd } from '../src/ai/settings';
import { diffWords } from '../src/ai/diff';
import { AiReviewDialog } from '../src/components/AiReviewDialog';
import type { AiCompleteResult } from '../electron/ai-types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const ok = (json: unknown, model = 'claude-opus-5-5'): Extract<AiCompleteResult, { ok: true }> => ({
  ok: true,
  json,
  model,
  usage: { input: 3000, output: 1500, cacheRead: 0 },
  fallbackUsed: false,
  ms: 9000,
});

describe('마스킹 — 나가기 전에 가리고 돌아오면 되살린다', () => {
  it('IP·URL·메일·전화·키를 자리표시로, 같은 값은 같은 자리표시', () => {
    const m = new Masker();
    const src =
      '192.0.2.40:8443 접속 불가, 192.0.2.40 재시도. 매뉴얼 https://docs.example.com/a?b=1 참고, ' +
      'ops@example.com 회신, 010-1234-5678, 키 Ab3dEf7hIj9kLm1nOp3qRs5tUv7w';
    const masked = m.mask(src);
    expect(masked).toBe(
      '⟦IP1⟧ 접속 불가, ⟦IP2⟧ 재시도. 매뉴얼 ⟦URL1⟧ 참고, ⟦MAIL1⟧ 회신, ⟦TEL1⟧, 키 ⟦KEY1⟧',
    );
    expect(m.unmask(masked)).toBe(src);
    expect(m.summary()).toEqual({ IP: 2, URL: 1, MAIL: 1, TEL: 1, KEY: 1 });
  });

  it('버전·파일명·OS·날짜·시간은 가리지 않는다 (사실 그대로 다듬어야 하므로)', () => {
    const m = new Masker();
    const src = 'collector-x.y.z, job-manager-x.y.z, RHEL 8.10, 2026-10-21 14:30, store 30일';
    expect(m.mask(src)).toBe(src);
  });

  it('검증 — 자리표시·숫자가 빠지면 받지 않는다, 띄어쓰기 차이는 허용', () => {
    expect(sameTokens('⟦IP1⟧ 확인', '⟦IP1⟧ 확인요청')).toBe(true);
    expect(sameTokens('⟦IP1⟧ 확인', '서버 확인')).toBe(false);
    expect(missingFacts('보관 주기 30일 → 14일', '보관 주기 30 일에서 14 일로')).toEqual([]);
    expect(missingFacts('사용률 85% 경고', '사용률 경고')).toEqual(['85%']);
    expect(checkLine('로그 분석 후 문의 예정', '')).toBe('빈 줄로 돌아옴');
    expect(checkLine('⟦IP1⟧ 접속 확인', '접속 확인')).toContain('가린 값');
  });
});

describe('주간보고 정돈', () => {
  const heavy = readFileSync(resolve(__dirname, 'fixtures/heavy-week.md'), 'utf8');

  it('계획 — 쓴 항목만, 원격 제목은 고정·현장 제목은 다듬기 대상, 담당자는 보내지 않는다', () => {
    const report = parseTolerant(heavy).report;
    const plan = planWeeklyTidy(report, 'claude-opus-5-5')!;
    expect(plan.units).toHaveLength(10);
    const remote = plan.units.find((u) => u.key === '0-0-0')!;
    const onsite = plan.units.find((u) => u.key === '1-0-0')!;
    expect(remote.titleEditable).toBe(false);
    expect(onsite.titleEditable).toBe(true);
    expect(remote.lines.map((l) => l.id)).toEqual(['c0t0', 'c0t1', 'c0t2', 'c0t3']);
    expect(onsite.lines.map((l) => l.id)).toEqual(['c0h', 'c0d0', 'c1h', 'c1d0', 'c1d1']);
    // 담당자(사람 이름)·채널은 보내는 머리에서 뺀다
    expect(plan.request.user).not.toContain('담당A');
    expect(remote.header).toBe('2026-10-12 [MX] 에이전트 이름 변경 후 대시보드 미반영');
    expect(plan.request.model).toBe('claude-opus-5-5');
    expect(plan.request.schema).toHaveProperty('required', ['items', 'notes']);
  });

  it('IP가 든 줄은 가려서 보낸다', () => {
    const md = heavy.replace('서버 IP 변경 후', '서버 IP 198.51.100.3 → 198.51.100.4 변경 후');
    const plan = planWeeklyTidy(parseTolerant(md).report, 'claude-opus-5-5')!;
    expect(plan.request.user).not.toContain('198.51.100.3');
    expect(plan.request.user).toContain('⟦IP1⟧ → ⟦IP2⟧');
  });

  it('응답 검토·적용 — 바뀐 줄만, 원격 제목·숫자 누락은 제외, 앞에 붙은 마커는 떼고 적용', () => {
    const report = parseTolerant(heavy).report;
    const plan = planWeeklyTidy(report, 'claude-opus-5-5')!;
    const json = {
      items: [
        {
          key: '0-0-0',
          title: '대시보드 신규 IP 미반영', // 원격 — 무시돼야 함
          lines: [
            { id: 'c0t0', text: '-> 서버 IP 변경 후 대시보드 신규 IP 미반영 문의' },
            { id: 'c0t1', text: '에이전트 재기동 여부 및 agent.conf 설정 확인요청' },
            { id: 'c0t2', text: '재기동했으나 동일 증상, 로그 전달받음' }, // 그대로 — 목록에서 빠짐
            { id: 'c0t3', text: '로그 분석 후 제조사 문의 예정' },
          ],
        },
        { key: '0-1-0', title: '수집서버 디스크 사용량 경고', lines: [{ id: 'c0t0', text: '수집서버 디스크 사용률 경고 수신' }] },
        { key: '1-0-0', title: '수집서버 패치 사전점검', lines: [] },
      ],
      notes: [{ key: '0-0-0', text: '로그 분석 결과가 나오면 결론 줄을 추가하세요.' }],
    };
    const review = reviewWeekly(report, plan, ok(json));
    const ids = review.changes.map((c) => c.id);
    expect(ids).toEqual(['0-0-0:c0t0', '0-0-0:c0t1', '0-1-0:c0t0', '1-0-0:title']);
    expect(review.changes[0]).toMatchObject({ label: '-> 상대 발화', after: '서버 IP 변경 후 대시보드 신규 IP 미반영 문의', ok: true });
    expect(review.changes[2]).toMatchObject({ ok: false });
    expect(review.changes[2].reason).toContain('85%');
    expect(review.notes[0]).toEqual({ group: '2026-10-12 [MX] (담당A/메일) 에이전트 이름 변경 후 대시보드 미반영', text: '로그 분석 결과가 나오면 결론 줄을 추가하세요.' });
    expect(review.usd).toBeCloseTo((3000 * 4 + 1500 * 20) / 1e6, 6);

    const picked = new Set(['0-0-0:c0t0', '0-0-0:c0t1', '0-1-0:c0t0', '1-0-0:title']);
    const out = serialize(applyWeekly(report, plan, review, picked));
    expect(out).toContain('  -> 서버 IP 변경 후 대시보드 신규 IP 미반영 문의\n  <- 에이전트 재기동 여부 및 agent.conf 설정 확인요청');
    expect(out).toContain('@SUM [MX] (담당A/메일) 에이전트 이름 변경 후 대시보드 미반영'); // 원격 제목 그대로
    expect(out).toContain('@SUM [ABZ+] (한강사옥) (담당C) 수집서버 패치 사전점검');
    expect(out).toContain('  -> 수집서버 디스크 사용률 85% 경고 수신'); // 검증 실패 → 원문 유지
    // 고르지 않은 변경은 적용하지 않는다
    const none = serialize(applyWeekly(report, plan, review, new Set()));
    expect(none).toBe(serialize(report));
  });

  it('세부 노트(>) — 접두는 떼고 보내고, 모델이 떼거나 붙여도 노트·세부 구분은 그대로', () => {
    const report = parseTolerant(heavy).report;
    const plan = planWeeklyTidy(report, 'claude-opus-5-5')!;
    const onsite = plan.units.find((u) => u.key === '1-0-0')!;
    const note = onsite.lines.find((l) => l.id === 'c1d1')!;
    expect(note).toMatchObject({ kind: '세부 노트(>)', text: '고객 변경관리 승인 10-21 예정', note: true });
    const json = {
      items: [
        {
          key: '1-0-0',
          title: onsite.title,
          lines: [
            { id: 'c0d0', text: '> 수집서버 4대·프록시 2대' }, // 세부에 노트 접두를 붙여 옴
            { id: 'c1d1', text: '고객 변경관리 승인 10-21 예정됨' }, // 노트 접두를 떼어 옴
          ],
        },
      ],
      notes: [],
    };
    const review = reviewWeekly(report, plan, ok(json));
    const out = serialize(applyWeekly(report, plan, review, new Set(review.changes.map((c) => c.id))));
    expect(out).toContain('\n- 수집서버 4대·프록시 2대\n');
    expect(out).toContain('\n> 고객 변경관리 승인 10-21 예정됨\n');
  });

  it('확인할 점에 섞인 내부 줄 번호는 지운다 (실측: Opus가 "c1d1 …의 요청 주체" 식으로 씀)', () => {
    expect(stripLineIds("c1d1 '보안 검토 서류 별도 요청 예정'의 요청 주체가 불분명함")).toBe("'보안 검토 서류 별도 요청 예정'의 요청 주체가 불분명함");
    expect(stripLineIds('첫 줄(c0t0, c0t1)이 내 대응으로 시작함')).toBe('첫 줄 이 내 대응으로 시작함');
    expect(stripLineIds('ct 스캔 c3 결과 공유')).toBe('ct 스캔 c3 결과 공유');
  });

    it('쓴 항목이 없으면 보낼 것이 없다', () => {
    const blank = '@PREV 2026-10-12 ~ 2026-10-18\n\n# 2026-10-12(월)\n';
    expect(planWeeklyTidy(parseTolerant(blank).report, 'claude-opus-5-5')).toBeNull();
  });
});

describe('확인 창', () => {
  it('묶음별 목록 — 검증 실패는 고를 수 없고 이유를 보여 준다, 고른 것만 적용', () => {
    const onApply = vi.fn();
    render(
      <AiReviewDialog
        title="AI 정돈 — 주간보고 문장"
        review={{
          changes: [
            { id: 'a', group: '[MX] 제목', label: '-> 상대 발화', before: '문의 드립니다', after: '문의', ok: true },
            { id: 'b', group: '[MX] 제목', label: '<- 내 대응', before: '85% 확인', after: '확인', ok: false, reason: '숫자·버전이 빠짐: 85%' },
            { id: 'c', group: '[ABZ+] 패치', label: '제목', before: '패치 사전 점검', after: '패치 사전점검', ok: true },
          ],
          notes: [{ group: '[MX] 제목', text: '결론 줄이 필요해 보입니다.' }],
          model: 'claude-opus-5-5',
          usage: { input: 1000, output: 500, cacheRead: 0 },
          usd: 0.014,
          ms: 4200,
          fallbackUsed: false,
          masked: { IP: 2 },
        }}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/보내기 전 가림: IP 2/)).toBeTruthy();
    expect(screen.getByText('결론 줄이 필요해 보입니다.')).toBeTruthy();
    expect(screen.getByText(/적용하지 않음 — 숫자·버전이 빠짐: 85%/)).toBeTruthy();
    expect((screen.getByLabelText('<- 내 대응 적용') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('제목 적용')); // 하나 해제
    act(() => screen.getByRole('button', { name: '고른 1곳 적용' }).click());
    expect([...onApply.mock.calls[0][0]]).toEqual(['a']);
  });

  it('낱말 비교 — 지운 것과 더한 것만 표시', () => {
    expect(diffWords('로그 확인 부탁 드립니다', '로그 확인요청')).toEqual([
      { t: 'same', s: '로그 ' },
      { t: 'del', s: '확인 부탁 드립니다' },
      { t: 'add', s: '확인요청' },
    ]);
  });

  it('비용 — 대체 모델이 받았으면 그 모델 단가', () => {
    expect(estimateUsd('claude-sonnet-5-5', { input: 1_000_000, output: 100_000, cacheRead: 0 })).toBeCloseTo(3, 6);
  });
});
