import { describe, expect, it } from 'vitest';
import type { AiCompleteResult } from '../electron/ai-types';
import { Masker } from '../src/ai/mask';
import {
  applyWorklogTidy,
  BLOCK_SCHEMA,
  BLOCK_SYSTEM,
  cleanRequester,
  followSuffix,
  maskNames,
  planBlockFromChat,
  planWorklogTidy,
  renderBlocks,
  reviewWorklogTidy,
  speakerNames,
  splitLine,
  titledNames,
} from '../src/ai/worklogAi';
import { parseWorklog } from '../src/worklog/format';

type Ok = Extract<AiCompleteResult, { ok: true }>;
const ok = (json: unknown): Ok => ({ ok: true, json, model: 'claude-opus-5-5', usage: { input: 1000, output: 500, cacheRead: 0 }, fallbackUsed: false, ms: 3000 });

// 가명·합성 대화
const CHAT = `[홍길동] [오후 2:31] 192.0.2.40 서버 프로세스 감시 이벤트가 메일로 안 와요
[박민수] [오후 2:40] 이벤트 설정 > 수신 대상에 메일 그룹 추가하시면 됩니다. 버전은 2.5.1 이상이어야 해요
[박민수] [오후 2:41] 조회는 이걸로 하세요
SELECT oid FROM agent WHERE pid = 1234;
[홍길동] [오후 2:50] 됐습니다 감사합니다`;

describe('대화 → 블록', () => {
  const plan = planBlockFromChat(
    { chat: CHAT, channel: '메신저', requester: '', myName: '박민수', date: '2026-10-20', knownNames: ['홍길동', '김철수'] },
    'claude-opus-5-5',
  )!;

  it('알고 있는 이름·내 이름·IP를 가려서 보낸다', () => {
    expect(plan.request.user).not.toMatch(/홍길동|박민수|192\.0\.2\.40/);
    expect(plan.request.user).toContain('대화 속 엔지니어(나): ⟦P');
    expect(plan.masker.summary()).toMatchObject({ P: 2, IP: 1 });
    expect(plan.request.schema).toBeTruthy();
  });

  it('응답 → 작업일지 블록 (이름 되살림·호칭 떼기, 전달물은 원문 그대로일 때만)', () => {
    const p = plan.masker;
    const tokenOf = (name: string) => maskNames(name, ['홍길동', '박민수'], new Masker()) && [...plan.request.user.matchAll(/⟦P\d⟧/g)].map((m) => m[0]).find((t) => p.original(t) === name)!;
    const res = ok({
      blocks: [
        {
          requester: `${tokenOf('홍길동')} 님`,
          title: '프로세스 감시 이벤트 메일 미수신 문의',
          notes: [],
          acts: [{ text: '수신 대상 메일 그룹 추가 방법 안내', facts: [{ text: '에이전트 2.5.1 이상 필요', details: ['⟦IP1⟧ 서버 대상'] }] }],
          deliverables: [
            { name: '에이전트 조회 쿼리', raw: 'SELECT oid FROM agent WHERE pid = 1234;' },
            { name: '바뀐 쿼리', raw: 'SELECT * FROM agent;' },
          ],
        },
      ],
      questions: ['해결 여부 확인'],
    });
    const r = renderBlocks(plan, res);
    expect(r.text).toBe(
      [
        '■ (홍길동/메신저) 프로세스 감시 이벤트 메일 미수신 문의',
        '',
        '▶ 수신 대상 메일 그룹 추가 방법 안내',
        '- 에이전트 2.5.1 이상 필요',
        '  > 192.0.2.40 서버 대상',
        '',
        '※ 에이전트 조회 쿼리',
        'SELECT oid FROM agent WHERE pid = 1234;',
      ].join('\n'),
    );
    expect(r.warnings.join(' ')).toContain('바뀐 쿼리');
    expect(r.questions).toEqual(['해결 여부 확인']);
    expect(r.usd).toBeGreaterThan(0);
  });

  it('대화에 없는 숫자는 경고한다', () => {
    const r = renderBlocks(plan, ok({ blocks: [{ requester: '', title: '패치 3.1.0 적용', notes: [], acts: [], deliverables: [] }], questions: [] }));
    expect(r.text).toBe('■ 패치 3.1.0 적용');
    expect(r.warnings[0]).toContain('3.1.0');
  });

  it('호칭 떼기', () => {
    expect(cleanRequester('홍길동 대리님, 김철수 책임')).toBe('홍길동, 김철수');
  });
});

