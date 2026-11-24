/**
 * 홈 — 작업일지에서 후보 찾기 (상태 낱말·같은 사안 닫힘·기간·닻). 일지는 모두 손으로 쓴 합성본이다.
 */
import { describe, expect, it } from 'vitest';
import type { WorklogFileText } from '../electron/worklog-types';
import { anchorOf, caseAtLine, findAnchor, insertScheduleLine } from '../src/planner/anchor';
import { parseQuickAdd, resolveMonthDay } from '../src/planner/dates';
import { blockStatus, scanWorklogs } from '../src/planner/sources/worklog';
import { lineStatus, waitingOnOf } from '../src/planner/status';
import { parseWorklog } from '../src/worklog/format';

const TODAY = '2026-11-23';
const FOLDER = 'AB Z+ 작업';

function file(date: string, body: string, folder = FOLDER): WorklogFileText {
  const title = '점검';
  const text = `[${date}] ${title}\n\n${body}\n`;
  return { folder, name: `[${date}] ${title}.txt`, date, title, size: text.length, mtimeMs: 1, text };
}

const scan = (files: WorklogFileText[], lookbackDays = 30) => scanWorklogs(files, { today: TODAY, lookbackDays, clientOf: (f) => (f === FOLDER ? 'AB Z+' : '') });

describe('상태 낱말 (status.ts)', () => {
  it('줄 끝의 낱말만 상태로 본다', () => {
    expect(lineStatus('원인 확인 중 — 고객 회신 대기')?.cls).toBe('wait');
    expect(lineStatus('현장 적용 여부 확인 필요')?.word).toBe('적용 여부 확인 필요');
    expect(lineStatus('조회 요청 예정.')?.cls).toBe('todo');
    expect(lineStatus('패치 적용 (완료)')?.cls).toBe('done');
    // 문장 중간 — 상태가 아니라 서술
    expect(lineStatus('확인 필요한 항목을 목록으로 정리')).toBeNull();
    expect(lineStatus('회신 대기 건 3개 재확인')).toBeNull();
    expect(lineStatus('대상: 수집 서버 2대')).toBeNull();
  });

  it('한 줄에 여럿이면 마지막 낱말, 같은 자리면 긴 낱말', () => {
    expect(lineStatus('안내 완료 — 고객 회신 대기')?.cls).toBe('wait');
    expect(lineStatus('고객 회신 대기였으나 전달 완료')?.word).toBe('전달 완료');
    expect(lineStatus('설정 변경 안내 완료')?.word).toBe('안내 완료');
  });

  it('기다리는 대상은 줄표 뒤나 줄머리의 한 낱말만', () => {
    const at = (t: string) => waitingOnOf(t, lineStatus(t)!);
    expect(at('원인 확인 중 — 고객 회신 대기')).toBe('고객');
    expect(at('제조사 회신 대기')).toBe('제조사');
    expect(at('원인 확인 중 회신 대기')).toBe('');
    expect(at('— 회신 대기')).toBe('');
  });
});

describe('작업일지 → 후보 (scanWorklogs)', () => {
  it('마지막 상태가 열린 사안만 후보가 되고, 칸이 채워진다', () => {
    const r = scan([
      file('2026-11-18', '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 로그 회수 후 원인 확인\n- 대상: 수집 서버 2대\n- 원인 확인 중 — 제조사 회신 대기'),
      file('2026-11-12', '■ (담당A/메신저) 웹훅 연동 설정 전수 확인\n※ 담당B 대리님에게 조회 요청 예정'),
      file('2026-11-20', '■ (담당C/유선) 알림 설정 문의\n▶ 설정 방법 안내\n- 안내 완료'),
    ]);
    expect(r.candidates.map((c) => c.title)).toEqual(['수집 누락 원인 문의', '웹훅 연동 설정 전수 확인']);
    const c = r.candidates[0];
    expect(c).toMatchObject({ cls: 'wait', client: 'AB Z+', who: '홍길동', waitingOn: '제조사', date: '2026-11-18', source: 'worklog' });
    expect(c.anchor).toMatchObject({ folder: FOLDER, line: 3, nth: 0, source: '홍길동/메일' });
    expect(r.candidates[1].cls).toBe('todo');
    expect(r.files).toBe(3);
  });

  it('같은 사안이 뒤 날짜에 닫히면 후보가 아니다', () => {
    const r = scan([
      file('2026-11-10', '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 문의\n- 제조사 회신 대기'),
      file('2026-11-17', '■ (홍길동/메일) 수집 누락 원인 문의 (11/10 문의 후속)\n▶ 회신 내용 고객 안내\n- 안내 완료'),
    ]);
    expect(r.candidates).toEqual([]);
    expect([...r.closed.values()]).toEqual(['2026-11-17']);
  });

  it('닫힌 뒤 다시 열리면 다시 후보다', () => {
    const r = scan([
      file('2026-11-10', '■ 저장소 증설\n▶ 용량 산정\n- 전달 완료'),
      file('2026-11-19', '■ 저장소 증설\n▶ 재산정 요청 접수\n- 대응 예정'),
    ]);
    expect(r.candidates.map((c) => c.date)).toEqual(['2026-11-19']);
  });

  it('기간보다 오래된 열린 사안은 세기만 한다', () => {
    const r = scan([file('2026-09-01', '■ 오래된 문의\n※ 대응 예정'), file('2026-11-20', '■ 새 문의\n※ 대응 예정')]);
    expect(r.candidates.map((c) => c.title)).toEqual(['새 문의']);
    expect(r.older).toBe(1);
  });

  it('회의 블록·제목 줄·전달물 원문·상태 없는 사안은 읽지 않는다', () => {
    const r = scan([
      file(
        '2026-11-20',
        [
          '■ MX 주간 미팅 회의 (캘린더 일정)',
          '▶ 다음 주 일정 확인 필요',
          '',
          '■ (홍길동/메일) 조회 쿼리 전달 (11/18 문의 후속)',
          '▶ 쿼리 작성 후 전달',
          '※ 조회 쿼리',
          'select * from t where note = \'확인 필요\'',
          '',
          '■ (담당A/메일) 대응 예정',
          '▶ 로그 확인',
        ].join('\n'),
      ),
    ]);
    expect(r.candidates).toEqual([]);
  });

  it('상태 줄의 M/D + 예정은 기한이 된다 — 일지 날짜 이후로', () => {
    const r = scan([file('2026-11-20', '■ 패치 일정\n▶ 일정 협의\n- 12/2 패치 적용 예정\n- 고객 회신 대기')]);
    expect(r.candidates[0].due).toBeNull(); // 마지막 상태 줄(회신 대기)에는 날짜가 없다
    const r2 = scan([file('2026-11-20', '■ 패치 일정\n▶ 일정 협의\n- 12/2 패치 적용 전 백업 대응 예정')]);
    expect(r2.candidates[0].due).toBe('2026-12-02');
  });

  it('blockStatus는 사안 안의 마지막 상태 줄을 준다', () => {
    const doc = parseWorklog('■ 사안\n▶ 문의\n- 회신 대기\n▶ 회신 확인\n- 조치 안내 완료');
    expect(blockStatus(doc.blocks[0])?.status.cls).toBe('done');
  });
});

