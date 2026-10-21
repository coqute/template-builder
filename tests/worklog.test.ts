import { describe, expect, it } from 'vitest';
import { parseTolerant, validate } from '@core/index';
import { caseKey, parseCaseHeader, parseWorklog, toFileTitle } from '../src/worklog/format';
import { appendTail, countCases, reconcile } from '../src/worklog/merge';
import { lintWorklog, mergeCaseBlocks, setTitleLine } from '../src/worklog/lint';
import { collectVocabulary, searchTerms, searchWorklogs } from '../src/worklog/search';
import { buildWeeklyMd, defaultFolderMaps, lastMonday, learnFromReports, mondayOf } from '../src/worklog/toWeekly';
import { decodeWorklog, encodeWorklog } from '../electron/worklog-codec';
import type { WorklogFileText } from '../electron/worklog-types';

// 가명·합성 예시 — 실제 일지 내용이 아니다
const DAY = `[2026-10-20] 한강 SRE 프로세스 감시 설정, 관제 개발팀 패치 문의

■ (홍길동/메신저) 프로세스 감시 이벤트 발송 설정 문의
※ 이벤트 수신 그룹 미지정 상태

▶ 설정 방법 안내
- 이벤트 설정 > 수신 대상에 메일 그룹 추가
  > 그룹은 프로젝트 단위로 지정

■ (김철수/메일) 패치 배포 방식 문의
▶ Vendor 기술 문의 발송
- 회신 대기

■ 주간 점검 회의 (캘린더 일정)
※ 회의록: 팀 위키 회의록

▶ 알림 메일 개선 요구사항 정리

■ (이영희) 수집서버 프로젝트 목록 조회 방법 문의
▶ 조회 스크립트 작성 및 공유
- 프로젝트 목록 조회 완료

※ 프로젝트 조회 쿼리
SELECT pid, name
- 이 줄도 원문이다
FROM project;

■ (홍길동/메신저) 프로세스 감시 이벤트 발송 설정 문의 (후속)
▶ 수신 확인`;

const file = (date: string, folder: string, text: string, title = '제목'): WorklogFileText => ({
  folder,
  name: `[${date}] ${title}.txt`,
  date,
  title,
  size: text.length,
  mtimeMs: 0,
  text,
});

describe('작업일지 형식 해석', () => {
  const doc = parseWorklog(DAY);

  it('1행 제목·■ 블록·▶/-/> 계층을 읽는다', () => {
    expect(doc.titleLine).toEqual({ date: '2026-10-20', title: '한강 SRE 프로세스 감시 설정, 관제 개발팀 패치 문의' });
    expect(doc.blocks).toHaveLength(5);
    const b = doc.blocks[0];
    expect(b.source).toEqual({ raw: '홍길동/메신저', names: ['홍길동'], channel: '메신저' });
    expect(b.title).toBe('프로세스 감시 이벤트 발송 설정 문의');
    expect(b.notes.map((n) => n.text)).toEqual(['이벤트 수신 그룹 미지정 상태']);
    expect(b.acts[0].text).toBe('설정 방법 안내');
    expect(b.acts[0].facts[0].details[0].text).toBe('그룹은 프로젝트 단위로 지정');
  });

  it('회의(캘린더 일정)·후속 표시를 떼고, 출처 없는 괄호는 출처로 보지 않는다', () => {
    expect(doc.blocks[2]).toMatchObject({ title: '주간 점검 회의', calendar: true, source: undefined });
    expect(doc.blocks[4]).toMatchObject({ followup: true, title: '프로세스 감시 이벤트 발송 설정 문의' });
    expect(parseCaseHeader('(가람, 조은비/메일) 패치 (10/8 문의 후속)')).toMatchObject({
      source: { names: ['가람', '조은비'], channel: '메일' },
      title: '패치 (10/8 문의 후속)',
    });
  });

  it('▶ 뒤 ※는 전달물 — 다음 줄부터 원문(빈 줄 뒤 - 가 나오기 전까지 `- `도 원문)', () => {
    const b = doc.blocks[3];
    expect(b.deliverables).toHaveLength(1);
    expect(b.deliverables[0].raw).toEqual(['SELECT pid, name', '- 이 줄도 원문이다', 'FROM project;']);
    const kinds = doc.lines.filter((l) => l.block === 3).map((l) => l.kind);
    expect(kinds.filter((k) => k === 'raw')).toHaveLength(3);
    expect(b.acts[0].facts).toHaveLength(1);
  });

  it('옛 번호식(1. 작업 / - 세부)도 블록으로 읽는다', () => {
    const old = parseWorklog('[2026-05-04] 작업\n\n1. 수집서버 점검\n- 디스크 80%\n2. 에이전트 재기동');
    expect(old.blocks.map((b) => [b.kind, b.title, b.looseFacts.length])).toEqual([
      ['numbered', '수집서버 점검', 1],
      ['numbered', '에이전트 재기동', 0],
    ]);
  });

  it('같은 사안 키·파일명 제목', () => {
    expect(caseKey({ title: 'BMS 패치 (10/8 문의 후속)' })).toBe(caseKey({ title: 'BMS  패치' }));
    expect(toFileTitle('A/B: C?')).toBe('A·B· C·');
  });
});