// v0.13.2 — 요청 내용을 작업일지 루틴 형식(STEP 4·5)과 다시 대조
describe('대화 → 블록: 요청 내용이 지금 일지 형식과 맞는다', () => {
  it('지침에 루틴의 상태 어휘·URL 금지·회의 모양·수행 불명 처리가 있다', () => {
    for (const w of ['안내 완료', '전달 완료', '패치 전달', '제조사지원 회신 대기', '고객 회신 대기']) {
      expect(BLOCK_SYSTEM).toContain(w);
    }
    // 2026-11-24 — 루틴과 같이, 대화에 없는 계획·확인 사항을 상태로 지어 붙이지 않는다(홈이 남은 할 일로 읽는다)
    expect(BLOCK_SYSTEM).toContain('상태는 두 가지만 쓴다');
    expect(BLOCK_SYSTEM).toContain('acts와 notes를 비운다');
    expect(BLOCK_SYSTEM).toContain('지어 붙이지 않는다');
    expect(BLOCK_SYSTEM).not.toContain('notes에 상태만 쓴다');
    expect(BLOCK_SYSTEM).not.toContain('패치·설정 안내를 받았을 뿐이면 "현장 적용 여부 확인 필요"');
    expect(BLOCK_SYSTEM).toContain(' — 제조사지원 회신 대기');
    expect(BLOCK_SYSTEM).toMatch(/URL을 쓰지 않는다\(전달물 원문 안은 예외\)/);
    expect(BLOCK_SYSTEM).toContain('⟦URL1⟧은 전달물 원문에만 둔다');
    expect(BLOCK_SYSTEM).toContain('{회의명} 회의');
    expect(BLOCK_SYSTEM).toContain('전달물로 남긴 내용은 facts로 다시 요약하지 않는다');
    expect(BLOCK_SYSTEM).toContain('원인 한 줄과 조치 한 줄');
    // 실제 일지(2026-09 이후 28개)에는 시각·요일이 없고 일정은 M/D로 적혀 있다
    expect(BLOCK_SYSTEM).toContain('날짜를 M/D로 쓴다');
    expect(BLOCK_SYSTEM).toContain('날짜를 계산해 넣지 말고');
    // 지침의 칸 이름이 응답 형식의 칸과 어긋나지 않는다
    const block = BLOCK_SCHEMA.properties.blocks.items;
    for (const key of block.required) expect(BLOCK_SYSTEM).toContain(key);
    expect(block.required).toContain('followup');
  });

  it('지침에 실제 사람 이름·시각이 든 예시가 없다', () => {
    expect(titledNames(BLOCK_SYSTEM)).toEqual([]);
    expect(BLOCK_SYSTEM).not.toMatch(/[가-힣]{2,4}\s?(?:책임|대리|과장|차장|부장)님/);
  });

  it('대화 줄 머리의 화자 이름을 읽는다 (이름 + 시각이 있는 머리만)', () => {
    expect(speakerNames('[윤서준] [오후 2:31] 안녕하세요\n[개발팀 최하늘] [오전 9:05] 네')).toEqual(['윤서준', '개발팀 최하늘', '최하늘']);
    expect(speakerNames('2026년 10월 20일 오후 2:31, 윤서준 : 확인 부탁드립니다')).toEqual(['윤서준']);
    expect(speakerNames('2026. 10. 20. 오후 2:31, 윤서준 대리 : 확인 부탁드립니다')).toEqual(['윤서준']);
    expect(speakerNames('윤서준 대리  오후 2:31\n확인 부탁드립니다')).toEqual(['윤서준']);
    expect(speakerNames('[오후 2:31] 윤서준\n확인 부탁드립니다')).toEqual(['윤서준']);
    // 메모의 머리말·시각 없는 줄은 이름으로 보지 않는다
    expect(speakerNames('원인: 수신 그룹 누락\n조치: 그룹 추가\n재기동 후 14:31 정상')).toEqual([]);
  });

  it('직함·님이 붙은 이름을 읽고, 이어지는 낱말은 이름으로 보지 않는다', () => {
    expect(titledNames('최하늘 책임님께 문의했고 윤서준님이 회신, 박과장님도 확인')).toEqual(['최하늘', '윤서준', '박과장']);
    expect(titledNames('서버의 프로세스 감시, 서울 대리점, 고객의 대표가 요청, 기술팀 팀장 확인, 담당자님 회신')).toEqual([]);
  });

  it('일지에 없는 화자·제3자의 이름도 가려서 보낸다', () => {
    const chat = [
      '[윤서준] [오후 2:31] 192.0.2.40 서버 패치 일정 문의드립니다. 최하늘 책임님께도 공유 부탁드려요',
      '[박민수] [오후 2:40] 내일 적용 예정입니다',
    ].join('\n');
    const p = planBlockFromChat({ chat, channel: '카톡', requester: '', myName: '박민수', date: '2026-11-12', knownNames: [] }, 'claude-opus-5-5')!;
    expect(JSON.stringify(p.request)).not.toMatch(/윤서준|최하늘|박민수|192\.0\.2\.40/);
    expect(p.masker.summary()).toMatchObject({ P: 3, IP: 1 });
  });

  it('후속 표시 — 날짜는 대화에 적혀 있을 때만 쓴다', () => {
    expect(followSuffix('', '10/15 문의 건')).toBe('');
    expect(followSuffix(undefined, '')).toBe('');
    expect(followSuffix('10/15', '10/15에 문의드린 건 관련입니다')).toBe(' (10/15 문의 후속)');
    expect(followSuffix('10/15', '10월 15일에 문의드린 건')).toBe(' (10/15 문의 후속)');
    expect(followSuffix('10/15', '지난번 문의드린 건')).toBe(' (후속)');
    expect(followSuffix('10/15', '에이전트 2.10.15 설치')).toBe(' (후속)');
    expect(followSuffix('후속', '지난번 문의드린 건')).toBe(' (후속)');
  });

  const CHAT2 = [
    '[홍길동] [오후 2:31] 10/15에 문의드린 로그 수집 누락 건, 가이드 https://docs.example.com/log 보고 설정했는데 그대로입니다',
    '[박민수] [오후 2:50] 제조사지원에 다시 문의했습니다. 우선 아래 옵션 넣어 주세요',
    'log.forward.enabled=true',
    '[홍길동] [오후 3:10] 넣었습니다',
  ].join('\n');
  const plan2 = planBlockFromChat({ chat: CHAT2, channel: '메신저', requester: '', myName: '박민수', date: '2026-11-12', knownNames: ['홍길동'] }, 'claude-opus-5-5')!;
  const P = (name: string) => [...plan2.request.user.matchAll(/⟦P\d⟧/g)].map((m) => m[0]).find((t) => plan2.masker.original(t) === name)!;

  it('응답을 일지 형식 그대로 만든다 — 줄 종류·빈 줄·후속 표시·상태 꼬리', () => {
    const r = renderBlocks(
      plan2,
      ok({
        blocks: [
          {
            requester: P('홍길동'),
            title: '로그 수집 누락 문의',
            followup: '10/15',
            notes: ['가이드대로 설정 후에도 동일 증상'],
            acts: [
              { text: '제조사지원 재문의', facts: [{ text: '원인: 확인 중 — 제조사지원 회신 대기', details: [] }] },
              { text: '임시 설정 안내', facts: [{ text: '대상: 로그 수집 에이전트', details: ['적용 후 재기동 필요 여부 미확인'] }] },
            ],
            deliverables: [{ name: '로그 수집 옵션', raw: 'log.forward.enabled=true' }],
          },
        ],
        questions: [],
      }),
    );
    expect(r.text).toBe(
      [
        '■ (홍길동/메신저) 로그 수집 누락 문의 (10/15 문의 후속)',
        '※ 가이드대로 설정 후에도 동일 증상',
        '',
        '▶ 제조사지원 재문의',
        '- 원인: 확인 중 — 제조사지원 회신 대기',
        '',
        '▶ 임시 설정 안내',
        '- 대상: 로그 수집 에이전트',
        '  > 적용 후 재기동 필요 여부 미확인',
        '',
        '※ 로그 수집 옵션',
        'log.forward.enabled=true',
      ].join('\n'),
    );
    expect(r.warnings).toEqual([]);
    // 일지 형식 해석기가 같은 줄 종류로 읽는다
    const doc = parseWorklog(`[2026-11-12] 제목\n\n${r.text}`);
    expect(doc.lines.map((l) => l.kind).filter((k) => k !== 'blank' && k !== 'title')).toEqual(['case', 'note', 'act', 'fact', 'act', 'fact', 'detail', 'deliverable', 'raw']);
    expect(doc.blocks[0].source?.names).toEqual(['홍길동']);
  });

  it('본문 줄에 URL이 들어오면 한 번 알린다 (전달물 원문 안은 그대로 둔다)', () => {
    const body = renderBlocks(
      plan2,
      ok({
        blocks: [
          {
            requester: '',
            title: '로그 수집 누락 문의',
            followup: '',
            notes: ['⟦URL1⟧ 가이드 참고'],
            acts: [{ text: '설정 안내', facts: [{ text: '가이드 ⟦URL1⟧ 전달', details: [] }] }],
            deliverables: [],
          },
        ],
        questions: [],
      }),
    );
    expect(body.warnings.filter((w) => w.includes('URL'))).toHaveLength(1);
    const raw = renderBlocks(
      plan2,
      ok({
        blocks: [{ requester: '', title: '로그 수집 누락 문의', followup: '', notes: [], acts: [], deliverables: [{ name: '옵션', raw: 'log.forward.enabled=true' }] }],
        questions: [],
      }),
    );
    expect(raw.warnings).toEqual([]);
  });

  it('수행 내용이 없으면 ■와 ※만 남는다', () => {
    const r = renderBlocks(plan2, ok({ blocks: [{ requester: P('홍길동'), title: '로그 수집 누락 문의', followup: '후속', notes: ['대응 예정'], acts: [], deliverables: [] }], questions: [] }));
    expect(r.text).toBe('■ (홍길동/메신저) 로그 수집 누락 문의 (후속)\n※ 대응 예정');
  });
});

