import { describe, expect, it } from 'vitest';
import { parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { renderHtml } from '../src/core/renderer';
import { importFromHtml } from '../src/core/importer';
import type { WeekReport } from '../src/core/types';

/**
 * G3-2 roundtrip 프로퍼티 게이트 — 전체 파이프라인
 *   md → parse → renderHtml → importFromHtml → serialize → parse
 * 후에도 보고서의 "내용 불변량"이 보존됨을 변주 케이스로 고정한다.
 *
 * [허용 소실 계약 — 완전 문자열 동일성을 요구하지 않는 항목]
 *  1. authorName: 발송 HTML에 작성자 정보가 없음 → importer의 defaultAuthor로 대체 (호출부가 프로필 주입)
 *  2. @CURRENT: □ Date 헤더는 PREV만 담음 → PREV+7일로 재추정 (시작일만 보장)
 *  3. inheritLocation 블록 경계: renderer가 rowspan으로 병합 → 재임포트 시 단일 블록으로 평탄화될 수 있음
 *     → 비교는 "일자별 전체 item 시퀀스" 기준 (블록 구조 무시)
 *  4. 날짜 변주(점/슬래시)·요일 생략: 파서가 ISO로 정규화 → 정규화된 값 기준 비교
 *
 * @HOLIDAY 사유는 내용 셀에 렌더되고 importer가 복원 — 완전 보존 (허용 소실 아님)
 */

function fullPipeline(md: string): { imported: WeekReport; reparsed: WeekReport } {
  const original = parse(md);
  const { report: imported } = importFromHtml(renderHtml(original));
  const reparsed = parse(serialize(imported));
  return { imported, reparsed };
}

/** 일자별 item 시퀀스로 평탄화 — 허용 소실 3(블록 경계) 계약 반영 */
function flattenItems(r: WeekReport) {
  return r.days.map((d) => ({
    date: d.date,
    weekday: d.weekday,
    holiday: d.holiday ?? null, // 사유 포함 완전 비교 — 내용 셀 렌더로 왕복 보존
    items: d.blocks.flatMap((b) =>
      b.items.map((i) => ({
        client: i.client,
        contact: i.contact ?? null,
        channel: i.channel ?? null,
        workType: i.workType,
        content: i.content,
      })),
    ),
  }));
}

function expectContentPreserved(md: string): void {
  const original = parse(md);
  const { reparsed } = fullPipeline(md);
  expect(flattenItems(reparsed)).toEqual(flattenItems(original));
  expect(reparsed.prevWeekRange).toEqual(original.prevWeekRange);
}

const HEADER = ['@PREV 2026-05-11 ~ 2026-05-17', '@CURRENT 2026-05-18 ~ 2026-05-24', '@AUTHOR 김테스트', ''];

describe('roundtrip 프로퍼티 — 전체 파이프라인 내용 보존', () => {
  it('numbered + 하위 dash + note', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-11(월)', '@LOC 한강', '@CUS 한강 SRE',
        '@SUM [ABZ+] (이영희) 수집서버 설치',
        '1) 에이전트 설치', '- Rocky 9 가이드', '> schedule 정상 확인',
        '2) NMS 설정', '- 서비스 실행', '',
      ].join('\n'),
    );
  });

  it('Q&A 패턴 + 채널', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-12(화)', '@LOC 서원', '@CUS 서원 SRE',
        '@SUM [ABZ+] (이영희/유선&메일) 이벤트 문의',
        '<- 임계치 초과 이벤트 미발생 문의', '-> 수집 주기 확인 안내', '-> 설정 가이드 전달', '',
      ].join('\n'),
    );
  });

  it('@HOLIDAY + 빈 평일 행', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-11(월)', '',
        '# 2026-05-15(금)', '@HOLIDAY 대체 휴무', '',
      ].join('\n'),
    );
  });

  it('멀티 @CUS(슬래시 줄바꿈) + bare 헤더', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-13(수)', '@LOC 남산 데이터센터', '@CUS 남산 IDC / 남산 NMS',
        '@SUM [ABZ+] 일반 지원', '- 정기 점검', '',
      ].join('\n'),
    );
  });

  it('한 일자 멀티 @LOC 블록 — 블록 경계는 평탄화 계약으로 보존', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-14(목)', '@LOC 한강', '@CUS 한강 SRE',
        '@SUM [ABZ+] (A) 오전 작업', '- 점검', '',
        '@LOC 서원', '@CUS 서원 SRE',
        '@SUM [ABZ+] (B) 오후 작업', '- 이설', '',
      ].join('\n'),
    );
  });

  it('빈 workType + 미등록 채널 raw 보존', () => {
    expectContentPreserved(
      [...HEADER,
        '# 2026-05-11(월)', '@LOC 한강', '@CUS 한강 SRE',
        '@SUM [ABZ+] (이영희/카톡) 비표준 채널 문의', '- 내용', '',
      ].join('\n'),
    );
  });

  it('점/슬래시 날짜 변주는 ISO 정규화 후 보존', () => {
    const md = [...HEADER.slice(0, 2), '@AUTHOR 김테스트', '',
      '# 2026.5.11', '@LOC 한강', '@CUS 한강 SRE',
      '@SUM [ABZ+] (이영희) 작업', '- 내용', '',
    ].join('\n');
    const original = parse(md);
    expect(original.days[0].date).toBe('2026-05-11'); // 파서 정규화
    const { reparsed } = fullPipeline(md);
    expect(flattenItems(reparsed)).toEqual(flattenItems(original));
  });

  it('serialize∘parse는 2회차부터 고정점 (idempotent)', () => {
    const md = [...HEADER,
      '# 2026-05-11(월)', '@LOC 한강', '@CUS 한강 SRE',
      '@SUM [ABZ+] (이영희/메일) 문의', '<- 질문', '-> 답변', '> 참고', '',
    ].join('\n');
    const once = serialize(parse(md));
    const twice = serialize(parse(once));
    expect(twice).toBe(once);
  });
});