describe('바깥 변경 합치기', () => {
  it('루틴의 덧붙이기는 편집 중인 내용 끝에 붙인다', () => {
    const base = '[2026-10-20] 제목\n\n■ 사안 A';
    const disk = `${base}\n\n■ (홍길동/메일) 사안 B\n▶ 확인\n`;
    const buffer = `${base}\n▶ 내가 방금 쓴 줄`;
    const r = reconcile(base, buffer, disk);
    expect(r.kind).toBe('appended');
    if (r.kind !== 'appended') return;
    expect(r.text).toBe(`${buffer}\n\n■ (홍길동/메일) 사안 B\n▶ 확인\n`);
    expect(countCases(r.tail)).toBe(1);
  });

  it('편집이 없으면 덧붙은 것만 그대로 불러오고, 모르는 변경은 충돌', () => {
    expect(reconcile('a', 'a', 'a\nb')).toEqual({ kind: 'reload', text: 'a\nb' });
    expect(reconcile('a\nb', 'a\nb\nc', 'x\nb')).toEqual({ kind: 'conflict', disk: 'x\nb' });
    expect(reconcile('a', 'a b', 'a')).toEqual({ kind: 'none' });
    expect(reconcile('a', 'x', 'x')).toEqual({ kind: 'reload', text: 'x' });
  });

  it('편집이 없어도 저장한 내용이 빠진 디스크는 묻는다 (루틴이 백업으로 되돌린 경우)', () => {
    expect(reconcile('a\nb\nc', 'a\nb\nc', 'a\nb')).toEqual({ kind: 'conflict', disk: 'a\nb' });
    expect(reconcile('a\nb', 'a\nb', '메모장에서 고침')).toEqual({ kind: 'conflict', disk: '메모장에서 고침' });
  });

  it('같은 꼬리를 두 번 붙이지 않는다', () => {
    expect(appendTail('x\n\n■ B', '\n\n■ B')).toBe('x\n\n■ B');
  });
});

describe('형식 제안', () => {
  it('1행 제목 ≠ 파일명 → 맞추기 두 가지', () => {
    const issues = lintWorklog(DAY, { date: '2026-10-20', title: '다른 제목' });
    const t = issues.find((i) => i.code === 'title-name');
    expect(t?.fixes?.map((f) => f.fix.kind)).toEqual(['rename-file', 'set-title-line']);
  });

  it('같은 사안 ■ 두 개 → 앞 블록으로 합치기', () => {
    const issues = lintWorklog(DAY, null);
    const dup = issues.find((i) => i.code === 'dup-case');
    expect(dup?.fixes?.[0].fix).toEqual({ kind: 'merge-case', keep: 0, drop: 4 });
    const merged = mergeCaseBlocks(DAY, 0, 4);
    expect(merged.match(/프로세스 감시 이벤트 발송 설정 문의/g)).toHaveLength(1);
    expect(merged).toContain('  > 그룹은 프로젝트 단위로 지정\n\n▶ 수신 확인\n\n■ (김철수/메일)');
    // 다른 블록·전달물 원문은 그대로
    expect(merged).toContain('SELECT pid, name\n- 이 줄도 원문이다\nFROM project;');
  });

  it('출처 괄호의 호칭·제목 줄 없음', () => {
    const t = '■ (홍길동 대리님/메신저) 문의\n▶ 안내';
    expect(lintWorklog(t, null).map((i) => i.code)).toContain('source-honorific');
    expect(lintWorklog(t, { date: '2026-10-20', title: '제목' }).map((i) => i.code)).toContain('title-missing');
    expect(setTitleLine(t, '[2026-10-20] 제목')).toBe(`[2026-10-20] 제목\n\n${t}`);
  });
});

describe('검색·어휘', () => {
  const files = [file('2026-10-20', 'AB Z+ 작업', DAY), file('2026-10-19', 'AB Z+ 작업', '■ (박민수/유선) BMS 힙 메모리 변경\n▶ -Xmx4g 적용')];

  it('모든 낱말이 든 파일만, 따옴표는 한 낱말', () => {
    expect(searchTerms('BMS "힙 메모리"')).toEqual(['bms', '힙 메모리']);
    const hits = searchWorklogs(files, 'bms 힙');
    expect(hits.map((h) => h.date)).toEqual(['2026-10-19']);
    expect(hits[0].lines[0]).toEqual({ no: 1, text: '■ (박민수/유선) BMS 힙 메모리 변경', ranges: [[11, 14], [15, 16]] });
  });

  it('요청자·채널을 많이 쓴 순으로 모은다', () => {
    const v = collectVocabulary(files);
    expect(v.requesters[0]).toEqual({ name: '홍길동', count: 2 });
    expect(v.channels.map((c) => c.name)).toEqual(expect.arrayContaining(['메신저', '메일', '유선', '카톡', '현장']));
  });
});