describe('일지 문장 정돈', () => {
  const TEXT = `[2026-10-20] 제목

■ (홍길동/메신저) 프로세스 감시 설정 문의 했음 (후속)
※ 수신 그룹 미지정

▶ 설정방법 안내 했습니다
- 192.0.2.40 서버 대상
  > 그룹은 프로젝트 단위

※ 조회 쿼리
SELECT 1;`;

  it('마커·출처·끝 표시는 남기고 본문만 보낸다 (원문·1행은 보내지 않는다)', () => {
    expect(splitLine('■ (홍길동/메신저) 문의 (후속)', 'case')).toEqual({ prefix: '■ (홍길동/메신저) ', text: '문의', suffix: ' (후속)' });
    const plan = planWorklogTidy(TEXT, ['홍길동'], 'claude-sonnet-5-5')!;
    expect(plan.lines.map((l) => [l.no, l.kind])).toEqual([
      [3, 'case'],
      [4, 'note'],
      [6, 'act'],
      [7, 'fact'],
      [8, 'detail'],
    ]);
    expect(plan.request.user).not.toContain('SELECT');
    expect(plan.request.user).not.toContain('192.0.2.40');
    expect(plan.request.user).not.toContain('홍길동');
  });

  it('요청자 어휘에 없는 사람도 직함·님이 붙어 있으면 가린다', () => {
    const plan = planWorklogTidy(`${TEXT}\n\n▶ 최하늘 책임님께 조회 요청\n- 윤서준님 회신 대기`, ['홍길동'], 'claude-sonnet-5-5')!;
    expect(plan.request.user).not.toMatch(/최하늘|윤서준|홍길동/);
    expect(plan.request.user).toMatch(/⟦P\d⟧ 책임님께 조회 요청/);
  });

  it('검증 통과한 줄만 바꾸고 접두·접미는 그대로', () => {
    const plan = planWorklogTidy(TEXT, ['홍길동'], 'claude-sonnet-5-5')!;
    const ip = plan.maskedById.get('L7')!;
    const review = reviewWorklogTidy(
      plan,
      ok({
        lines: [
          { id: 'L3', text: '프로세스 감시 설정 문의' },
          { id: 'L6', text: '▶ 설정 방법 안내' },
          { id: 'L7', text: '서버 대상' }, // 자리표시 빠짐 → 적용 안 함
          { id: 'L8', text: '그룹은 프로젝트 단위' },
        ],
        notes: ['L3 줄과 같은 사안이 있음'],
      }),
    );
    expect(ip).toContain('⟦IP1⟧');
    expect(review.changes.map((c) => [c.id, c.ok])).toEqual([
      ['L3', true],
      ['L6', true],
      ['L7', false],
    ]);
    expect(review.notes[0].text).not.toMatch(/L3/);
    const next = applyWorklogTidy(TEXT, plan, review, new Set(['L3', 'L6', 'L7']));
    expect(next.split('\n')[2]).toBe('■ (홍길동/메신저) 프로세스 감시 설정 문의 (후속)');
    expect(next.split('\n')[5]).toBe('▶ 설정 방법 안내');
    expect(next.split('\n')[6]).toBe('- 192.0.2.40 서버 대상');
    expect(next.endsWith('SELECT 1;')).toBe(true);
  });
});
