/**
 * AI 정돈이 실제로 보내는 요청 내용 (v0.13.1) — 지금 형식의 모양과 맞는지 고정한다.
 * - 주간보고: 형식 v2 §4 — 메일 제목만 고정, 줄 종류별 뜻, 여러 줄 턴의 줄 수.
 * - 이메일은 v0.25.0에서 서술 → 문의로 바뀌었다 — 요청 내용은 email-compose.test.tsx가 고정한다.
 * 픽스처의 주소·이름·키는 모두 합성 값이다.
 */
import { describe, expect, it } from 'vitest';
import { parseTolerant, serialize } from '../src/core/index';
import { Masker } from '../src/ai/mask';
import { WEEKLY_SYSTEM, applyWeekly, checkLine, planWeeklyTidy, reviewWeekly } from '../src/ai/weeklyTidy';
import type { AiCompleteResult } from '../electron/ai-types';

const ok =(json: unknown): Extract<AiCompleteResult, { ok: true }> => ({
  ok: true,
  json,
  model: 'claude-opus-5-5',
  usage: { input: 3000, output: 1500, cacheRead: 0 },
  fallbackUsed: false,
  ms: 9000,
});
const payloadOf = (user: string) => JSON.parse(user.slice(user.indexOf('{')));

// ── 주간보고 ────────────────────────────────────────────────────────────────
const WEEK = `@PREV 2026-11-02 ~ 2026-11-08
@CURRENT 2026-11-09 ~ 2026-11-15
@AUTHOR 김테스트

# 2026-11-02(월)
@LOC 한강 제트플러스 4F
@CUS 한강 SRE
@SUM [AB Z+] 로그 정리 스크립트 통합·신규 작성 및 공유 했음
1) 기존 스크립트(cleanup_logs.sh)에 대상 선택 기능을 통합함
- 대상 목록만 뽑던 기능을 스크립트에 합쳤습니다
> 사용방법 : ./cleanup_logs.sh hosts.csv --mode select

@SUM [AB Z+] (담당A/메일) 수집 서비스 기동 오류 회신
-> systemctl status collector 로그 첨부
<- 에러 로그 경로 안내
  추가 회신 요청

@SUM [AB Z+] (담당B/유선) 라이선스 만료일 문의 건
-> 만료일 문의

@SUM [AB Z+] (담당C/메신저) 이벤트 설정 문의
-> 설정 방법 문의

# 2026-11-03(화)
@LOC AB Z+(한강사옥)
@CUS 한강 SRE
@SUM [AB Z+] (한강사옥) (담당D) 수집서버 패치
1) 패치 적용
`;

