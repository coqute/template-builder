/**
 * 이메일 서술 → 문의(메일) (v0.25.0) — 편하게 적은 글을 고른 서식의 칸에 맞는 글로 바꾼다.
 * Claude API 호출 자체는 앱(main)에서 실측한다 — 여기서는 보내는 내용(서식 정의에서 만든 요청·가림)과
 * 받은 결과를 다루는 규칙(서술에 없는 것은 넣지 않는다), 넣는 방식, 창의 흐름을 고정한다.
 * 픽스처의 이름·주소·키·사례는 모두 합성 값이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  applyCompose,
  bodyTextToHtml,
  composeNames,
  composeSystem,
  describeLayout,
  fieldRole,
  hasPlaceholder,
  planCompose,
  renderCompose,
} from '../src/ai/emailCompose';
import { getTemplate, validateTemplateData } from '../src/email/templates';
import type { EmailDocState, EmailField, EmailTemplate } from '../src/email/types';
import { ComposeFromTextDialog } from '../src/email/components/ComposeFromTextDialog';
import type { AiCompleteRequest, AiCompleteResult } from '../electron/ai-types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());
afterEach(() => {
  cleanup();
  (window as unknown as { reportApi: unknown }).reportApi = undefined;
});

const PROFILE = { name: '박민수', email: '', company: '예시IT' };
const ok = (json: unknown): Extract<AiCompleteResult, { ok: true }> => ({
  ok: true,
  json,
  model: 'claude-opus-5-5',
  usage: { input: 3000, output: 1500, cacheRead: 0 },
  fallbackUsed: false,
  ms: 9000,
});
const payloadOf = (user: string) => JSON.parse(user.slice(user.indexOf('{'), user.indexOf('<서술>')));

// ── 칸의 역할 ────────────────────────────────────────────────────────────────
describe('칸의 역할', () => {
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

// ── 기술 문의 ────────────────────────────────────────────────────────────────
const 제조사지원 = getTemplate('tech-inquiry', PROFILE)!;
// 대화 한 줄 + 메모 — 이름·IP·URL이 섞인 서술
const TEXT = [
  '[윤서준] [오후 2:31] 서버 192.0.2.5 에서 디스크 이벤트가 10분쯤 늦게 와요',
  '제트플러스 한강SRE 문의. 에이전트 2.9.5, 수집서버 collector-x.y.z (RHEL 8.10).',
  '수집 주기를 5초로 바꿔 봤는데 똑같았음. 최하늘 책임님도 같은 증상이라고 함.',
  '정상 동작인지, 줄일 설정이 있는지 확인 필요. 가이드 https://docs.example.com/event',
].join('\n');
const FRESH: EmailDocState = { templateId: 'tech-inquiry', fieldValues: { requestDate: '2026-11-25', serverSpec: '-', logFile: '-' }, bodyHtml: '' };
const planCre = (text = TEXT, doc = FRESH) => planCompose({ template: 제조사지원, doc, text, myName: PROFILE.name, company: PROFILE.company }, 'claude-opus-5-5')!;

describe('기술 문의 — 보내는 내용은 서식 정의에서 만든다', () => {
  it('구성 설명은 화면에 그려지는 순서와 같다', () => {
    expect(describeLayout(제조사지원)).toBe(
      [
        '1. 인사말 — 앱이 자동으로 넣는다(보내는 사람을 밝히는 한 줄).',
        '2. 도입 문장 — "도입 문장"(intro) 칸. 인사말 바로 아래 한 문단으로 들어간다.',
        '3. 표 [구분 | 상세내용] — 기본 정보: 요청일자 · 고객사명 · 프로젝트명 · 수집서버 OS 및 버전 · 수집서버 스펙 · 문의 제품 / 제조사 정보: 계약 유형 · 서비스 유형 · 수집서버 버전 · 에이전트 버전 · 로그파일. 칸에 적은 값이 그대로 들어간다.',
        '4. 표의 마지막 "요청내용" 행 — 맨 위에 굵은 줄 "이슈 : (issue 칸의 값)", 그 아래에 본문(body).',
        '5. 맺음말 — 앱이 자동으로 넣는다.',
        '메일 제목: "메일 제목"(topic) 칸의 값이 그대로 제목이 된다.',
      ].join('\n'),
    );
  });

  it('지침 — 제목은 [회사] … (고객사), 본문은 발생한 이슈 → 확인한 내용 → 요청 사항 → 참고', () => {
    const s = planCre().request.system;
    expect(s).toContain('"[예시IT] 핵심 현상 또는 요청 (고객사)" 한 줄');
    for (const part of ['part "issue"', 'part "checked"', 'part "ask"', 'part "note"']) expect(s).toContain(part);
    expect(s.indexOf('part "issue"')).toBeLessThan(s.indexOf('part "checked"'));
    expect(s.indexOf('part "checked"')).toBeLessThan(s.indexOf('part "ask"'));
    expect(s).toContain('서술에 없는 사실·원인·결과·수치·검토 내용을 만들지 않는다');
    expect(s).toContain('제조사지원가 답하려면');
    expect(s).not.toContain(PROFILE.name); // 인사말에 든 이름은 보내지 않는다
    // 회사가 비어 있으면 설정의 기본값
    expect(composeSystem(제조사지원, '')).toContain('[예시IT] 핵심 현상');
  });

  it('서술의 이름(대화 화자·직함이 붙은 이름)·IP·URL을 가려서 보낸다', () => {
    const plan = planCre();
    expect(plan.request.user).not.toMatch(/윤서준|최하늘|192\.0\.2\.5|docs\.example\.com/);
    expect(plan.request.user).toContain('<서술>\n[⟦P1⟧] [오후 2:31] 서버 ⟦IP1⟧ 에서');
    expect(plan.masker.summary()).toEqual({ P: 2, IP: 1, URL: 1 });
    // 내 이름도 가린다
    expect(planCre('박민수가 확인한 내용: 재기동 후 동일').request.user).not.toContain('박민수');
  });

  it('칸 — 글 칸에는 예시, 사실 칸에는 보기, 날짜는 보내지 않고, 아는 고객사는 표준 표기를 알려 준다', () => {
    const p = payloadOf(planCre().request.user);
    const by = Object.fromEntries((p.fields as Array<Record<string, unknown>>).map((x) => [x.key, x]));
    expect(by.topic).toMatchObject({ role: 'prose', example: '[예시IT] 알림 이름이 같을 때 규칙 활성화/비활성화 개선 요청 (제트플러스)' });
    expect(by.intro).toMatchObject({ role: 'prose', example: '제트플러스 지원 중 개선 요청사항이 있어 메일 드립니다.' });
    expect(by.serverOs).toEqual({ key: 'serverOs', label: '수집서버 OS 및 버전', role: 'fill' });
    expect(by.contractType).toMatchObject({ role: 'fill', options: ['계약', 'POC', '유상', '무상'] });
    expect(by.requestDate).toBeUndefined();
    // 표의 빈 값 표시(-)는 빈 칸으로 본다
    expect(by.serverSpec).not.toHaveProperty('value');
    expect(p.customers).toEqual(['AB Z+']);
    // 이미 적어 둔 값은 함께 보낸다 (가려서)
    const filled = payloadOf(planCre(TEXT, { ...FRESH, fieldValues: { ...FRESH.fieldValues, customer: '가나스토어', project: '192.0.2.9 관제' } }).request.user);
    const fby = Object.fromEntries((filled.fields as Array<Record<string, unknown>>).map((x) => [x.key, x]));
    expect(fby.customer).toMatchObject({ value: '가나스토어' });
    expect(fby.project).toMatchObject({ value: '⟦IP2⟧ 관제' });
    expect(filled.customers).toEqual(['AB Z+', '가나스토어']);
  });

  it('서술이 비면 보낼 것이 없다', () => {
    expect(planCompose({ template: 제조사지원, doc: FRESH, text: '  \n ' }, 'claude-opus-5-5')).toBeNull();
  });
});

const GOOD = {
  fields: [
    { key: 'topic', value: '[예시IT] 디스크 사용률 이벤트 지연 수신 문의 (AB Z+)' },
    { key: 'intro', value: '제트플러스 지원 중 이벤트 수신 지연 관련 문의가 있어\n메일 드립니다.' },
    { key: 'issue', value: '디스크 이벤트가 10분가량 늦게 수신됨' },
    { key: 'customer', value: '제트플러스' },
    { key: 'project', value: '한강SRE' },
    { key: 'serverOs', value: 'rhel 8.10' },
    { key: 'serverVersion', value: 'collector-x.y.z' },
    { key: 'agentVersion', value: '2.9.5' },
    { key: 'serverSpec', value: '8core 16GB' }, // 서술에 없음
    { key: 'contractType', value: '계약' }, // 보기에는 있지만 서술에 없음
    { key: 'serviceType', value: '클라우드' }, // 보기에 없음
    { key: 'requestDate', value: '2026-11-26' }, // 날짜 — 받지 않는 칸
  ],
  body: [
    { part: 'issue', title: '', paras: ['서버 ⟦IP1⟧에서 디스크 이벤트가 10분가량 늦게 수신되고 있습니다.'], items: [] },
    { part: 'checked', title: '[확인 내용]', paras: ['수집 주기를 5초로 변경해 보았으나 동일했습니다.'], items: [] },
    {
      part: 'ask',
      title: '■ 확인 요청 사항',
      paras: [],
      items: [
        { text: '1. 지연 수신이 정상 동작인지 확인 부탁드립니다.', subs: [] },
        { text: '지연을 줄일 수 있는 설정이 있는지 확인 부탁드립니다.', subs: ['- 수집 주기 외 설정'] },
      ],
    },
    { part: 'note', title: '', paras: ['※ 가이드 ⟦URL1⟧ 를 참고했습니다.'], items: [] },
  ],
  questions: ['이벤트 설정 화면 캡처가 있으면 좋습니다.'],
};
const BODY_TEXT = [
  '서버 192.0.2.5에서 디스크 이벤트가 10분가량 늦게 수신되고 있습니다.',
  '',
  '[확인 내용]',
  '수집 주기를 5초로 변경해 보았으나 동일했습니다.',
  '',
  '■ 확인 요청 사항',
  '',
  '1. 지연 수신이 정상 동작인지 확인 부탁드립니다.',
  '',
  '2. 지연을 줄일 수 있는 설정이 있는지 확인 부탁드립니다.',
  ' - 수집 주기 외 설정',
  '',
  '※ 가이드 https://docs.example.com/event 를 참고했습니다.',
].join('\n');

describe('기술 문의 — 받은 결과는 서술에 있는 것만 넣는다', () => {
  it('글 칸은 한 줄로, 본문은 팀이 보내는 모양([이름]·■·번호·※)으로 — 기호는 앱이 붙인다', () => {
    const r = renderCompose(planCre(), ok(GOOD));
    expect(r.fields).toEqual([
      { key: 'topic', label: '메일 제목', before: '', value: '[예시IT] 디스크 사용률 이벤트 지연 수신 문의 (AB Z+)', multiline: false },
      { key: 'intro', label: '도입 문장', before: '', value: '제트플러스 지원 중 이벤트 수신 지연 관련 문의가 있어 메일 드립니다.', multiline: false },
      { key: 'issue', label: '이슈', before: '', value: '디스크 이벤트가 10분가량 늦게 수신됨', multiline: false },
    ]);
    expect(r.body).toBe(BODY_TEXT); // 모델이 기호를 붙여 와도 두 번 붙지 않고, 가린 값은 되살아난다
    expect(r.gaps).toEqual([]);
    expect(r.questions).toEqual(['이벤트 설정 화면 캡처가 있으면 좋습니다.']);
    expect(r.masked).toEqual({ P: 2, IP: 1, URL: 1 });
    expect(r.usd).toBeCloseTo((3000 * 4 + 1500 * 20) / 1e6, 6);
  });

  it('표의 칸은 서술에 글자 그대로 있는 값만 — 고객사는 표준 표기로, 없는 값·보기 밖 값·날짜는 넣지 않는다', () => {
    const r = renderCompose(planCre(), ok(GOOD));
    expect(r.fills).toEqual([
      { key: 'customer', label: '고객사명', value: 'AB Z+' },
      { key: 'project', label: '프로젝트명', value: '한강SRE' },
      { key: 'serverOs', label: '수집서버 OS 및 버전', value: 'rhel 8.10' },
      { key: 'serverVersion', label: '수집서버 버전', value: 'collector-x.y.z' },
      { key: 'agentVersion', label: '에이전트 버전', value: '2.9.5' },
    ]);
    expect(r.warnings).toEqual([
      '수집서버 스펙: "8core 16GB"은(는) 서술에 그대로 없는 값이라 넣지 않았습니다.',
      '계약 유형: "계약"은(는) 서술에 그대로 없는 값이라 넣지 않았습니다.',
    ]);
  });

  it('이미 채워 둔 표의 칸은 건드리지 않고, 이미 적어 둔 글 칸은 지금 값과 함께 보여 준다', () => {
    const doc = { ...FRESH, fieldValues: { ...FRESH.fieldValues, customer: '가나스토어', issue: '이벤트 늦음' } };
    const r = renderCompose(planCre(TEXT, doc), ok(GOOD));
    expect(r.fills.map((x) => x.key)).not.toContain('customer');
    expect(r.fields.find((x) => x.key === 'issue')).toMatchObject({ before: '이벤트 늦음', value: '디스크 이벤트가 10분가량 늦게 수신됨' });
  });

  it('확인·검토한 내용이 서술에 없으면 그 단락을 만들지 않고 확인할 점으로 알린다', () => {
    const noChecked = { ...GOOD, body: GOOD.body.filter((s) => s.part !== 'checked') };
    const r = renderCompose(planCre(), ok(noChecked));
    expect(r.body).not.toContain('[확인 내용]');
    expect(r.gaps).toEqual(['확인·검토하거나 시도한 내용이 서술에 없어 그 단락은 만들지 않았습니다 — 있으면 서술에 덧붙여 다시 만들거나 직접 적으세요.']);
    // 빈 단락만 돌아와도 없는 것으로 본다
    const empty = { ...GOOD, body: GOOD.body.map((s) => (s.part === 'ask' ? { ...s, items: [], paras: [' '] } : s)) };
    expect(renderCompose(planCre(), ok(empty)).gaps).toEqual(['제조사지원에 묻거나 요청할 내용이 서술에 드러나지 않아 그 단락은 만들지 않았습니다.']);
  });

  it('서술에 없는 숫자·모르는 자리표시·인사말은 경고한다 — 자리표시가 남은 글은 넣을 수 없다', () => {
    const bad = {
      fields: [{ key: 'issue', value: '동일 이벤트 47회 지연' }],
      body: [
        { part: 'issue', title: '', paras: ['안녕하세요. 서버 ⟦IP9⟧에서 이벤트가 늦게 옵니다.'], items: [] },
        { part: 'ask', title: '', paras: ['확인 부탁드립니다.'], items: [] },
      ],
      questions: [],
    };
    const r = renderCompose(planCre(), ok(bad));
    expect(r.warnings).toEqual([
      '이슈: 서술에 없는 숫자·버전 47 — 확인하세요.',
      '요청내용: 알 수 없는 자리표시 ⟦IP9⟧ — 지우거나 고치세요.',
      '요청내용: 인사말·맺음말은 앱이 붙입니다 — 들어 있으면 지우세요.',
    ]);
    expect(hasPlaceholder(r.body)).toBe(true);
    expect(applyCompose(제조사지원, FRESH, { fields: {}, body: r.body }).bodyHtml).toBe('');
    // 질문이 하나뿐이면 번호 없이 한 문단, 제목이 비면 기본 이름
    expect(r.body).toContain('■ 확인 요청 사항\n\n확인 부탁드립니다.');
  });

  it('확인한 것을 늘어놓은 목록은 이름 아래 붙여 쓰고, 묻는 항목은 한 줄씩 띄운다 (실측 2026-11-25)', () => {
    const listed = {
      fields: [],
      body: [
        { part: 'issue', title: '', paras: ['이벤트가 늦게 수신됩니다.'], items: [] },
        { part: 'checked', title: '', paras: [], items: [{ text: '수집 주기를 5초로 변경해도 동일', subs: [] }, { text: '다른 프로젝트는 바로 수신', subs: [] }] },
        { part: 'ask', title: '요청 사항', paras: [], items: [{ text: '정상 동작인지 확인 부탁드립니다.', subs: [] }, { text: '설정이 있는지 확인 부탁드립니다.', subs: [] }] },
      ],
      questions: [],
    };
    expect(renderCompose(planCre(), ok(listed)).body).toBe(
      '이벤트가 늦게 수신됩니다.\n\n[확인 내용]\n1. 수집 주기를 5초로 변경해도 동일\n2. 다른 프로젝트는 바로 수신\n\n■ 요청 사항\n\n1. 정상 동작인지 확인 부탁드립니다.\n\n2. 설정이 있는지 확인 부탁드립니다.',
    );
  });

  it('응답 모양이 다르면 던진다', () => {
    expect(() => renderCompose(planCre(), ok({ fields: [] }))).toThrow('응답 형식');
  });
});

describe('본문 초안 → 본문, 서식에 넣기', () => {
  it('빈 줄이 문단을 나누고, [이름]과 ■ 줄은 굵게, 세부 줄은 한 칸 들여, 글자는 그대로', () => {
    expect(bodyTextToHtml(BODY_TEXT)).toBe(
      '<p>서버 192.0.2.5에서 디스크 이벤트가 10분가량 늦게 수신되고 있습니다.</p>' +
        '<p><strong>[확인 내용]</strong><br>수집 주기를 5초로 변경해 보았으나 동일했습니다.</p>' +
        '<p><strong>■ 확인 요청 사항</strong></p>' +
        '<p>1. 지연 수신이 정상 동작인지 확인 부탁드립니다.</p>' +
        '<p>2. 지연을 줄일 수 있는 설정이 있는지 확인 부탁드립니다.<br>&nbsp;- 수집 주기 외 설정</p>' +
        '<p>※ 가이드 https://docs.example.com/event 를 참고했습니다.</p>',
    );
    expect(bodyTextToHtml('a < b & c\r\n\r\n\r\n<script>x</script>')).toBe('<p>a &lt; b &amp; c</p><p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(bodyTextToHtml(' \n ')).toBe('');
  });

  it('고른 칸만 넣는다 — 날짜·서식에 없는 칸은 건드리지 않고, 직접 고쳐 둔 제목은 자동으로 돌린다', () => {
    const doc: EmailDocState = { ...FRESH, subject: '직접 쓴 제목' };
    const next = applyCompose(제조사지원, doc, { fields: { topic: ' [예시IT] 지연 수신 문의 (AB Z+) ', customer: 'AB Z+', requestDate: '2026-12-01', nope: 'x', intro: '  ' } });
    expect(next.fieldValues).toMatchObject({ topic: '[예시IT] 지연 수신 문의 (AB Z+)', customer: 'AB Z+', requestDate: '2026-11-25' });
    expect(next.fieldValues).not.toHaveProperty('nope');
    expect(next.fieldValues).not.toHaveProperty('intro');
    expect(next.subject).toBeUndefined();
    expect(next.bodyHtml).toBe('');
    // 제목에 들어가지 않는 칸만 넣으면 직접 고친 제목은 그대로
    expect(applyCompose(제조사지원, doc, { fields: { issue: '지연' } }).subject).toBe('직접 쓴 제목');
    expect(doc.fieldValues).not.toHaveProperty('topic'); // 원래 문서는 그대로
  });

  it('본문에 이미 내용(캡처)이 있으면 그 위에 넣거나 바꾼다', () => {
    const shot = '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="캡처"></p>';
    const doc: EmailDocState = { ...FRESH, bodyHtml: shot };
    expect(applyCompose(제조사지원, doc, { fields: {}, body: '현상 설명' }).bodyHtml).toBe(`<p>현상 설명</p>${shot}`);
    expect(applyCompose(제조사지원, doc, { fields: {}, body: '현상 설명', bodyMode: 'replace' }).bodyHtml).toBe('<p>현상 설명</p>');
    // 빈 문단만 있던 본문은 내용이 없는 것으로 본다
    expect(applyCompose(제조사지원, { ...FRESH, bodyHtml: '<p><br></p>' }, { fields: {}, body: '현상 설명' }).bodyHtml).toBe('<p>현상 설명</p>');
    // 본문을 고르지 않으면 그대로
    expect(applyCompose(제조사지원, doc, { fields: { issue: '지연' } }).bodyHtml).toBe(shot);
  });
});

// ── 다른 서식 ────────────────────────────────────────────────────────────────
describe('라이선스 키 전달 — 키는 어디에도 실려 나가지 않는다', () => {
  const template = getTemplate('license-delivery', PROFILE)!;
  const KEY = 'test0000key01-test0000key002-test0000key003';
  const doc: EmailDocState = {
    templateId: 'license-delivery',
    fieldValues: { licenseType: 'POC용', startDate: '2026-11-01', endDate: '2026-12-31', licenseKey: KEY },
    bodyHtml: '',
  };
  const text = `가나통신 관제개발팀(PoC) POC용 라이선스 발급돼서 전달. 수집서버는 192.0.2.40. 키는 ${KEY}`;
  const plan = planCompose({ template, doc, text, myName: PROFILE.name, company: PROFILE.company }, 'claude-opus-5-5')!;

  it('요청(지침·입력) 어디에도 라이선스 키·날짜·IP 원문이 없다 — 서술에 붙여 넣은 키도 가린다', () => {
    const sent = `${plan.request.system}\n${plan.request.user}`;
    expect(sent).not.toContain(KEY);
    expect(sent).not.toContain('test0000key01');
    expect(sent).not.toContain('2026-12-31');
    expect(sent).not.toContain('192.0.2.40');
    expect(plan.request.user).toContain('수집서버는 ⟦IP1⟧. 키는 ⟦KEY1⟧');
    expect((payloadOf(plan.request.user).fields as Array<{ key: string }>).map((x) => x.key)).toEqual(['topic', 'intro', 'licenseType', 'customer', 'project', 'serverIp']);
    expect(plan.fields.find((x) => x.field.key === 'licenseKey')).toMatchObject({ role: 'locked', current: '', value: '' });
    expect(plan.request.system).toContain('라이선스 키를 고객');
    expect(plan.request.system).toContain('표 — 유형 · 최종고객 · 프로젝트명 · 시작일 · 종료일 · 수집서버 IP · 라이선스.');
    expect(plan.request.system).not.toContain('제조사지원');
  });

  it('모델이 라이선스·날짜 칸을 돌려줘도 무시하고, 본문 없는 서식에는 본문을 넣지 않는다', () => {
    const r = renderCompose(
      plan,
      ok({
        fields: [
          { key: 'topic', value: '수집서버 라이선스 전달드립니다.' },
          { key: 'intro', value: '제조사 수집서버 라이선스 키가 발급되어 전달드립니다.' },
          { key: 'customer', value: '가나통신' },
          { key: 'project', value: '관제개발팀(PoC)' },
          { key: 'serverIp', value: '⟦IP1⟧' },
          { key: 'licenseType', value: '정식' }, // 이미 값이 있는 칸
          { key: 'licenseKey', value: '⟦KEY1⟧' },
          { key: 'endDate', value: '2027-01-01' },
        ],
        body: [{ part: 'text', title: '', paras: ['라이선스 전달드립니다.'], items: [] }],
        questions: [],
      }),
    );
    expect(r.fields.map((x) => x.key)).toEqual(['topic', 'intro']);
    expect(r.fills).toEqual([
      { key: 'customer', label: '최종고객', value: '가나통신' },
      { key: 'project', label: '프로젝트명', value: '관제개발팀(PoC)' },
      { key: 'serverIp', label: '수집서버 IP', value: '192.0.2.40' },
    ]);
    expect(r.body).toBe('');
    expect(r.gaps).toEqual([]);
    const next = applyCompose(template, doc, { fields: { ...Object.fromEntries(r.fills.map((x) => [x.key, x.value])), licenseKey: 'zzz', endDate: '2027-01-01' }, body: '본문' });
    expect(next.fieldValues).toMatchObject({ licenseKey: KEY, endDate: '2026-12-31', serverIp: '192.0.2.40' });
    expect(next.bodyHtml).toBe('');
  });
});

describe('설치파일 전달 — 본문은 "전달 문장 + - 라벨 : 링크" 줄 모양', () => {
  const template = getTemplate('install-delivery', PROFILE)!;
  const doc: EmailDocState = { templateId: 'install-delivery', fieldValues: {}, bodyHtml: '' };
  const text = '수집서버 3.1.1 설치파일 보냄 https://files.example.com/vendor/server-3.1.1.tar.gz\n에이전트(Linux v2.9.5)는 https://files.example.com/agent/linux';
  const plan = planCompose({ template, doc, text }, 'claude-opus-5-5')!;

  it('지침 — 표 없이 본문이 전부, 표준 문구의 모양, 링크는 가려서', () => {
    const s = plan.request.system;
    expect(s).toContain('본문(body) — 표 없이 도입 문장 아래에 바로 온다. 메일 내용의 전부다.');
    expect(s).not.toMatch(/\d\. 표/);
    expect(s).toContain('이 서식의 본문 표준 문구');
    expect(s).toContain('    제조사 수집서버 설치파일 전달 드립니다.\n    - 다운링크 : ');
    expect(s).not.toContain('제조사지원');
    expect(plan.request.user).not.toContain('files.example.com');
    expect(plan.request.user).toContain('⟦URL1⟧');
  });

  it('줄 모양 그대로 본문이 되고 링크가 되살아난다', () => {
    const r = renderCompose(
      plan,
      ok({
        fields: [{ key: 'topic', value: '제조사 수집서버 설치파일 전달' }],
        body: [
          { part: 'text', title: '', paras: ['제조사 수집서버 설치파일 전달 드립니다.\n- 다운링크 : ⟦URL1⟧'], items: [] },
          { part: 'text', title: '', paras: ['제조사 서버모니터링 에이전트 전달 드립니다.\n- (Linux v2.9.5) : ⟦URL2⟧'], items: [] },
        ],
        questions: [],
      }),
    );
    expect(r.warnings).toEqual([]);
    expect(r.body).toBe(
      '제조사 수집서버 설치파일 전달 드립니다.\n- 다운링크 : https://files.example.com/vendor/server-3.1.1.tar.gz\n\n제조사 서버모니터링 에이전트 전달 드립니다.\n- (Linux v2.9.5) : https://files.example.com/agent/linux',
    );
    expect(applyCompose(template, doc, { fields: {}, body: r.body }).bodyHtml).toBe(
      '<p>제조사 수집서버 설치파일 전달 드립니다.<br>- 다운링크 : https://files.example.com/vendor/server-3.1.1.tar.gz</p>' +
        '<p>제조사 서버모니터링 에이전트 전달 드립니다.<br>- (Linux v2.9.5) : https://files.example.com/agent/linux</p>',
    );
  });
});

describe('팀·개인 템플릿과 이름', () => {
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

  it('제목 패턴·목록형·ai 표시를 템플릿에서 읽어 안내한다', () => {
    const doc: EmailDocState = { templateId: 'team-check', fieldValues: { apiKey: 'abcd-efgh' }, bodyHtml: '', subject: '직접 쓴 제목' };
    const plan = planCompose({ template: custom, doc, text: '가나통신 10월 정기점검 했고 이상 없었음' }, 'claude-opus-5-5')!;
    const s = plan.request.system;
    expect(s).toContain('상황: "정기점검 결과 안내" 서식의 업무 메일이다. (정기점검 결과를 고객 담당자에게 안내)');
    expect(s).toContain('글머리 목록 — 고객사 · API 키 · 비고.');
    expect(s).toContain('메일 제목: "[예시IT] {topic} 안내 ({customer})" 모양으로 조립된다.');
    expect(s).not.toContain('홍길동');
    expect((payloadOf(plan.request.user).fields as Array<Record<string, string>>).map((x) => [x.key, x.role])).toEqual([
      ['topic', 'prose'],
      ['customer', 'fill'],
      ['memo', 'fill'],
    ]);
    expect(plan.request.user).not.toContain('abcd-efgh');
    // 제목 패턴에 들어가는 칸(고객사)을 넣으면 직접 고친 제목은 자동으로 돌아간다
    expect(applyCompose(custom, doc, { fields: { customer: '가나통신' } }).subject).toBeUndefined();
    expect(applyCompose(custom, doc, { fields: { memo: '이상 없음' } }).subject).toBe('직접 쓴 제목');
  });

  it('버튼 이름 — 기술 문의는 "서술 → 문의", 그 밖의 서식은 "서술 → 메일"', () => {
    expect(composeNames(제조사지원)).toMatchObject({ label: '서술 → 문의', make: '문의 글 만들기' });
    expect(composeNames(getTemplate('license-delivery', PROFILE))).toMatchObject({ label: '서술 → 메일', make: '메일 글 만들기' });
    expect(composeNames(custom).label).toBe('서술 → 메일');
    expect(composeNames(undefined).label).toBe('서술 → 문의');
  });
});

// ── 창 ──────────────────────────────────────────────────────────────────────
describe('서술 → 문의 창 — 대화 → 블록과 같은 흐름', () => {
  function open(doc: EmailDocState = FRESH) {
    const calls: AiCompleteRequest[] = [];
    let finish: (r: AiCompleteResult) => void = () => {};
    (window as unknown as { reportApi: unknown }).reportApi = {
      aiComplete: vi.fn((req: AiCompleteRequest) => {
        calls.push(req);
        return new Promise<AiCompleteResult>((resolve) => {
          finish = resolve;
        });
      }),
      aiCancel: vi.fn(async () => ({ ok: true })),
      onAiProgress: vi.fn(() => () => {}),
    };
    const onInsert = vi.fn();
    const onTextChange = vi.fn();
    render(<ComposeFromTextDialog template={제조사지원} doc={doc} myName={PROFILE.name} company={PROFILE.company} initialText="" onTextChange={onTextChange} onInsert={onInsert} onClose={() => {}} />);
    return { calls, finish: (r: AiCompleteResult) => finish(r), onInsert, onTextChange };
  }
  const write = (text: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  const make = () => screen.getByRole('button', { name: /문의 글 만들기/ }) as HTMLButtonElement;

  it('서술을 적어 만들고, 결과를 고친 뒤 고른 것만 서식에 넣는다', async () => {
    const t = open();
    expect(screen.getByText(/서술 → 문의 — /)).toBeTruthy();
    expect(screen.getByText(/이 서식의 칸\(메일 제목 · 도입 문장 · 이슈 · 요청내용 · 표의 빈 칸\)/)).toBeTruthy();
    expect(screen.getByText(/읽지도 보내지도 않는 칸: 요청일자/)).toBeTruthy();
    expect(make().disabled).toBe(true); // 서술이 비어 있다
    write(TEXT);
    expect(t.onTextChange).toHaveBeenLastCalledWith(TEXT);
    await act(async () => make().click());
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].user).not.toMatch(/윤서준|192\.0\.2\.5/);
    await act(async () => t.finish(ok(GOOD)));

    expect(screen.getByText('확인할 점')).toBeTruthy();
    expect(screen.getByText(/"8core 16GB"은\(는\) 서술에 그대로 없는 값이라/)).toBeTruthy();
    expect(screen.getByText(/보내기 전 가림: 사람 이름 2, URL 1, IP 1/)).toBeTruthy();
    const title = screen.getByDisplayValue('[예시IT] 디스크 사용률 이벤트 지연 수신 문의 (AB Z+)');
    fireEvent.change(title, { target: { value: '[예시IT] 디스크 이벤트 지연 수신 문의 (AB Z+)' } });
    fireEvent.click(screen.getByLabelText('도입 문장 넣기')); // 하나 해제
    fireEvent.click(screen.getByLabelText(/에이전트 버전/)); // 표의 칸 하나 해제
    // 제목·이슈·본문 + 표의 칸 4곳
    await act(async () => screen.getByRole('button', { name: '서식에 넣기 (7곳)' }).click());
    const [next, count] = t.onInsert.mock.calls[0] as [EmailDocState, number];
    expect(count).toBe(7);
    expect(next.fieldValues).toMatchObject({
      topic: '[예시IT] 디스크 이벤트 지연 수신 문의 (AB Z+)',
      issue: '디스크 이벤트가 10분가량 늦게 수신됨',
      customer: 'AB Z+',
      project: '한강SRE',
      serverVersion: 'collector-x.y.z',
      requestDate: '2026-11-25',
    });
    expect(next.fieldValues).not.toHaveProperty('intro');
    expect(next.fieldValues).not.toHaveProperty('agentVersion');
    expect(next.bodyHtml).toContain('<strong>■ 확인 요청 사항</strong>');
    expect(next.bodyHtml).toContain('192.0.2.5');
  });

  it('본문에 이미 내용이 있으면 위에 넣을지 바꿀지 고르고, 자리표시가 남으면 넣을 수 없다', async () => {
    const shot = '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="캡처"></p>';
    const t = open({ ...FRESH, bodyHtml: shot });
    write(TEXT);
    await act(async () => make().click());
    await act(async () => t.finish(ok({ fields: [], body: [{ part: 'issue', title: '', paras: ['서버 ⟦IP9⟧에서 늦게 옵니다.'], items: [] }], questions: [] })));
    const above = screen.getByRole('button', { name: '지금 본문 위에 넣기' }) as HTMLButtonElement;
    expect(above.disabled).toBe(true);
    expect(screen.getByText(/되살리지 못한 자리표시/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('서버 ⟦IP9⟧에서 늦게 옵니다.'), { target: { value: '서버에서 늦게 옵니다.' } });
    expect(above.disabled).toBe(false);
    await act(async () => above.click());
    expect((t.onInsert.mock.calls[0][0] as EmailDocState).bodyHtml).toBe(`<p>서버에서 늦게 옵니다.</p>${shot}`);
    await act(async () => screen.getByRole('button', { name: '본문을 바꿔 넣기' }).click());
    expect((t.onInsert.mock.calls[1][0] as EmailDocState).bodyHtml).toBe('<p>서버에서 늦게 옵니다.</p>');
  });

  it('넣을 것이 없거나 호출이 실패하면 서술 화면에 남아 이유를 보여 준다, [서술 고치기]로 돌아간다', async () => {
    const t = open();
    write('음');
    await act(async () => make().click());
    await act(async () => t.finish(ok({ fields: [], body: [], questions: [] })));
    expect(screen.getByText(/서식에 넣을 내용을 찾지 못했습니다/)).toBeTruthy();
    await act(async () => make().click());
    await act(async () => t.finish({ ok: false, code: 'auth', message: 'API 키가 올바르지 않습니다.' }));
    expect(screen.getByText('API 키가 올바르지 않습니다.')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('음');
    await act(async () => make().click());
    await act(async () => t.finish(ok(GOOD)));
    await act(async () => screen.getByRole('button', { name: '서술 고치기' }).click());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('음');
  });
});