describe('작업일지 → 주간보고', () => {
  const history = parseTolerant(`@PREV 2026-10-05 ~ 2026-10-11
@CURRENT 2026-10-12 ~ 2026-10-18
@AUTHOR 홍길동

# 2026-10-05(월)
@LOC 한강 제트플러스 4F
@CUS 한강 SRE
@SUM [ABZ+] (홍길동/메신저) 이벤트 설정
- 안내

@CUS 한강 관제 개발팀 / (네트워크 부문)
@SUM [ABZ+] (김철수/메일) 패치 문의
- 문의

@CUS 사내 (예시IT)
@SUM [사내] 자료 작성
- 작성
`).report;
  const learn = learnFromReports([history]);

  it('지난 보고에서 요청자별 @CUS와 고객 기본값을 배운다', () => {
    expect(learn.contactCus.get('김철수')).toBe('한강 관제 개발팀 / (네트워크 부문)');
    const maps = defaultFolderMaps(['AB Z+ 작업', '기타 작업 내용'], learn, '예시IT');
    expect(maps).toEqual([
      // 지난 보고에 ABZ+로 썼어도 표준 표기 AB Z+로 (2026-11-10 사용자 지시)
      { folder: 'AB Z+ 작업', client: 'AB Z+', cus: '한강 SRE', loc: '한강 제트플러스 4F' },
      { folder: '기타 작업 내용', client: '사내', cus: '사내 (예시IT)', loc: '한강 제트플러스 4F' },
    ]);
  });

  it('한 주를 주간보고 형식으로 — 검증 오류 없음', () => {
    const maps = defaultFolderMaps(['AB Z+ 작업', '기타 작업 내용'], learn, '예시IT');
    const files = [file('2026-10-20', 'AB Z+ 작업', DAY), file('2026-10-21', '기타 작업 내용', '[2026-10-21] 사내\n\n■ 가이드 문서 작성\n▶ 초안 작성\n- 12쪽')];
    const { md, stats } = buildWeeklyMd({ prevStart: '2026-10-19', author: '홍길동', files, maps, learn, plans: ['@PLAN 2026-10-27 10:00 정기 회의'] });
    expect(md).toContain('@PREV 2026-10-19 ~ 2026-10-25\n@CURRENT 2026-10-26 ~ 2026-11-01\n@AUTHOR 홍길동\n@PLAN 2026-10-27 10:00 정기 회의');
    expect(md).toContain('# 2026-10-19(월)\n\n# 2026-10-20(화)\n@LOC 한강 제트플러스 4F\n@CUS 한강 SRE\n@SUM [AB Z+] (홍길동/메신저) 프로세스 감시 이벤트 발송 설정 문의\n- 이벤트 수신 그룹 미지정 상태\n- 설정 방법 안내\n> 이벤트 설정 > 수신 대상에 메일 그룹 추가\n> 그룹은 프로젝트 단위로 지정\n- 수신 확인');
    expect(md).toContain('@SUM [AB Z+] 주간 점검 회의 참석\n- 알림 메일 개선 요구사항 정리');
    expect(md).toContain('@CUS 한강 관제 개발팀 / (네트워크 부문)\n@SUM [AB Z+] (김철수/메일) 패치 배포 방식 문의');
    expect(md).not.toContain('SELECT pid'); // 전달물 원문은 빼고
    expect(md).not.toContain('회의록:');
    expect(md).toContain('@CUS 사내 (예시IT)\n@SUM [사내] 가이드 문서 작성');
    expect(md).toContain('# 2026-10-24(토)\n@HOLIDAY');
    expect(stats).toMatchObject({ files: 2, items: 5, days: 2, merged: 1 });
    const parsed = parseTolerant(md);
    const v = validate(parsed.report);
    expect([...parsed.diagnostics, ...v.issues].filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('주 계산', () => {
    expect(mondayOf('2026-10-22')).toBe('2026-10-19');
    expect(lastMonday(new Date(2026, 9, 21))).toBe('2026-10-12');
  });
});

describe('파일 바이트 ↔ 본문', () => {
  it('BOM·CRLF를 떼고 저장할 때 되살린다', () => {
    const src = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('가\r\n나\r\n', 'utf8')]);
    const d = decodeWorklog(src);
    expect(d).toMatchObject({ text: '가\n나\n', bom: true, crlf: true, legacyEncoding: false });
    expect(encodeWorklog(d.text, d.bom, d.crlf).equals(src)).toBe(true);
  });

  it('줄바꿈이 섞이면 LF로, UTF-8이 아니면 EUC-KR로 읽는다', () => {
    expect(decodeWorklog(Buffer.from('a\r\nb\nc', 'utf8')).crlf).toBe(false);
    const euckr = Buffer.from([0xb0, 0xa1]); // '가'
    expect(decodeWorklog(euckr)).toMatchObject({ text: '가', legacyEncoding: true });
  });
});