describe('주간보고 — 보내는 내용이 형식 v2와 맞는다', () => {
  const report = parseTolerant(WEEK).report;
  const plan = planWeeklyTidy(report, 'claude-opus-5-5')!;
  const unit = (key: string) => plan.units.find((u) => u.key === key)!;

  it('제목은 메일로 받은 건만 고정 — 괄호 없는 작업명·유선·메신저·현장은 다듬는다', () => {
    expect(unit('0-0-0')).toMatchObject({ titleEditable: true, channel: '', onSite: false }); // 괄호 없이 내가 붙인 작업명
    expect(unit('0-0-1')).toMatchObject({ titleEditable: false, channel: '메일' }); // 상대 메일 제목
    expect(unit('0-0-2')).toMatchObject({ titleEditable: true, channel: '유선' });
    expect(unit('0-0-3')).toMatchObject({ titleEditable: true, channel: '메신저' });
    expect(unit('1-0-0')).toMatchObject({ titleEditable: true, onSite: true });
  });

  it('항목마다 행·채널·현장 여부를 보내고, 담당자 이름은 보내지 않는다', () => {
    const items = payloadOf(plan.request.user).items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ key: '0-0-0', row: '한강 제트플러스 4F | 한강 SRE', titleEditable: true });
    expect(items[0]).not.toHaveProperty('channel');
    expect(items[1]).toMatchObject({ channel: '메일', titleEditable: false });
    expect(items[4]).toMatchObject({ onSite: true, row: 'AB Z+(한강사옥) | 한강 SRE' });
    for (const name of ['담당A', '담당B', '담당C', '담당D']) expect(plan.request.user).not.toContain(name);
  });

  it('번호 작업·세부·노트 줄을 종류와 함께 보낸다 (기호는 떼고)', () => {
    expect(unit('0-0-0').lines.map((l) => [l.id, l.kind, l.text])).toEqual([
      ['c0h', '번호 작업 제목(1))', '기존 스크립트(cleanup_logs.sh)에 대상 선택 기능을 통합함'],
      ['c0d0', '세부(-)', '대상 목록만 뽑던 기능을 스크립트에 합쳤습니다'],
      ['c0d1', '세부 노트(>)', '사용방법 : ./cleanup_logs.sh hosts.csv --mode select'],
    ]);
  });

  it('보내는 줄 종류는 모두 지침에 뜻이 적혀 있다 (지침과 요청 내용의 낱말이 어긋나지 않게)', () => {
    const md = `${WEEK}\n@SUM [AB Z+] 목록 항목\n- 헤드라인\n> 보충\n\n@SUM [제조사문의] (제조사지원/메일) 문의\n<- 문의\n*-> 회신 대기\n*<- 후속 예정\n*==> 절차 정리\n> 참고\n`;
    const kinds = new Set(planWeeklyTidy(parseTolerant(md).report, 'claude-opus-5-5')!.units.flatMap((u) => u.lines.map((l) => l.kind)));
    expect(kinds.size).toBeGreaterThanOrEqual(10);
    for (const kind of kinds) {
      const word = kind.replace(/\(.*\)$/, '').replace(/ — .*/, '');
      expect(WEEKLY_SYSTEM, kind).toContain(word);
    }
    expect(WEEKLY_SYSTEM).toContain('titleEditable');
    expect(WEEKLY_SYSTEM).toContain('줄바꿈(\\n)');
  });

  it('여러 줄 턴은 줄 수가 같을 때만 받는다, 번호·기호를 붙여 와도 떼고 적용한다', () => {
    expect(unit('0-0-1').lines[1]).toMatchObject({ id: 'c0t1', text: '에러 로그 경로 안내\n추가 회신 요청' });
    expect(checkLine('에러 로그 경로 안내\n추가 회신 요청', '에러 로그 경로 안내 및 추가 회신 요청')).toBe('줄바꿈 수가 바뀜');
    expect(checkLine('만료일 문의', '만료일\n문의')).toBe('줄바꿈 수가 바뀜');
    const json = {
      items: [
        {
          key: '0-0-0',
          title: '로그 정리 스크립트 통합·신규 작성 및 공유',
          lines: [
            { id: 'c0h', text: '1) 기존 스크립트(create_log_keyword.sh)에 호스트 선택 기능 통합' },
            { id: 'c0d0', text: '- 호스트 선택 API만 호출하던 기능을 스크립트에 통합' },
            { id: 'c0d1', text: '사용방법 : ./cleanup_logs.sh hosts.csv --mode select' },
          ],
        },
        {
          key: '0-0-1',
          title: 'BMS 기동 오류 관련 회신', // 메일 제목 — 무시돼야 한다
          lines: [{ id: 'c0t1', text: '에러 로그 경로 안내\n추가 회신 요청함' }],
        },
        { key: '0-0-2', title: '라이선스 만료일 문의', lines: [{ id: 'c0t0', text: '만료일 문의' }] },
      ],
      notes: [],
    };
    const review = reviewWeekly(report, plan, ok(json));
    expect(review.changes.map((c) => [c.id, c.ok])).toEqual([
      ['0-0-0:title', true],
      ['0-0-0:c0h', true],
      ['0-0-0:c0d0', true],
      ['0-0-1:c0t1', true],
      ['0-0-2:title', true],
    ]);
    const out = serialize(applyWeekly(report, plan, review, new Set(review.changes.map((c) => c.id))));
    expect(out).toContain('@SUM [AB Z+] 로그 정리 스크립트 통합·신규 작성 및 공유\n1) 기존 스크립트(create_log_keyword.sh)에 호스트 선택 기능 통합\n- 호스트 선택 API만 호출하던 기능을 스크립트에 통합\n> 사용방법 : ./cleanup_logs.sh hosts.csv --mode select');
    expect(out).toContain('@SUM [AB Z+] (담당A/메일) 수집 서비스 기동 오류 회신'); // 메일 제목 그대로
    expect(out).toContain('<- 에러 로그 경로 안내\n  추가 회신 요청함'); // 줄 수 유지
    expect(out).toContain('@SUM [AB Z+] (담당B/유선) 라이선스 만료일 문의\n');
    // 다시 읽어도 구조가 같다
    const again = parseTolerant(out).report;
    expect(again.days[0].blocks[0].items.map((i) => i.content.length)).toEqual(report.days[0].blocks[0].items.map((i) => i.content.length));
  });
});

// ── 가림 규칙 ────────────────────────────────────────────────────────────────
describe('가림 — 제조사 키 모양 문자열', () => {
  it('붙여 넣은 라이선스·액세스 키 모양은 가리고, 버전·파일명은 가리지 않는다', () => {
    const KEY = 'test0000key01-test0000key002-test0000key003';
    const m = new Masker();
    expect(m.mask(`라이선스 ${KEY} 입니다`)).toBe('라이선스 ⟦KEY1⟧ 입니다');
    expect(m.mask('job-manager-x.y.z, collector-x.y.z')).toBe('job-manager-x.y.z, collector-x.y.z');
  });
});

describe('가림 — 문장 끝의 IP', () => {
  it('마침표로 끝나는 문장의 IP도 가리고, 숫자가 더 이어지는 값(1.2.3.4.5)은 IP로 보지 않는다', () => {
    const m = new Masker();
    expect(m.mask('수집서버는 192.0.2.40. 포트는 192.0.2.41:8443.')).toBe('수집서버는 ⟦IP1⟧. 포트는 ⟦IP2⟧.');
    expect(m.mask('빌드 1.2.3.4.5 배포')).toBe('빌드 1.2.3.4.5 배포');
  });
});
