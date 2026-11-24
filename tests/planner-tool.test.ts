// @vitest-environment node
/**
 * 플래너 도구(electron/planner-tool.ts) — 명령줄·MCP 서버가 할 일 저장소와 작업일지 사안을 다루는 길.
 * 실제 임시 폴더에 쓰고 읽는다. 일지·이름·고객사는 모두 합성 값이다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { applyToStore, readLog, readStore } from '../electron/planner-store';
import { callTool, handleRpc, serveStdio, TOOLS, type ToolEnv } from '../electron/planner-tool';
import { followupHead } from '../src/planner/anchor';
import { addDays } from '../src/planner/dates';
import type { PlannerState, WorklogAnchor } from '../src/planner/types';

const TODAY = '2026-11-24';
const FOLDER = 'AB Z+ 작업';
const day = (n: number) => addDays(TODAY, n);

let tmp = '';
let dir = '';
let root = '';
let env: ToolEnv;

async function log(folder: string, date: string, title: string, body: string, raw?: Buffer): Promise<string> {
  const file = path.join(root, folder, `[${date}] ${title}.txt`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw ?? `[${date}] ${title}\n\n${body}\n`);
  return file;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'tb-planner-tool-'));
  dir = path.join(tmp, 'store');
  root = path.join(tmp, 'worklogs');
  env = { dir, worklogRoot: root, by: 'claude', now: () => new Date(2026, 10, 24, 10, 0, 0) };
  await log(FOLDER, day(-11), '웹훅 점검', '■ (담당A/메신저) 웹훅 연동 설정 전수 확인\n※ event DB 접속 불가로 담당B 대리님에게 조회 요청 예정');
  await log(FOLDER, day(-5), '수집 점검', '■ (홍길동/메일) 수집 누락 원인 문의\n▶ 에이전트 로그 회수 후 원인 확인\n- 대상: 수집 서버 2대\n- 원인 확인 중 — 제조사 회신 대기');
  await log(FOLDER, day(-3), '패치 안내', '■ (담당C/메일) v2.1 패치 안내\n▶ 패치 파일 전달 완료');
  await log(FOLDER, day(-2), '주간 미팅', '■ MX 주간 미팅 회의 (캘린더 일정)\n▶ 회의 참석 — 알림 분류 개선 일정 협의');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function run(name: string, args: unknown = {}): Promise<any> {
  const r = await callTool(env, name, args);
  if (!r.ok) throw new Error(`${name} 실패: ${r.result.error}`);
  return r.result;
}

async function fail(name: string, args: unknown = {}): Promise<string> {
  const r = await callTool(env, name, args);
  expect(r.ok).toBe(false);
  return (r.result as { error: string }).error;
}

async function state(): Promise<PlannerState> {
  const r = await readStore(dir);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

async function caseOf(query: string): Promise<WorklogAnchor> {
  const r = await run('planner_worklog_find_case', { query });
  expect(r.total).toBe(1);
  return r.cases[0].case;
}

describe('읽기', () => {
  it('빈 저장소 — 요약은 0건이고 일지의 열린 사안이 후보로 나온다', async () => {
    const r = await run('planner_overview');
    expect(r.today).toBe(TODAY);
    expect(r.counts).toMatchObject({ late: 0, today: 0, week: 0, later: 0, none: 0, waiting: 0, done: 0 });
    expect(r.open_tasks).toEqual([]);
    expect(r.worklog.ready).toBe(true);
    // 닫힌 사안(패치 안내)과 지난 회의 기록은 후보가 아니다
    expect(r.worklog.candidates.map((c: any) => c.title).sort()).toEqual(['수집 누락 원인 문의', '웹훅 연동 설정 전수 확인']);
    expect(r.worklog.candidates.find((c: any) => c.title === '수집 누락 원인 문의')).toMatchObject({ status: 'wait', waiting_on: '제조사', date: day(-5) });
    // 읽기만 했다 — 저장 폴더도 만들지 않는다
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('작업일지 폴더를 모르면 할 일은 그대로 보여 주고 이유를 알린다', async () => {
    const r = await callTool({ ...env, worklogRoot: path.join(tmp, '없는 폴더') }, 'planner_overview', {});
    expect(r.ok).toBe(true);
    expect((r.result as any).worklog).toMatchObject({ ready: false });
    expect((r.result as any).worklog.error).toContain('작업일지 폴더가 없습니다');
  });

  it('사안 찾기 — 낱말은 모두 들어 있어야 하고, 같은 사안은 최근 기록 하나로 묶인다', async () => {
    await log(FOLDER, day(-1), '수집 후속', '■ (홍길동/메일) 수집 누락 원인 문의 (11/19 문의 후속)\n▶ 로그 분석 결과 전달 완료');
    const all = await run('planner_worklog_find_case', {});
    // 지난 회의 기록도 찾는다(달력 일정을 잇는 데 쓴다) — 후보에는 오르지 않고 meeting으로 표시된다
    expect(all.cases.find((c: any) => c.case.title === 'MX 주간 미팅 회의')).toMatchObject({ meeting: true, status: null });
    expect(all.cases.filter((c: any) => c.meeting)).toHaveLength(1);
    const hit = await run('planner_worklog_find_case', { query: '수집 홍길동' });
    expect(hit.total).toBe(1);
    expect(hit.cases[0]).toMatchObject({ first_date: day(-5), occurrences: 2, status: { cls: 'done' } });
    expect(hit.cases[0].case).toMatchObject({ folder: FOLDER, date: day(-1), name: `[${day(-1)}] 수집 후속.txt` });
    expect((await run('planner_worklog_find_case', { query: '수집 담당A' })).total).toBe(0);
    // 닫힌 사안은 open_only에서 빠진다
    const open = await run('planner_worklog_find_case', { open_only: true });
    expect(open.cases.map((c: any) => c.case.title)).toEqual(['웹훅 연동 설정 전수 확인']);
    expect(await fail('planner_worklog_find_case', { folder: '../밖' })).toContain('허용되지 않는 폴더');
  });
});

describe('할 일', () => {
  it('더하고 고치고 끝낸다 — 고친 쪽이 claude로 남는다', async () => {
    const added = await run('planner_task_add', { title: '저장소 증설 용량 산정', client: '예시IT', due: day(3) });
    expect(added.task).toMatchObject({ title: '저장소 증설 용량 산정', client: '예시IT', due: day(3), state: 'todo', by: 'claude' });
    const id = added.task.id;
    expect((await run('planner_task_list')).tasks.map((t: any) => t.id)).toEqual([id]);

    const moved = await run('planner_task_update', { id, due: day(10), waiting_on: '담당B' });
    expect(moved.task).toMatchObject({ due: day(10), state: 'waiting', waiting_on: '담당B' });
    expect((await run('planner_task_update', { id, due: null, state: 'todo' })).task).toMatchObject({ due: null, state: 'todo', group: 'none' });

    const done = await run('planner_task_update', { id, done: true });
    expect(done.task.state).toBe('done');
    expect((await run('planner_task_list')).total).toBe(0);
    expect((await run('planner_task_list', { state: 'done' })).total).toBe(1);
    expect((await state()).tasks[0]).toMatchObject({ by: 'claude' });
    expect((await readLog(dir, 10)).every((e) => e.by === 'claude')).toBe(true);
  });

  it('틀린 입력은 저장소를 바꾸지 않는다', async () => {
    const { task } = await run('planner_task_add', { title: '방화벽 정책 신청' });
    const rev = (await state()).rev;
    expect(await fail('planner_task_add', {})).toContain('title');
    expect(await fail('planner_task_add', { title: '기한 틀림', due: '2026-02-30' })).toContain('날짜');
    expect(await fail('planner_task_add', { title: '방화벽  정책 신청' })).toContain('이미 있습니다');
    expect(await fail('planner_task_add', { title: '오타', duee: day(1) })).toContain('모르는 인자');
    expect(await fail('planner_task_update', { id: 't_없음', title: 'x' })).toContain('찾지 못했습니다');
    expect(await fail('planner_task_update', { id: task.id })).toContain('바꿀 것이 없습니다');
    expect(await fail('planner_task_update', { id: task.id, done: false })).toContain('이미 열린');
    expect(await fail('없는_도구')).toContain('모르는 도구');
    expect((await state()).rev).toBe(rev);
    // 같은 제목이라도 따로 더하겠다고 하면 더한다
    await run('planner_task_add', { title: '방화벽 정책 신청', allow_duplicate: true });
    expect((await state()).tasks).toHaveLength(2);
  });

  it('일지 사안에서 올린 할 일 — 출처가 사안이고, 그 사안은 후보에서 빠진다', async () => {
    const c = await caseOf('웹훅');
    const { task } = await run('planner_task_add', { title: '웹훅 설정 조회 요청', case: c, due: day(1) });
    expect(task.case).toMatchObject({ folder: FOLDER, caseKey: c.caseKey, date: day(-11) });
    expect(task.who).toBe('담당A');
    expect((await state()).tasks[0].origin).toMatchObject({ kind: 'worklog' });
    const o = await run('planner_overview');
    expect(o.worklog.candidates.map((x: any) => x.title)).toEqual(['수집 누락 원인 문의']);
    expect((await run('planner_worklog_find_case', { query: '웹훅' })).cases[0].tasks).toEqual([task.id]);
    expect(await fail('planner_task_add', { title: '다른 제목', case: c })).toContain('같은 사안');
    // 일지에 없는 사안은 잇지 않는다
    expect(await fail('planner_task_add', { title: 'x', case: { ...c, caseKey: '없는사안' } })).toContain('사안을 찾지 못했습니다');
    expect(await fail('planner_task_add', { title: 'x', case: { ...c, name: '..\\밖.txt' } })).toContain('파일명');
  });

  it('일지에서 닫힌 사안의 할 일을 알려 준다', async () => {
    const c = await caseOf('웹훅');
    const { task } = await run('planner_task_add', { title: '웹훅 설정 조회 요청', case: c });
    await log(FOLDER, day(-1), '웹훅 후속', '■ (담당A/메신저) 웹훅 연동 설정 전수 확인 (11/13 문의 후속)\n▶ 조회 결과 안내 완료');
    const o = await run('planner_overview');
    expect(o.worklog.closed_in_worklog).toEqual([{ id: task.id, title: '웹훅 설정 조회 요청', closed_on: day(-1) }]);
  });
});

describe('달력 일정 잇기', () => {
  it('일정을 할 일과 사안에 잇고 끊는다', async () => {
    const c = await caseOf('수집');
    const { task } = await run('planner_task_add', { title: '로그 회수' });
    const ref = { calendar_id: 'primary', event_id: 'evt-1' };
    const r = await run('planner_event_link', { ...ref, task_id: task.id, case: c });
    expect(r.revs).toHaveLength(2);
    let s = await state();
    expect(s.links).toEqual([expect.objectContaining({ calendarId: 'primary', eventId: 'evt-1', anchor: expect.objectContaining({ caseKey: c.caseKey }) })]);
    expect(s.tasks[0].event).toEqual({ calendarId: 'primary', eventId: 'evt-1' });

    expect(await fail('planner_event_link', ref)).toContain('task_id');
    expect(await fail('planner_event_link', { ...ref, event_id: 'evt-2', unlink: true })).toContain('이어진 일지 사안이 없습니다');
    await run('planner_event_link', { ...ref, unlink: true });
    await run('planner_event_link', { ...ref, task_id: task.id, unlink: true });
    s = await state();
    expect(s.links).toEqual([]);
    expect(s.tasks[0].event).toBeNull();
  });
});

describe('작업일지에 후속 블록 덧붙이기', () => {
  const lines = ['▶ 담당B 대리님에게 조회 요청', '- 대상: 웹훅 설정 3건', '  > 회신은 11/26 예정'];

  it('오늘 일지가 없으면 그 블록으로 새로 만든다 — 지난 일지는 그대로', async () => {
    const c = await caseOf('웹훅');
    const before = await readFile(path.join(root, FOLDER, c.name));
    const dry = await run('planner_worklog_append_followup', { case: c, lines, dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, created: true });
    expect((await readdir(path.join(root, FOLDER))).some((n) => n.startsWith(`[${TODAY}]`))).toBe(false);

    const r = await run('planner_worklog_append_followup', { case: c, lines });
    expect(r).toMatchObject({ folder: FOLDER, file: `[${TODAY}] 웹훅 연동 설정 전수 확인.txt`, created: true });
    const text = await readFile(path.join(root, FOLDER, r.file), 'utf8');
    expect(text).toBe(`[${TODAY}] 웹훅 연동 설정 전수 확인\n\n■ (담당A/메신저) 웹훅 연동 설정 전수 확인 (11/13 문의 후속)\n${lines.join('\n')}\n`);
    expect((await readFile(path.join(root, FOLDER, c.name))).equals(before)).toBe(true);
  });

  it('오늘 일지가 있으면 끝에만 붙인다 — BOM·CRLF와 앞 내용은 바이트 그대로, 원본은 백업', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`[${TODAY}] 오늘 작업\r\n\r\n■ (담당C/메일) 계정 추가 요청\r\n▶ 계정 2개 추가 완료\r\n\r\n`, 'utf8')]);
    const file = await log(FOLDER, TODAY, '오늘 작업', '', original);
    const c = await caseOf('웹훅');
    const r = await run('planner_worklog_append_followup', { case: c, lines });
    expect(r).toMatchObject({ file: `[${TODAY}] 오늘 작업.txt`, created: false });
    const after = await readFile(file);
    const head = original.subarray(0, original.length - 4); // 끝의 빈 줄 둘은 정리된다
    expect(after.subarray(0, head.length).equals(head)).toBe(true);
    expect(after.subarray(head.length).toString('utf8')).toBe(
      `\r\n\r\n■ (담당A/메신저) 웹훅 연동 설정 전수 확인 (11/13 문의 후속)\r\n${lines.join('\r\n')}\r\n`,
    );
    expect((await readFile(r.backup)).equals(original)).toBe(true);
    expect(path.dirname(r.backup)).toBe(path.join(dir, 'worklog-backup'));
    // 같은 블록을 두 번 붙이지 않는다
    expect(await fail('planner_worklog_append_followup', { case: c, lines })).toContain('같은 블록이 이미 있습니다');
    expect((await readFile(file)).equals(after)).toBe(true);
  });

  it('오늘 기록한 사안의 후속은 (후속), 이미 후속 블록이면 처음 문의한 날짜를 쓴다', async () => {
    await log(FOLDER, TODAY, '오늘 작업', '■ (담당C/메일) 계정 추가 요청\n▶ 계정 2개 추가 — 고객 확인 대기');
    const c = await caseOf('계정');
    const r = await run('planner_worklog_append_followup', { case: c, lines: ['▶ 고객 확인 완료'] });
    expect(r.block).toBe('■ (담당C/메일) 계정 추가 요청 (후속)\n▶ 고객 확인 완료');
    expect(followupHead({ title: '수집 누락 원인 문의 (11/19 문의 후속)', source: '홍길동/메일', date: day(-1) }, TODAY)).toBe(
      '■ (홍길동/메일) 수집 누락 원인 문의 (11/19 문의 후속)',
    );
    expect(followupHead({ title: '출처 없는 사안', source: '', date: '2026-01-05' }, TODAY)).toBe('■ 출처 없는 사안 (1/5 문의 후속)');
  });

  it('줄 모양이 틀리면 쓰지 않는다', async () => {
    const c = await caseOf('웹훅');
    const bad = async (l: unknown) => fail('planner_worklog_append_followup', { case: c, lines: l });
    expect(await bad([])).toContain('lines가 필요합니다');
    expect(await bad(['■ 다른 사안'])).toContain('시작해야 합니다');
    expect(await bad(['- 사실부터'])).toContain('첫 줄');
    expect(await bad(['▶ 한 줄\n■ 숨긴 사안'])).toContain('줄바꿈');
    expect(await bad(['▶ ' + '가'.repeat(600)])).toContain('너무 깁니다');
    expect(await bad(Array.from({ length: 41 }, () => '▶ 줄'))).toContain('40줄');
    expect(await fail('planner_worklog_append_followup', { lines })).toContain('case가 필요합니다');
    expect((await readdir(path.join(root, FOLDER))).some((n) => n.startsWith(`[${TODAY}]`))).toBe(false);
  });

  it('오늘 일지가 둘이면 고르지 않는다', async () => {
    await log(FOLDER, TODAY, '하나', '■ 사안 하나\n▶ 처리 완료');
    await log(FOLDER, TODAY, '둘', '■ 사안 둘\n▶ 처리 완료');
    expect(await fail('planner_worklog_append_followup', { case: await caseOf('웹훅'), lines })).toContain('2개');
  });
});

describe('바뀐 기록 · 되돌리기', () => {
  it('도구가 고친 것을 되돌린다', async () => {
    const { task, rev } = await run('planner_task_add', { title: '대시보드 템플릿 정리' });
    const upd = await run('planner_task_update', { id: task.id, due: day(2) });
    const list = await run('planner_changes');
    expect(list.changes.map((c: any) => [c.rev, c.op, c.by, c.undoable])).toEqual([
      [upd.revs[0], 'task.update', 'claude', true],
      [rev, 'task.add', 'claude', true],
    ]);
    expect(list.changes[0].title).toBe('대시보드 템플릿 정리');

    // 더한 기록은 그 뒤에 고쳐졌으므로 되돌리지 않는다 — 고친 것부터 되돌린다
    expect(await fail('planner_undo', { rev })).toContain('그 뒤에 다시 바뀐');
    await run('planner_undo', { rev: upd.revs[0] });
    expect((await state()).tasks[0]).toMatchObject({ id: task.id, due: null });
    await run('planner_undo', { rev });
    expect((await state()).tasks).toEqual([]);
    expect(await fail('planner_undo', { rev })).toContain('이미 없습니다');
    expect(await fail('planner_undo', { rev: 999 })).toContain('찾지 못했습니다');
    expect(await fail('planner_undo', {})).toContain('rev');
  });

  it('앱에서 사용자가 고친 것은 되돌리지 않는다', async () => {
    const r = await applyToStore(dir, { type: 'task.add', draft: { title: '사용자가 더한 일' } }, 'app');
    expect(r.ok).toBe(true);
    const list = await run('planner_changes', { by: 'app' });
    expect(list.changes).toEqual([expect.objectContaining({ by: 'app', undoable: false })]);
    expect(await fail('planner_undo', { rev: list.changes[0].rev })).toContain('사용자가 고친 기록');
    expect((await state()).tasks).toHaveLength(1);
  });
});

describe('MCP 서버', () => {
  const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

  it('initialize — 아는 규격 날짜는 그대로, 모르는 날짜는 아는 최신으로 답한다', async () => {
    const a: any = await handleRpc(env, rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }));
    expect(a).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tb-planner' } } });
    const b: any = await handleRpc(env, rpc(2, 'initialize', { protocolVersion: '2099-01-01' }));
    expect(b.result.protocolVersion).toBe('2025-06-18');
    expect(b.result.instructions).toContain('planner_overview');
  });

  it('tools/list — 도구 9개, 읽기 도구에는 읽기 전용 표시', async () => {
    const r: any = await handleRpc(env, rpc(3, 'tools/list'));
    expect(r.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(r.result.tools).toHaveLength(9);
    for (const t of r.result.tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(10);
    }
    const ro = Object.fromEntries(r.result.tools.map((t: any) => [t.name, t.annotations.readOnlyHint]));
    expect(ro).toMatchObject({ planner_overview: true, planner_task_list: true, planner_worklog_find_case: true, planner_changes: true, planner_task_add: false, planner_undo: false });
  });

  it('tools/call — 결과는 글자 JSON, 틀린 입력은 isError', async () => {
    const ok: any = await handleRpc(env, rpc('a', 'tools/call', { name: 'planner_task_add', arguments: { title: '분기 리뷰 자료' } }));
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0].text).task.title).toBe('분기 리뷰 자료');
    const bad: any = await handleRpc(env, rpc('b', 'tools/call', { name: 'planner_task_add', arguments: {} }));
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0].text).error).toContain('title');
    expect(await handleRpc(env, rpc('c', 'tools/call', { name: '없는_도구' }))).toMatchObject({ id: 'c', error: { code: -32602 } });
  });

  it('알림에는 답하지 않고, 모르는 요청은 오류로 답한다', async () => {
    expect(await handleRpc(env, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await handleRpc(env, { jsonrpc: '2.0', id: 9, result: {} })).toBeNull();
    expect(await handleRpc(env, rpc(4, 'ping'))).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(await handleRpc(env, rpc(5, 'resources/list'))).toMatchObject({ id: 5, error: { code: -32601 } });
    expect(await handleRpc(env, { id: 6, method: 'ping' })).toMatchObject({ id: 6, error: { code: -32600 } });
    expect(await handleRpc(env, 'x')).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('표준 입출력 — 한 줄에 하나씩, 온 순서대로 답한다', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const served = serveStdio(env, input, output);
    input.write(`${JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write('{깨진 줄\n\n');
    input.write(`${JSON.stringify(rpc(2, 'tools/call', { name: 'planner_task_add', arguments: { title: '첫째' } }))}\n`);
    input.write(`${JSON.stringify(rpc(3, 'tools/call', { name: 'planner_task_list', arguments: {} }))}\n`);
    input.end();
    await served;
    const out = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(out.map((m) => m.id)).toEqual([1, null, 2, 3]);
    expect(out[1].error.code).toBe(-32700);
    expect(JSON.parse(out[3].result.content[0].text).tasks.map((t: any) => t.title)).toEqual(['첫째']);
  });
});

describe('실행기 (scripts/planner-tool.mjs)', () => {
  function launch(args: string[], stdin?: string): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'planner-tool.mjs'), ...args], {
        cwd: process.cwd(),
        env: { ...process.env, TB_PLANNER_DIR: dir, TB_WORKLOG_ROOT: root },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.end(stdin ?? '');
    });
  }

  it('명령줄로 더하고, MCP 서버로 같은 저장소를 읽는다', async () => {
    const argFile = path.join(tmp, 'args.json');
    await writeFile(argFile, JSON.stringify({ title: '정기점검 체크리스트 갱신', due: TODAY }));
    const added = await launch(['call', 'planner_task_add', `@${argFile}`]);
    expect(added.err).toBe('');
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out).task.title).toBe('정기점검 체크리스트 갱신');

    const bad = await launch(['call', 'planner_task_add', '-'], '{}');
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).error).toContain('title');

    const session = [
      rpcLine(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      rpcLine(2, 'tools/list'),
      rpcLine(3, 'tools/call', { name: 'planner_overview', arguments: {} }),
    ].join('\n');
    const mcp = await launch(['mcp'], `${session}\n`);
    expect(mcp.code).toBe(0);
    // 표준 출력에는 JSON-RPC 메시지만 나온다
    const msgs = mcp.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(msgs[1].result.tools).toHaveLength(9);
    const o = JSON.parse(msgs[2].result.content[0].text);
    expect(o.open_tasks.map((t: any) => t.title)).toEqual(['정기점검 체크리스트 갱신']);
    expect(o.worklog.ready).toBe(true);
    expect((await state()).tasks[0].by).toBe('claude');
  }, 60000);

  function rpcLine(id: number, method: string, params?: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  }
});
