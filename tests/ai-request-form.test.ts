/**
 * AI 정돈이 실제로 보내는 요청 내용 (v0.13.1) — 지금 템플릿·형식의 모양과 맞는지 고정한다.
 * - 이메일: 요청은 고른 템플릿의 정의에서 만든다(메일 구성·칸 예시·칸 역할). 라이선스 키는 보내지 않는다.
 * - 주간보고: 형식 v2 §4 — 메일 제목만 고정, 줄 종류별 뜻, 여러 줄 턴의 줄 수.
 * 픽스처의 주소·이름·키는 모두 합성 값이다.
 */
import { describe, expect, it } from 'vitest';
import { parseTolerant, serialize } from '../src/core/index';
import { Masker } from '../src/ai/mask';
import { WEEKLY_SYSTEM, applyWeekly, checkLine, planWeeklyTidy, reviewWeekly } from '../src/ai/weeklyTidy';
import { SUBJECT_KEY, applyEmail, bodyToSkeleton, describeLayout, emailSystem, fieldRole, planEmailTidy, reviewEmail, skeletonToBody } from '../src/ai/emailTidy';
import { getTemplate, validateTemplateData } from '../src/email/templates';
import type { EmailField, EmailTemplate } from '../src/email/types';
import type { AiCompleteResult } from '../electron/ai-types';