describe('사안 닻 (anchor.ts)', () => {
  const TEXT = ['[2026-11-18] 점검', '', '■ (홍길동/메일) 수집 누락 원인 문의', '▶ 로그 회수', '- 원인 확인 중', '', '■ 알림 설정', '※ 대응 예정', '', '■ (홍길동/메일) 수집 누락 원인 문의', '▶ 재문의'].join('\n');
  const FILE = { folder: FOLDER, name: '[2026-11-18] 점검.txt', date: '2026-11-18' };

  it('같은 제목의 사안이 둘이면 순번으로 가린다', () => {
    const doc = parseWorklog(TEXT);
    const second = anchorOf(FILE, doc, doc.blocks[2]);
    expect(second).toMatchObject({ nth: 1, line: 10 });
    expect(findAnchor(doc, second)?.startLine).toBe(10);
  });

  it('위에 줄이 끼어 밀려도 다시 찾는다', () => {
    const doc = parseWorklog(TEXT);
    const a = anchorOf(FILE, doc, doc.blocks[1]);
    const moved = parseWorklog(TEXT.replace('- 원인 확인 중', '- 원인 확인 중\n- 대상 2대\n- 로그 첨부'));
    expect(findAnchor(moved, a)?.startLine).toBe(9);
    expect(findAnchor(moved, a)?.title).toBe('알림 설정');
  });

  it('커서 줄이 속한 사안을 찾는다', () => {
    const doc = parseWorklog(TEXT);
    expect(caseAtLine(doc, 1)).toBeNull();
    expect(caseAtLine(doc, 5)?.title).toBe('수집 누락 원인 문의');
    expect(caseAtLine(doc, 8)?.title).toBe('알림 설정');
  });

  it('일정 줄은 마지막 ▶ 묶음 끝에, ▶가 없으면 ■ 아래 ※로 넣는다', () => {
    const doc = parseWorklog(TEXT);
    const a = insertScheduleLine(TEXT, doc.blocks[0], '12/2 패치 적용 예정').split('\n');
    expect(a.slice(2, 7)).toEqual(['■ (홍길동/메일) 수집 누락 원인 문의', '▶ 로그 회수', '- 원인 확인 중', '- 12/2 패치 적용 예정', '']);
    const b = insertScheduleLine(TEXT, doc.blocks[1], '12/2 재확인 예정').split('\n');
    expect(b.slice(6, 9)).toEqual(['■ 알림 설정', '※ 대응 예정', '※ 12/2 재확인 예정']);
    // 넣은 줄은 일지 형식으로 읽힌다
    expect(parseWorklog(a.join('\n')).blocks[0].acts[0].facts.map((f) => f.text)).toEqual(['원인 확인 중', '12/2 패치 적용 예정']);
  });
});

describe('날짜 (dates.ts)', () => {
  it('빠른 입력 끝의 M/D는 기한이 된다', () => {
    expect(parseQuickAdd('백업 절차 확인 11/27', TODAY)).toEqual({ title: '백업 절차 확인', due: '2026-11-27' });
    expect(parseQuickAdd('  체크리스트   갱신 ', TODAY)).toEqual({ title: '체크리스트 갱신', due: null });
    // 날짜뿐이거나 없는 날짜면 제목으로 둔다
    expect(parseQuickAdd('11/27', TODAY)).toEqual({ title: '11/27', due: null });
    expect(parseQuickAdd('점검 2/30', TODAY)).toEqual({ title: '점검 2/30', due: null });
    expect(parseQuickAdd('버전 3/4 비교표', TODAY).due).toBeNull();
  });

  it('지난 M/D는 다음 해로 본다 (12월에 적은 1/5)', () => {
    expect(resolveMonthDay(1, 5, '2026-12-20')).toBe('2027-01-05');
    expect(resolveMonthDay(11, 23, TODAY)).toBe(TODAY);
    expect(resolveMonthDay(13, 1, TODAY)).toBeNull();
  });
});
