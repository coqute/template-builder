/**
 * 할 일 메모 → 오늘 일지 블록 (v0.29.0) — 메모를 이전 일지 블록·고른 메일과 대조해 후속 블록으로.
 * 보내는 내용(가림·걸러진 메일만)과 받은 결과를 다루는 규칙, 창의 흐름(제목만 조회 → 고른 스레드만 읽기 → 고쳐서 넣기)을 고정한다.
 * Claude API와 Gmail은 가짜 통로로 대신한다. 값은 모두 합성이다.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiCompleteRequest, AiCompleteResult } from '../electron/ai-types';
import type { WorklogFileText } from '../electron/worklog-types';
import { planTaskLog, renderTaskLog, SANITIZED_MARK_RE, taskLogSystem, type TaskLogInput, type TaskLogMail } from '../src/ai/taskLog';
import { BLOCK_SYSTEM, blockStyle } from '../src/ai/worklogAi';
import type { PlannerApi } from '../src/planner/api';
import { TaskLogDialog } from '../src/planner/components/TaskLogDialog';
import { confidentPick, hintWords, rankThreads, scoreThread, splitLikely, type MailHint } from '../src/planner/mailRank';
import type { MailMessage, MailThreadInfo, Task } from '../src/planner/types';

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

const ok = (json: unknown): Extract<AiCompleteResult, { ok: true }> => ({ ok: true, json, model: 'claude-opus-5-5', usage: { input: 2000, output: 600, cacheRead: 0 }, fallbackUsed: false, ms: 7000 });

const TODAY = '2026-11-27';
const HEAD = '■ (홍길동/메일) 수집 누락 원인 문의 (11/20 문의 후속)';
const CASE = '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 에이전트 로그 회수 후 기술 문의\n- 대상: 수집 서버 2대\n- 원인 확인 중 — 제조사지원 회신 대기';
// 거르는 도구를 거친 모양 — 주소의 앞부분과 IP는 이미 표식이다
const MESSAGES: MailMessage[] = [
  { from: '홍길동 책임 <[사용자]@abz.example>', to: '박민수 <[사용자]@support.example>', date: '2026-11-20', mine: false, body: '수집 서버 [IP주소] 에서 지표가 비어 있습니다. 최하늘 대리님도 같은 증상입니다.' },
  { from: '제조사 지원 <[사용자]@vendor.example>', to: '박민수 <[사용자]@support.example>', date: '2026-11-25', mine: false, body: '에이전트 2.9.4의 알려진 문제입니다. 2.9.5로 올리고 collect_retry=3 을 넣어 주세요. 안내서 https://docs.example.com/patch' },
  { from: '박민수 <[사용자]@support.example>', to: '홍길동 책임 <[사용자]@abz.example>', date: '2026-11-26', mine: true, body: '원인은 에이전트 2.9.4의 수집 스레드 멈춤입니다. 2.9.5 패치 파일을 전달드립니다.' },
];
const MAIL: TaskLogMail = { subject: '[AB Z+] 수집 누락 원인 문의', messages: MESSAGES, sanitized: true };
const INPUT: TaskLogInput = {
  today: TODAY,
  title: '수집 누락 원인 안내',
  done: true,
  head: HEAD,
  memo: '제조사지원 회신 받아서 홍길동 책임님께 원인 안내, 패치 전달함',
  cases: [{ date: '2026-11-20', text: CASE }],
  mail: MAIL,
  myName: '박민수',
  knownNames: ['홍길동'],
};

describe('보내는 내용', () => {
  const plan = planTaskLog(INPUT, 'claude-opus-5-5')!;

  it('이름(요청자·내 이름·메일의 사람·직함 붙은 이름)과 URL을 가리고, 걸러진 표식은 그대로 둔다', () => {
    const u = plan.request.user;
    expect(u).not.toMatch(/홍길동|박민수|최하늘|docs\.example\.com/);
    expect(u).toContain('[IP주소]');
    expect(u).toContain('⟦URL1⟧');
    // 팀·그룹 이름은 사람이 아니다 — 누가 보낸 메일인지 알 수 있게 남긴다
    expect(u).toContain('[상대 — 제조사 지원 → ⟦P');
    expect(u).toMatch(/\[나 → ⟦P\d⟧ 책임\] 2026-11-26/);
    expect(plan.masker.summary()).toMatchObject({ P: 3, URL: 1 });
  });

  it('메모·이전 기록·메일을 갈라 보내고, 머리줄과 끝냄 여부를 알려 준다', () => {
    const u = plan.request.user;
    expect(u).toContain(`오늘: ${TODAY}`);
    expect(u).toContain('상태: 끝냄');
    // 메모의 첫 낱말은 적지 않는다 — 공개본에서 다른 낱말로 바뀌는 용어라, 정규식의 `\n` 바로 뒤에 두면 여기만 안 바뀐다
    expect(u).toMatch(/<메모>\n[^\n]+ 회신 받아서 ⟦P\d⟧ 책임님께 원인 안내, 패치 전달함\n<\/메모>/);
    expect(u).toContain('<이전 기록>\n[2026-11-20 일지]\n■ (⟦P');
    expect(u).toContain('<메일 제목="[AB Z+] 수집 누락 원인 문의">');
    expect(u.indexOf('2026-11-20\n수집 서버')).toBeLessThan(u.indexOf('2026-11-26\n원인은'));
    expect(planTaskLog({ ...INPUT, done: false }, 'claude-opus-5-5')!.request.user).toContain('상태: 진행 중');
  });

  it('걸러졌다는 표시가 없는 메일은 보내지 않는다, 메모도 메일도 없으면 보낼 것이 없다', () => {
    const raw = { subject: '원본', messages: [{ ...MESSAGES[0], body: '서버 192.0.2.11 입니다' }] } as unknown as TaskLogMail;
    const p = planTaskLog({ ...INPUT, mail: raw }, 'claude-opus-5-5')!;
    expect(p.request.user).not.toContain('<메일');
    expect(p.request.user).not.toContain('192.0.2.11');
    expect(planTaskLog({ ...INPUT, memo: '  ', mail: null }, 'claude-opus-5-5')).toBeNull();
    expect(planTaskLog({ ...INPUT, memo: '', mail: raw }, 'claude-opus-5-5')).toBeNull();
    // 메모만으로도 된다 (직접 만든 할 일)
    expect(planTaskLog({ ...INPUT, mail: null, cases: [] }, 'claude-opus-5-5')!.request.user).not.toContain('<이전 기록>');
  });

  it('지침 — 대화 → 블록과 같은 문체, 이전 기록은 되풀이하지 않고, 걸러진 표식은 일지에 쓰지 않는다', () => {
    const s = taskLogSystem('예시IT');
    expect(s).toContain(blockStyle('메모·메일'));
    expect(BLOCK_SYSTEM).toContain(blockStyle('대화')); // 같은 글을 나눠 쓴다
    expect(s).toContain('이전 기록에 이미 있는 일·사실은 되풀이하지 않는다');
    expect(s).toContain('대괄호 표식은 메일에서 이미 지워진 값이다. 일지에 옮겨 적지 않는다');
    expect(s).toContain('메모·메일·이전 기록에 없는 사실·원인·결과·수치를 만들지 않는다');
    expect(plan.request.system).toContain('예시IT');
  });

  it('메일이 길면 첫 메일과 최근 메일 위주로 보내고 그렇게 알린다', () => {
    const long = Array.from({ length: 8 }, (_x, i): MailMessage => ({ from: '제조사 지원 <[사용자]@vendor.example>', to: '', date: `2026-11-${10 + i}`, mine: false, body: `메일 ${i} ${'가'.repeat(5000)}` }));
    const p = planTaskLog({ ...INPUT, mail: { subject: '긴 스레드', messages: long, sanitized: true } }, 'claude-opus-5-5')!;
    expect(p.mailCut).toBe(true);
    expect(p.request.user).toContain('메일 0 ');
    expect(p.request.user).toContain('메일 7 ');
    expect(p.request.user).toContain('[사이의 메일 생략]');
    expect(p.request.user.length).toBeLessThan(32_000);
    const r = renderTaskLog(p, ok({ notes: [], acts: [{ text: '회신 확인', facts: [] }], deliverables: [], questions: [] }));
    expect(r.warnings.some((w) => w.includes('메일이 길어'))).toBe(true);
  });
});

describe('받은 결과 → 일지 블록', () => {
  const plan = planTaskLog(INPUT, 'claude-opus-5-5')!;
  const P = (name: string) => [...plan.request.user.matchAll(/⟦P\d⟧/g)].map((m) => m[0]).find((t) => plan.masker.original(t) === name)!;

  it('머리줄은 앱이 붙이고, 이름을 되살리고, 붙여 온 기호는 뗀다', () => {
    const r = renderTaskLog(
      plan,
      ok({
        notes: [],
        acts: [
          { text: '▶ 제조사지원 회신 내용 확인', facts: [{ text: '- 원인: 에이전트 2.9.4의 수집 스레드 멈춤', details: ['조치: 2.9.5 적용 + collect_retry=3'] }] },
          { text: `${P('홍길동')} 책임님에게 원인 및 조치 방법 안내`, facts: [{ text: '2.9.5 패치 파일 전달 — 안내 완료', details: [] }] },
        ],
        deliverables: [],
        questions: ['패치 적용 일정은 메모·메일에 없습니다.'],
      }),
    );
    expect(r.text).toBe(
      [
        HEAD,
        '',
        '▶ 제조사지원 회신 내용 확인',
        '- 원인: 에이전트 2.9.4의 수집 스레드 멈춤',
        '  > 조치: 2.9.5 적용 + collect_retry=3',
        '',
        '▶ 홍길동 책임님에게 원인 및 조치 방법 안내',
        '- 2.9.5 패치 파일 전달 — 안내 완료',
      ].join('\n'),
    );
    expect(r.warnings).toEqual([]);
    expect(r.questions).toEqual(['패치 적용 일정은 메모·메일에 없습니다.']);
    expect(r.acts).toBe(2);
    expect(r.masked).toMatchObject({ P: 3, URL: 1 });
  });

  it('끝낸 할 일인데 닫는 상태로 끝나지 않으면 한 줄을 붙인다 — 진행 중이면 붙이지 않는다', () => {
    const json = { notes: [], acts: [{ text: '원인 안내', facts: [{ text: '2.9.5 패치 파일 전달', details: [] }] }], deliverables: [], questions: [] };
    expect(renderTaskLog(plan, ok(json)).text.endsWith('- 2.9.5 패치 파일 전달\n- 처리 완료')).toBe(true);
    const open = planTaskLog({ ...INPUT, done: false }, 'claude-opus-5-5')!;
    expect(renderTaskLog(open, ok(json)).text.endsWith('- 2.9.5 패치 파일 전달')).toBe(true);
  });

  it('한 일을 찾지 못하면 — 끝낸 할 일은 전처럼 완료만 적고 알린다, 진행 중이면 넣을 것이 없다', () => {
    const empty = { notes: [], acts: [], deliverables: [], questions: [] };
    const r = renderTaskLog(plan, ok(empty));
    expect(r.text).toBe(`${HEAD}\n\n▶ 처리 완료`);
    expect(r.warnings).toEqual(['메모·메일에서 이번에 한 일을 찾지 못해 완료만 적었습니다 — 필요하면 직접 덧붙이세요.']);
    expect(renderTaskLog(planTaskLog({ ...INPUT, done: false }, 'claude-opus-5-5')!, ok(empty)).text).toBe('');
  });

  it('걸러진 값의 표식·없는 숫자·본문의 URL·모르는 자리표시·원문과 다른 전달물은 경고한다', () => {
    const r = renderTaskLog(
      plan,
      ok({
        notes: ['대상 서버 [IP주소]'],
        acts: [{ text: '패치 3.0.1 적용 안내', facts: [{ text: '안내서 ⟦URL1⟧ 전달, ⟦IP7⟧ 확인 — 안내 완료', details: [] }] }],
        deliverables: [
          { name: '설정', raw: 'collect_retry=3' },
          { name: '바뀐 설정', raw: 'collect_retry=5' },
        ],
        questions: [],
      }),
    );
    expect(r.warnings).toEqual([
      '메일에서 가려진 값의 표식([IP주소]·[사용자] 등)이 들어 있습니다 — 지우거나 실제 값을 직접 적으세요.',
      '▶: 메모·메일에 없는 숫자·버전 3.0.1 — 확인하세요.',
      '-: 알 수 없는 자리표시 ⟦IP7⟧',
      'URL이 본문 줄에 들어갔습니다 — 작업일지에는 URL을 쓰지 않습니다(전달물 원문만 예외). 지우거나 전달물로 옮기세요.',
      '전달물 "바뀐 설정"은 메모·메일의 원문과 달라 넣지 않았습니다 — 원문을 직접 붙여 넣으세요.',
    ]);
    expect(r.text).toContain('\n\n※ 설정\ncollect_retry=3');
    expect(r.text).not.toContain('collect_retry=5');
    expect(SANITIZED_MARK_RE.test('[사용자]@abz.example')).toBe(true);
    expect(SANITIZED_MARK_RE.test('[AB Z+] 문의')).toBe(false);
  });

  it('응답 모양이 다르면 던진다', () => {
    expect(() => renderTaskLog(plan, ok({ acts: [] }))).toThrow('응답 형식');
  });
});

// ── 창 ──────────────────────────────────────────────────────────────────────
const ANCHOR = { folder: 'AB Z+ 작업', name: '[2026-11-20] 수집 점검.txt', date: '2026-11-20', caseKey: '수집누락원인문의', nth: 0, line: 3, title: '수집 누락 원인 문의', source: '홍길동/메일' };
const TASK: Task = {
  id: 't1',
  title: '수집 누락 원인 안내',
  client: 'AB Z+',
  who: '홍길동',
  due: null,
  state: 'todo',
  waitingOn: '',
  waitingSince: null,
  note: '제조사지원 회신 받아 원인 안내함',
  origin: { kind: 'worklog', anchor: ANCHOR },
  event: null,
  createdAt: '2026-11-20T01:00:00.000Z',
  updatedAt: '2026-11-27T01:00:00.000Z',
  doneAt: '2026-11-27T01:00:00.000Z',
  by: 'app',
};
const THREADS: MailThreadInfo[] = [
  { threadId: 'aaaaaa01', subject: '[AB Z+] 수집 누락 원인 문의', from: '홍길동 책임', date: '2026-11-26', days: ['2026-11-20', '2026-11-25', '2026-11-26'], people: ['홍길동 책임', '박민수', '제조사 지원'], count: 3, mine: true },
  { threadId: 'aaaaaa02', subject: 'RE: 알림 분류 기준 변경 요청 건', from: '홍길동 책임', date: '2026-11-22', days: ['2026-11-18', '2026-11-22'], people: ['홍길동 책임', '박민수'], count: 2, mine: false },
];

function setup(o: { task?: Task; status?: { canRead: boolean; message?: string }; thread?: unknown } = {}) {
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
  const text = `[2026-11-20] 수집 점검\n\n${CASE}\n\n■ (담당C/유선) 다른 사안\n▶ 처리\n`;
  const file: WorklogFileText = { folder: ANCHOR.folder, name: ANCHOR.name, date: ANCHOR.date, title: '수집 점검', size: text.length, mtimeMs: 1, text };
  const api = {
    worklogReadAll: vi.fn(async () => ({ ok: true as const, files: [file] })),
    mailStatus: vi.fn(async () => o.status ?? { canRead: true }),
    mailSearch: vi.fn(async (_req: { who: string; words?: string; since: string; force?: boolean }) => ({ ok: true as const, threads: THREADS, query: 'q', more: false, readAt: 1, fromCache: false })),
    mailThread: vi.fn(async (id: string) => o.thread ?? { ok: true as const, threadId: id, subject: MAIL.subject, messages: MESSAGES, truncated: false, sanitized: true as const }),
  };
  const onAppend = vi.fn(async () => true);
  const onPlainDone = vi.fn();
  const onMemo = vi.fn();
  const onClose = vi.fn();
  const task = o.task ?? TASK;
  render(
    <TaskLogDialog task={task} today={TODAY} api={api as unknown as PlannerApi} myName="박민수" knownNames={['담당C']} onAppend={onAppend} onPlainDone={task.doneAt ? onPlainDone : undefined} onMemo={onMemo} onClose={onClose} />,
  );
  return { api, calls, finish: (r: AiCompleteResult) => finish(r), onAppend, onPlainDone, onMemo, onClose };
}
const make = () => screen.getByRole('button', { name: /블록 만들기/ }) as HTMLButtonElement;

describe('할 일 → 오늘 일지 창', () => {
  it('열면 요청자 이름으로 제목만 조회하고, 고른 스레드만 읽어 블록을 만든 뒤 고쳐서 넣는다', async () => {
    const t = setup();
    await waitFor(() => expect(screen.getByText('[AB Z+] 수집 누락 원인 문의')).toBeTruthy());
    // 사안이 일지에 적힌 날의 14일 전부터, 할 일의 요청자로
    expect(t.api.mailSearch).toHaveBeenCalledWith({ who: '홍길동', words: '', since: '2026-11-06', force: false });
    expect(t.api.mailThread).not.toHaveBeenCalled(); // 고르기 전에는 본문을 읽지 않는다
    expect(screen.getByText(/이 사안이 일지에 1번 적혀 있습니다/)).toBeTruthy();
    expect(screen.getByText('■ (홍길동/메일) 수집 누락 원인 문의 (11/20 문의 후속)')).toBeTruthy();
    expect(screen.getByText(/홍길동 책임 · 11\/26 · 3통 · 내 회신 있음/)).toBeTruthy();
    // 찾은 둘 가운데 이 사안과 가까운 하나만 먼저 보이고(제목·사안이 적힌 날·고객사), 뚜렷이 앞서므로 골라 둔다
    expect(screen.getByTestId('mail-narrow').textContent).toBe('찾은 2건 가운데 이 사안과 가까운 1건을 먼저 보입니다. 가장 가까운 메일을 골라 두었습니다 — 다르면 바꾸세요.');
    expect(screen.getByText('제목이 겹침: 수집 · 누락 · 사안이 일지에 적힌 날(11/20)의 메일 · 제목에 고객사 · 요청자가 보낸 메일')).toBeTruthy();
    expect(screen.queryByText('RE: 알림 분류 기준 변경 요청 건')).toBeNull();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
    // 나머지는 접혀 있다 — 펼쳐 보고 다시 접는다
    fireEvent.click(screen.getByRole('button', { name: '그 밖의 메일 1건 보기' }));
    expect(screen.getByText('RE: 알림 분류 기준 변경 요청 건')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '가까운 메일만 보기' }));

    await act(async () => make().click());
    expect(t.api.mailThread).toHaveBeenCalledTimes(1);
    expect(t.api.mailThread).toHaveBeenCalledWith('aaaaaa01');
    await waitFor(() => expect(t.calls).toHaveLength(1));
    const sent = t.calls[0].user;
    expect(sent).not.toMatch(/홍길동|박민수|최하늘/);
    expect(sent).toContain('<이전 기록>');
    expect(sent).not.toContain('다른 사안'); // 같은 사안의 블록만
    expect(sent).toContain('<메일 제목=');

    await act(async () => t.finish(ok({ notes: [], acts: [{ text: '제조사지원 회신 내용 확인 후 원인 안내', facts: [{ text: '2.9.5 패치 파일 전달 — 안내 완료', details: [] }] }], deliverables: [], questions: ['적용 일정 확인'] })));
    expect(screen.getByText(/▶ 1줄/)).toBeTruthy();
    expect(screen.getByText('· 적용 일정 확인')).toBeTruthy();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe(`${HEAD}\n\n▶ 제조사지원 회신 내용 확인 후 원인 안내\n- 2.9.5 패치 파일 전달 — 안내 완료`);
    fireEvent.change(box, { target: { value: `${box.value}\n- 적용은 다음 주` } });
    await act(async () => screen.getByRole('button', { name: '오늘 일지 끝에 넣기' }).click());
    expect(t.onAppend).toHaveBeenCalledWith(`${HEAD}\n\n▶ 제조사지원 회신 내용 확인 후 원인 안내\n- 2.9.5 패치 파일 전달 — 안내 완료\n- 적용은 다음 주`);
    expect(t.onClose).toHaveBeenCalled();
  });

  it('메일 없이 메모만으로도 만들고, 고친 메모는 할 일에 남긴다', async () => {
    const t = setup();
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    // 앱이 골라 둔 것을 사용자가 "메일 없이"로 바꾸면 그대로 둔다(다시 골라 주지 않는다)
    fireEvent.click(screen.getAllByRole('radio')[0]);
    const memo = screen.getByPlaceholderText(/제조사지원 회신 받아/) as HTMLTextAreaElement;
    fireEvent.change(memo, { target: { value: '원인 안내하고 패치 전달함' } });
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('mail-narrow').textContent).not.toContain('골라 두었습니다');
    await act(async () => make().click());
    expect(t.onMemo).toHaveBeenCalledWith('원인 안내하고 패치 전달함');
    expect(t.api.mailThread).not.toHaveBeenCalled();
    expect(t.calls[0].user).not.toContain('<메일');
    expect(t.calls[0].user).toContain('<메모>\n원인 안내하고 패치 전달함');
  });

  it('메일을 읽을 수 없으면 찾지 않고 그 까닭을 보인다 — 거르는 도구가 없을 때도', async () => {
    const t = setup({ status: { canRead: false, message: '메일을 거르는 도구(sanitizer)를 찾지 못했습니다 — 걸러지지 않은 메일은 읽지 않습니다.' } });
    await waitFor(() => expect(screen.getByText(/메일은 쓰지 않고 메모와 이전 기록만으로 만듭니다 — 메일을 거르는 도구/)).toBeTruthy());
    expect(t.api.mailSearch).not.toHaveBeenCalled();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('고른 메일을 읽지 못하면 보내지 않고 알린다, 끝낸 할 일은 [완료만 기록]으로 전처럼 적을 수 있다', async () => {
    const t = setup({ thread: { ok: false, code: 'sanitizer-failed', message: '메일을 거르지 못해 본문을 읽지 않았습니다 — 도구 오류' } });
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    await act(async () => make().click());
    expect(screen.getByText(/메일을 읽지 못했습니다: 메일을 거르지 못해 본문을 읽지 않았습니다/)).toBeTruthy();
    expect(t.calls).toHaveLength(0);
    await act(async () => screen.getByRole('button', { name: '완료만 기록' }).click());
    expect(t.onPlainDone).toHaveBeenCalled();
  });

  it('개발 모드(효과를 걷었다 다시 거는 StrictMode)에서도 조회 결과를 받는다', async () => {
    // 웹 미리보기에서 "메일을 읽을 수 있는지 확인하는 중…"에 멈춰 있던 것 — 걷을 때 꺼 둔 표시를 다시 걸 때 살리지 않았다
    const api = {
      worklogReadAll: vi.fn(async () => ({ ok: true as const, files: [] })),
      mailStatus: vi.fn(async () => ({ canRead: true })),
      mailSearch: vi.fn(async () => ({ ok: true as const, threads: THREADS, query: 'q', more: false, readAt: 1, fromCache: false })),
      mailThread: vi.fn(),
    };
    render(
      <StrictMode>
        <TaskLogDialog task={TASK} today={TODAY} api={api as unknown as PlannerApi} myName="박민수" knownNames={[]} onAppend={async () => true} onMemo={() => undefined} onClose={() => undefined} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText('[AB Z+] 수집 누락 원인 문의')).toBeTruthy());
    expect(screen.queryByText(/확인하는 중/)).toBeNull();
  });

  it('직접 만든 할 일 — 이전 기록 없이, 메일을 고르면 머리줄에 요청자와 채널이 붙는다', async () => {
    setup({ task: { ...TASK, origin: { kind: 'manual' }, doneAt: null } });
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    expect(screen.getByText(/직접 만든 할 일이라 이어진 일지 사안이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '완료만 기록' })).toBeNull();
    // 사안이 없어도 할 일의 제목·고객사로 가까운 메일을 골라 둔다 — 고른 동안 머리줄에 요청자와 채널이 붙는다
    expect(screen.getByText('■ (홍길동/메일) 수집 누락 원인 안내')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(screen.getByText('■ 수집 누락 원인 안내')).toBeTruthy();
  });

  it('접어 둔 메일을 고르면 다시 접어도 그 줄은 남고, 메모를 쳐도 고른 것이 바뀌지 않는다', async () => {
    setup();
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '그 밖의 메일 1건 보기' }));
    fireEvent.click(screen.getAllByRole('radio')[2]);
    fireEvent.click(screen.getByRole('button', { name: '가까운 메일만 보기' }));
    expect(screen.getByText('RE: 알림 분류 기준 변경 요청 건')).toBeTruthy();
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, false, true]);
    fireEvent.change(screen.getByPlaceholderText(/제조사지원 회신 받아/), { target: { value: '수집 누락 원인 문의 회신함' } });
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, false, true]);
    expect(screen.getByTestId('mail-narrow').textContent).not.toContain('골라 두었습니다');
  });

  it('가까운 메일이 없으면 접지 않고 다 보이고, 미리 고르지 않는다', async () => {
    setup({ task: { ...TASK, title: '방화벽 정책 신청', client: 'MX', origin: { kind: 'manual' }, note: '정책 신청서 보냄' } });
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3));
    expect(screen.getByTestId('mail-narrow').textContent).toBe('찾은 2건 가운데 이 사안과 뚜렷이 가까운 메일은 없습니다 — 최근 것부터 보입니다.');
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([true, false, false]);
    expect(screen.queryByRole('button', { name: /그 밖의 메일/ })).toBeNull();
  });
});

// ── 후보 추리기 ──────────────────────────────────────────────────────────────
describe('메일 후보 추리기 — 가까운 것을 앞에', () => {
  const hint: MailHint = { titles: ['수집 누락 원인 안내', '수집 누락 원인 문의'], notes: ['제조사지원 회신 받아 2.9.5 패치 전달'], client: 'AB Z+', who: ['홍길동'], caseDates: ['2026-11-20'], today: TODAY };
  const thread = (o: Partial<MailThreadInfo>): MailThreadInfo => ({ threadId: 'x', subject: '', from: '', date: '2026-11-01', days: ['2026-11-01'], people: [], count: 1, mine: false, ...o });

  it('견줄 낱말 — 흔한 낱말과 숫자만인 낱말은 빼고, 긴 한글 낱말은 조사를 뗀다', () => {
    expect(hintWords(['수집 누락 원인 문의 건', 'RE: 에이전트를 2.9.5로 패치'])).toEqual(['수집', '누락', '에이전트', '2.9.5', '패치']);
    expect(hintWords(['12 34', '확인 요청'])).toEqual([]);
  });

  it('제목 겹침이 가장 크고, 사안이 적힌 날·고객사·요청자·내 회신·최근이 더해진다', () => {
    const best = scoreThread(thread({ subject: '[AB Z+] 수집 누락 원인 문의', from: '홍길동 책임', date: '2026-11-26', days: ['2026-11-20', '2026-11-26'], mine: true }), hint);
    // 제목 2낱말(6) + 같은 날(4) + 고객사(2) + 요청자(1) + 내 회신(1) + 최근(1)
    expect(best.score).toBe(15);
    expect(best.why).toEqual(['제목이 겹침: 수집 · 누락', '사안이 일지에 적힌 날(11/20)의 메일', '제목에 고객사', '요청자가 보낸 메일']);
    // 고객사 표기가 달라도 같은 고객사로 본다
    expect(scoreThread(thread({ subject: '제트플러스 정기점검' }), hint).why).toEqual(['제목에 고객사']);
    // 하루 차이는 "무렵", 메모의 낱말은 보조 단서
    const near = scoreThread(thread({ subject: '2.9.5 패치 파일 요청', days: ['2026-11-21'] }), hint);
    expect(near.why).toEqual(['메모·기록의 낱말: 2.9.5 · 패치', '사안이 적힌 날 무렵의 메일']);
    expect(near.score).toBe(4);
    // 같은 사람이 보낸 다른 일은 점수가 낮다
    expect(scoreThread(thread({ subject: '11월 정기점검 일정 협의', from: '홍길동 책임', mine: true, date: '2026-11-26' }), hint).score).toBe(3);
  });

  it('가까운 것부터 세우고(같으면 최근 것 먼저), 하나가 뚜렷이 앞설 때만 미리 고른다', () => {
    const a = thread({ threadId: 'a', subject: '[AB Z+] 수집 누락 원인 문의', days: ['2026-11-20'], date: '2026-11-20' });
    const b = thread({ threadId: 'b', subject: 'RE: 알림 분류 기준 변경', from: '홍길동 책임', date: '2026-11-25' });
    const c = thread({ threadId: 'c', subject: '정기점검 일정', date: '2026-11-10' });
    const ranked = rankThreads([c, b, a], hint);
    expect(ranked.map((t) => t.threadId)).toEqual(['a', 'b', 'c']);
    expect(splitLikely(ranked).likely.map((t) => t.threadId)).toEqual(['a']);
    expect(splitLikely(ranked).rest.map((t) => t.threadId)).toEqual(['b', 'c']);
    expect(confidentPick(ranked)?.threadId).toBe('a');
    // 비슷한 후보가 둘이면 고르지 않는다
    const twin = rankThreads([a, { ...a, threadId: 'a2', subject: 'RE: [AB Z+] 수집 누락 원인 문의' }], hint);
    expect(confidentPick(twin)).toBeNull();
    // 다 낮으면 고르지 않는다
    expect(confidentPick(rankThreads([b, c], hint))).toBeNull();
    expect(confidentPick([])).toBeNull();
  });

  it('같은 고객사·같은 요청자일 뿐인 메일은, 사안을 가리키는 메일이 있으면 접어 둔다', () => {
    const topic = thread({ threadId: 'topic', subject: '[AB Z+] 수집 누락 원인 문의', from: '홍길동 책임', mine: true });
    // 제목도 날짜도 겹치지 않는다 — 고객사(2) + 요청자(1) + 내 회신(1) + 최근(1) = 5점이지만 이 사안을 가리키지는 않는다
    const sameClient = thread({ threadId: 'same', subject: '[AB Z+] 12월 정기점검 일정', from: '홍길동 책임', mine: true, date: '2026-11-26', days: ['2026-11-26'] });
    expect(scoreThread(sameClient, hint)).toMatchObject({ score: 5, pointed: false });
    expect(scoreThread(topic, hint).pointed).toBe(true);
    const both = splitLikely(rankThreads([sameClient, topic], hint));
    expect([both.likely.map((t) => t.threadId), both.rest.map((t) => t.threadId)]).toEqual([['topic'], ['same']]);
    // 가리키는 메일이 하나도 없을 때에는 고객사·요청자로 넘은 것을 먼저 보인다(요청자가 여러 고객사를 맡는 경우)
    const other = thread({ threadId: 'other', subject: '[가나스토어] 설치 일정', from: '홍길동 책임', mine: true, date: '2026-11-26', days: ['2026-11-26'] });
    const none = splitLikely(rankThreads([other, sameClient], hint));
    expect([none.likely.map((t) => t.threadId), none.rest.map((t) => t.threadId)]).toEqual([['same'], ['other']]);
  });
});