const PROFILE = { name: '홍길동', email: '', company: '예시IT' };
const ok = (json: unknown): Extract<AiCompleteResult, { ok: true }> => ({
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

// ── 이메일 ──────────────────────────────────────────────────────────────────
describe('이메일 — 칸의 역할', () => {
  const f = (over: Partial<EmailField>): EmailField => ({ key: 'x', label: '칸', type: 'text', ...over });

  it('제목·도입·이슈·긴 글은 글 칸, 날짜는 보내지 않고, 나머지는 사실 칸', () => {
    expect(fieldRole(f({ subjectOnly: true }))).toBe('prose');
    expect(fieldRole(f({ introLead: true }))).toBe('prose');
    expect(fieldRole(f({ bodyLead: true }))).toBe('prose');
    expect(fieldRole(f({ type: 'textarea' }))).toBe('prose');
    expect(fieldRole(f({ type: 'date' }))).toBe('locked');
    expect(fieldRole(f({ type: 'select', options: ['a'] }))).toBe('fill');
    expect(fieldRole(f({ key: 'serverOs', label: '수집서버 OS 및 버전' }))).toBe('fill');
  });

  it('라이선스·키·비밀번호로 끝나는 이름의 칸은 보내지 않는다 (템플릿에 표시가 없어도)', () => {
    expect(fieldRole(f({ key: 'licenseKey', label: '라이선스', type: 'textarea' }))).toBe('locked');
    expect(fieldRole(f({ key: 'apiKey', label: 'API 키' }))).toBe('locked');
    expect(fieldRole(f({ key: 'pw', label: '초기 비밀번호' }))).toBe('locked');
    expect(fieldRole(f({ key: 'token', label: '접속 토큰' }))).toBe('locked');
    // 이름에 license가 들어가도 값이 키가 아닌 칸은 그대로
    expect(fieldRole(f({ key: 'licenseType', label: '유형' }))).toBe('fill');
    expect(fieldRole(f({ key: 'monkey', label: '담당' }))).toBe('locked'); // 'key'로 끝나면 보수적으로 잠근다
  });

  it('템플릿의 ai 표시가 가장 먼저다, 잘못된 값의 템플릿 파일은 걸러 낸다', () => {
    expect(fieldRole(f({ type: 'textarea', ai: 'fill' }))).toBe('fill');
    expect(fieldRole(f({ key: 'licenseKey', label: '라이선스', ai: 'prose' }))).toBe('prose');
    expect(fieldRole(f({ subjectOnly: true, ai: 'locked' }))).toBe('locked');
    const base = { id: 't', name: '서식', subjectPattern: '{topic}', hasBody: false, sections: [{ title: '', fields: [{ key: 'topic', label: '제목', type: 'text' }] }] };
    const withAi = (ai: unknown) => ({ ...base, sections: [{ title: '', fields: [{ ...base.sections[0].fields[0], ai }] }] });
    expect(validateTemplateData(withAi('locked')).ok).toBe(true);
    expect(validateTemplateData(withAi('secret')).ok).toBe(false);
    // 내장 라이선스 전달 서식의 라이선스 칸은 표시돼 있다
    const lic = getTemplate('license-delivery', PROFILE)!;
    expect(lic.sections.flatMap((s) => s.fields).find((x) => x.key === 'licenseKey')?.ai).toBe('locked');
  });
});

describe('이메일 — 라이선스 키 전달: 키는 어디에도 실려 나가지 않는다', () => {
  const template = getTemplate('license-delivery', PROFILE)!;
  const KEY = 'test0000key01-test0000key002-test0000key003';
  const doc = {
    templateId: 'license-delivery',
    fieldValues: {
      topic: '수집서버 라이선스 전달드려요',
      intro: '라이선스키 발급되서 보내드립니다 설치할때 필요하니 복사가능하게 해주세요',
      licenseType: 'POC용',
      customer: '가나통신',
      project: '',
      startDate: '2026-11-01',
      endDate: '2026-12-31',
      serverIp: '192.0.2.40',
      licenseKey: KEY,
    },
    bodyHtml: '',
  };
  const plan = planEmailTidy(template, doc, 'claude-opus-5-5')!;

  it('요청(지침·입력) 어디에도 라이선스 키·날짜·IP 원문이 없다', () => {
    const sent = `${plan.request.system}\n${plan.request.user}`;
    expect(sent).not.toContain(KEY);
    expect(sent).not.toContain('test0000key01');
    expect(sent).not.toContain('2026-12-31');
    expect(sent).not.toContain('192.0.2.40');
    expect(sent).toContain('⟦IP1⟧');
    const fields = payloadOf(plan.request.user).fields as Array<{ key: string; role: string }>;
    expect(fields.map((x) => x.key)).toEqual(['topic', 'intro', 'licenseType', 'customer', 'project', 'serverIp']);
    expect(plan.fields.find((x) => x.field.key === 'licenseKey')).toMatchObject({ role: 'locked', value: '' });
    // 가림 사전에도 들어가지 않는다 (읽지 않는다)
    expect(plan.masker.summary()).toEqual({ IP: 1 });
    expect(payloadOf(plan.request.user).body).toBe('');
  });

  it('지침은 이 서식의 모양을 말한다 — 표의 칸, 본문 없음, 제조사지원 문구 없음', () => {
    const s = plan.request.system;
    expect(s).toContain('라이선스 키를 고객');
    expect(s).toContain('표 — 유형 · 최종고객 · 프로젝트명 · 시작일 · 종료일 · 수집서버 IP · 라이선스.');
    expect(s).toContain('메일 제목: "메일 제목"(topic) 칸의 값이 그대로 제목이 된다.');
    expect(s).not.toContain('제조사지원');
    expect(s).not.toContain('홍길동'); // 인사말에 든 이름은 보내지 않는다
  });

  it('모델이 라이선스 칸을 돌려줘도 무시하고, 글 칸만 바꾼다', () => {
    const review = reviewEmail(
      plan,
      ok({
        fields: [
          { key: 'topic', value: '수집서버 라이선스 전달드립니다.' },
          { key: 'intro', value: '제조사 수집서버 라이선스 키가 발급되어 전달드립니다. 수집서버 설치에 필요하오니 복사가 가능하도록 부탁드립니다.' },
          { key: 'licenseKey', value: 'z9z9z9z9z9z9z-aaaaaaaaaaaaa1-bbbbbbbbbbbbb2' },
          { key: 'endDate', value: '2027-01-01' },
        ],
        body: '',
        notes: [],
      }),
    );
    expect(review.changes.map((c) => c.id)).toEqual(['field:topic', 'field:intro']);
    const next = applyEmail(doc, review, new Set(review.changes.map((c) => c.id)));
    expect(next.fieldValues.licenseKey).toBe(KEY);
    expect(next.fieldValues.endDate).toBe('2026-12-31');
    expect(next.fieldValues.topic).toBe('수집서버 라이선스 전달드립니다.');
  });

  it('본문에 붙여 넣은 제조사 키 모양 문자열도 가린다 (가림 규칙)', () => {
    const m = new Masker();
    expect(m.mask(`라이선스 ${KEY} 입니다`)).toBe('라이선스 ⟦KEY1⟧ 입니다');
    expect(m.mask('job-manager-x.y.z, collector-x.y.z')).toBe('job-manager-x.y.z, collector-x.y.z');
  });
});

describe('이메일 — 설치파일 전달: 본문의 줄 모양을 지킨다', () => {
  const template = getTemplate('install-delivery', PROFILE)!;
  const body =
    '제조사 수집서버 설치화일 전달 드립니다.<br>- 다운링크 : https://files.example.com/vendor/server-3.1.1.tar.gz<br><br>' +
    '제조사 서버모니터링 에이전트 전달 드립니다.<br>- (Linux, Windows v2.9.5) : https://files.example.com/agent/linux<br>- (Solaris, HP-UX, AIX v2.7.1) : https://files.example.com/agent/unix';
  const doc = { templateId: 'install-delivery', fieldValues: { topic: '제조사 수집서버 설치파일 전달', intro: '' }, bodyHtml: body };
  const plan = planEmailTidy(template, doc, 'claude-opus-5-5')!;

  it('지침 — 표 없이 본문이 전부, 표준 문구의 모양, 링크는 가려서', () => {
    const s = plan.request.system;
    expect(s).toContain('본문(body) — 표 없이 도입 문장 아래에 바로 온다. 메일 내용의 전부다.');
    expect(s).not.toMatch(/\d\. 표/);
    expect(s).toContain('이 양식의 본문 표준 문구');
    expect(s).toContain('    제조사 수집서버 설치파일 전달 드립니다.\n    - 다운링크 : ');
    expect(s).not.toContain('제조사지원');
    expect(plan.request.user).not.toContain('files.example.com');
    expect(plan.skeleton).toContain('- 다운링크 : ⟦URL1⟧<br>');
  });

  it('라벨 줄을 목록 태그로 바꿔 오면 받지 않고, 모양을 지킨 교정은 링크를 되살려 적용한다', () => {
    const asList = reviewEmail(
      plan,
      ok({
        fields: [],
        body: '<p>제조사 수집서버 설치파일 전달 드립니다.</p><ul><li>다운링크 : ⟦URL1⟧</li></ul><p>제조사 서버모니터링 에이전트 전달 드립니다.</p><ul><li>(Linux, Windows v2.9.5) : ⟦URL2⟧</li><li>(Solaris, HP-UX, AIX v2.7.1) : ⟦URL3⟧</li></ul>',
        notes: [],
      }),
    );
    expect(asList.changes[0]).toMatchObject({ id: 'body', ok: false, label: '전달 내용' });
    expect(asList.changes[0].reason).toContain("'- '");

    const kept = reviewEmail(
      plan,
      ok({
        fields: [],
        body: plan.skeleton.replace('설치화일', '설치파일'),
        notes: [],
      }),
    );
    expect(kept.changes[0]).toMatchObject({ id: 'body', ok: true });
    const next = applyEmail(doc, kept, new Set(['body']));
    expect(next.bodyHtml).toContain('제조사 수집서버 설치파일 전달 드립니다.<br>- 다운링크 : https://files.example.com/vendor/server-3.1.1.tar.gz<br>');
    expect(next.bodyHtml).toContain('- (Solaris, HP-UX, AIX v2.7.1) : https://files.example.com/agent/unix');
  });
});

describe('이메일 — 기술 문의: 메일 구성과 칸 예시를 함께 보낸다', () => {
  const template = getTemplate('tech-inquiry', PROFILE)!;
  const doc = {
    templateId: 'tech-inquiry',
    fieldValues: { topic: '[제트플러스] 이벤트 두번 옴', intro: '', issue: '이벤트 중복', requestDate: '2026-11-12', customer: '제트플러스', serverOs: '' },
    bodyHtml: '<p>서버 192.0.2.5 에서 이벤트가 두번씩 와요</p><p>OS 는 RHEL 8.10 입니다</p>',
  };

  it('구성 설명은 화면에 그려지는 순서와 같다', () => {
    expect(describeLayout(template)).toBe(
      [
        '1. 인사말 — 앱이 자동으로 넣는다(보내는 사람을 밝히는 한 줄).',
        '2. 도입 문장 — "도입 문장"(intro) 칸. 인사말 바로 아래 한 문단으로 들어간다.',
        '3. 표 [구분 | 상세내용] — 기본 정보: 요청일자 · 고객사명 · 프로젝트명 · 수집서버 OS 및 버전 · 수집서버 스펙 · 문의 제품 / 제조사 정보: 계약 유형 · 서비스 유형 · 수집서버 버전 · 에이전트 버전 · 로그파일. 칸에 적은 값이 그대로 들어간다.',
        '4. 표의 마지막 "요청내용" 행 — 맨 위에 굵은 줄 "이슈 : (issue 칸의 값)", 그 아래에 본문(body).',
        '5. 맺음말 — 앱이 자동으로 넣는다.',
        '메일 제목: "메일 제목"(topic) 칸의 값이 그대로 제목이 된다.',
      ].join('\n'),
    );
    expect(emailSystem(template)).toContain('제조사지원가 답하려면');
  });

  it('글 칸에만 예시(placeholder)를 붙인다 — 사실 칸에는 붙이지 않는다', () => {
    const fields = payloadOf(planEmailTidy(template, doc, 'claude-opus-5-5')!.request.user).fields as Array<Record<string, string>>;
    const by = Object.fromEntries(fields.map((x) => [x.key, x]));
    expect(by.topic).toMatchObject({ role: 'prose', example: '[제트플러스] 알림 이름이 같을 때 규칙 활성화/비활성화 개선 요청' });
    expect(by.intro).toMatchObject({ role: 'prose', example: '제트플러스 지원 중 개선 요청사항이 있어 메일 드립니다.' });
    expect(by.serverOs).toMatchObject({ role: 'fill', value: '' });
    expect(by.serverOs).not.toHaveProperty('example');
    expect(by.requestDate).toBeUndefined();
  });

  it('글 칸에 원문에 없는 숫자·버전을 넣어 오면 받지 않는다', () => {
    const plan = planEmailTidy(template, doc, 'claude-opus-5-5')!;
    const review = reviewEmail(
      plan,
      ok({
        fields: [
          { key: 'issue', value: '동일 이벤트 3회 중복 수신' }, // 3회는 원문에 없다
          { key: 'intro', value: '제트플러스 지원 중 확인이 필요한 사항이 있어 메일 드립니다.' },
        ],
        body: '',
        notes: [],
      }),
    );
    const by = Object.fromEntries(review.changes.map((c) => [c.id, c]));
    expect(by['field:issue']).toMatchObject({ ok: false });
    expect(by['field:issue'].reason).toContain('원문에 없는 숫자');
    expect(by['field:intro'].ok).toBe(true);
  });

  it('제목을 직접 고쳐 둔 문서 — 그 제목을 다듬고, 쓰이지 않는 제목 칸은 보내지 않는다', () => {
    const manual = { ...doc, subject: '[제트플러스] 이벤트가 두번씩 오는 문제 문의드림' };
    const plan = planEmailTidy(template, manual, 'claude-opus-5-5')!;
    const fields = payloadOf(plan.request.user).fields as Array<Record<string, string>>;
    expect(fields[0]).toMatchObject({ key: SUBJECT_KEY, label: '메일 제목', role: 'prose', value: manual.subject });
    expect(fields.some((x) => x.key === 'topic')).toBe(false);
    expect(plan.request.system).toContain(`("메일 제목"(${SUBJECT_KEY}) 칸)이 그대로 쓰인다`);
    const review = reviewEmail(plan, ok({ fields: [{ key: SUBJECT_KEY, value: '[제트플러스] 동일 이벤트 중복 수신 문의' }], body: '', notes: [] }));
    const next = applyEmail(manual, review, new Set(review.changes.map((c) => c.id)));
    expect(next.subject).toBe('[제트플러스] 동일 이벤트 중복 수신 문의');
    expect(next.fieldValues.topic).toBe(doc.fieldValues.topic);
    // 제목을 고치지 않은 문서는 subject가 생기지 않는다
    expect(applyEmail(doc, review, new Set()).subject).toBeUndefined();
  });
});

describe('이메일 — 본문 서식과 팀·개인 템플릿', () => {
  it('붙여 넣은 글의 서식(style)은 그대로 보내고 되살린다 — 모델이 새로 만든 서식은 버린다', () => {
    const m = new Masker();
    const html = '<p class="x" data-id="1"><span style="color: red;">주의</span> 재시작 후에도 동일</p>';
    const { skeleton, blocks, styles } = bodyToSkeleton(html, m);
    expect(skeleton).toBe('<p><span style="color: red;">주의</span> 재시작 후에도 동일</p>');
    expect([...styles]).toEqual(['color: red;']);
    const back = skeletonToBody('<p><span style="color: red;">주의</span> 재시작 후에도 <span style="color: blue;">동일합니다</span></p>', { skeleton, blocks, masker: m, styles });
    expect(back).toMatchObject({ ok: true });
    const out = (back as { html: string }).html;
    expect(out).toContain('color: red');
    expect(out).not.toContain('blue');
    expect(out).toContain('<span>동일합니다</span>');
  });

  it('팀·개인 템플릿 — 제목 패턴·목록형·ai 표시를 템플릿에서 읽어 안내한다', () => {
    const custom: EmailTemplate = {
      id: 'team-check',
      name: '정기점검 결과 안내',
      subjectPattern: '[예시IT] {topic} 안내 ({customer})',
      greeting: '안녕하세요. 예시IT 홍길동입니다.',
      closing: '감사합니다.',
      note: '정기점검 결과를 고객 담당자에게 안내',
      renderStyle: 'bullets',
      hasBody: true,
      sections: [
        {
          title: '',
          fields: [
            { key: 'topic', label: '주제', type: 'text', subjectOnly: true, placeholder: '예: 10월 정기점검 결과' },
            { key: 'customer', label: '고객사', type: 'text' },
            { key: 'apiKey', label: 'API 키', type: 'text' },
            { key: 'memo', label: '비고', type: 'textarea', ai: 'fill' },
          ],
        },
      ],
    };
    const plan = planEmailTidy(custom, { templateId: 'team-check', fieldValues: { topic: '10월 정기 점검결과', customer: '가나통신', apiKey: 'abcd-efgh', memo: '' }, bodyHtml: '<p>점검 결과 이상 없음</p>' }, 'claude-opus-5-5')!;
    const s = plan.request.system;
    expect(s).toContain('상황: "정기점검 결과 안내" 양식의 업무 메일이다. (정기점검 결과를 고객 담당자에게 안내)');
    expect(s).toContain('글머리 목록 — 고객사 · API 키 · 비고.');
    expect(s).toContain('메일 제목: "[예시IT] {topic} 안내 ({customer})" 모양으로 조립된다.');
    expect(s).not.toContain('홍길동');
    const fields = payloadOf(plan.request.user).fields as Array<Record<string, string>>;
    expect(fields.map((x) => [x.key, x.role])).toEqual([
      ['topic', 'prose'],
      ['customer', 'fill'],
      ['memo', 'fill'],
    ]);
    expect(plan.request.user).not.toContain('abcd-efgh');
  });
});
