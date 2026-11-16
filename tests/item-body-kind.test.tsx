/**
 * 항목 본문 모양 — 목록(`- 한 일` / `> 상세`)과 대화 이력(`->` 상대 / `<-` 대응) (2026-11-16 사용자 신고).
 * 전에는 [항목 추가]가 늘 대화 이력으로만 만들었고, 턴 줄 앞에 `- `를 쳐도 목록이 되지 않아 `-> - 내용`으로 저장됐다.
 * 이제 추가할 때 본문 모양을 고르고, 만든 뒤에도 줄 단위로 목록 ↔ 대화 턴을 바꾼다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VisualWeeklyEditor } from '../src/doctypes/weekly-visual/VisualWeeklyEditor';
import { linesFromTurn } from '../src/doctypes/weekly-visual/ItemEditor';
import { addItem, listLineToTurnInContent, turnToListInContent } from '../src/core/edit';
import { parse } from '../src/core/parser';
import { serialize } from '../src/core/serializer';
import { typedListStart, typedTurnStart } from '../src/core/content';
import type { ContentBlock } from '../src/core/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const MD = `@PREV 2026-11-02 ~ 2026-11-08
@CURRENT 2026-11-09 ~ 2026-11-15
@AUTHOR 홍길동

# 2026-11-02(월)
@LOC 한강 제트플러스 4F
@CUS 한강 SRE
@SUM [AB Z+] (홍길동/메신저) 기존 항목
- 한 일
> 상세
`;

describe('입력 마커 해석', () => {
  it('턴 줄 앞의 "- "만 목록 — "->"는 대화 마커', () => {
    expect(typedListStart('- 작업 내용')).toBe('작업 내용');
    expect(typedListStart('-> 문의')).toBeNull();
    expect(typedListStart('-작업')).toBeNull();
    expect(typedListStart('작업 - 내용')).toBeNull();
  });
  it('목록 줄 앞의 대화 마커 — "> "는 목록 안에서도 노트라 고르지 않는다', () => {
    expect(typedTurnStart('-> 문의')).toEqual({ turn: { kind: 'in' }, rest: '문의' });
    expect(typedTurnStart('<- 안내')).toEqual({ turn: { kind: 'out' }, rest: '안내' });
    expect(typedTurnStart('*<- 회신 예정')).toEqual({ turn: { kind: 'out', pending: true }, rest: '회신 예정' });
    expect(typedTurnStart('> 노트')).toBeNull();
    expect(typedTurnStart('- 목록')).toBeNull();
  });
  it('여러 줄 턴 → 목록: 첫 줄은 목록, 이어지는 줄은 노트', () => {
    expect(linesFromTurn({ kind: 'out', text: '설정 안내\n일시정지 10분\n\n해소 알림 끔' })).toEqual(['설정 안내', '> 일시정지 10분', '> 해소 알림 끔']);
  });
});

describe('턴 ↔ 목록 줄 (본문 블록 나누기·합치기)', () => {
  const skeleton: ContentBlock = { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }, { kind: 'out', text: '' }] };

  it('빈 골격의 첫 턴에 "- " → 목록 한 블록 (남은 빈 턴은 버린다)', () => {
    const res = turnToListInContent([skeleton], 0, 0, ['작업 내용'])!;
    expect(res.content).toEqual([{ kind: 'bullets', items: ['작업 내용'] }]);
    expect(res.at).toEqual({ ci: 0, index: 0 });
  });

  it('쓴 턴 사이의 턴 → 대화 / 목록 / 대화로 나뉘고 딸린 노트 턴도 따라온다', () => {
    const d: ContentBlock = {
      kind: 'dialog',
      indent: 1,
      turns: [
        { kind: 'in', text: '문의' },
        { kind: 'out', text: '패치 적용' },
        { kind: 'note', text: '1.2.2 번들' },
        { kind: 'out', text: '안내' },
      ],
    };
    const res = turnToListInContent([d], 0, 1, ['패치 적용'])!;
    expect(res.content).toEqual([
      { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }] },
      { kind: 'bullets', items: ['패치 적용', '> 1.2.2 번들'] },
      { kind: 'dialog', indent: 1, turns: [{ kind: 'out', text: '안내' }] },
    ]);
    expect(res.at).toEqual({ ci: 1, index: 0 });
  });

  it('목록 바로 아래 대화 턴을 목록으로 — 앞 목록에 이어 붙는다', () => {
    const content: ContentBlock[] = [
      { kind: 'bullets', items: ['한 일', '> 상세'] },
      { kind: 'dialog', indent: 1, turns: [{ kind: 'out', text: '추가 작업' }] },
    ];
    const res = turnToListInContent(content, 1, 0, ['추가 작업'])!;
    expect(res.content).toEqual([{ kind: 'bullets', items: ['한 일', '> 상세', '추가 작업'] }]);
    expect(res.at).toEqual({ ci: 0, index: 2 });
  });

  it('목록 줄 → 대화 턴: 딸린 노트 줄은 노트 턴으로, 앞뒤 목록은 남는다', () => {
    const content: ContentBlock[] = [{ kind: 'bullets', items: ['한 일', '고객 문의', '> 재기동 후 정상', '마무리'] }];
    const res = listLineToTurnInContent(content, 0, 1, [{ kind: 'in', text: '고객 문의' }])!;
    expect(res.content).toEqual([
      { kind: 'bullets', items: ['한 일'] },
      { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '고객 문의' }, { kind: 'note', text: '재기동 후 정상' }] },
      { kind: 'bullets', items: ['마무리'] },
    ]);
    expect(res.at).toEqual({ ci: 1, index: 0 });
  });

  it('대화 바로 아래 목록 줄을 턴으로 — 앞 대화에 이어 붙는다', () => {
    const content: ContentBlock[] = [
      { kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }] },
      { kind: 'bullets', items: ['안내'] },
    ];
    const res = listLineToTurnInContent(content, 1, 0, [{ kind: 'out', text: '안내' }])!;
    expect(res.content).toEqual([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }, { kind: 'out', text: '안내' }] }]);
    expect(res.at).toEqual({ ci: 0, index: 1 });
  });

  it('바꾼 결과는 저장했다 다시 열어도 같은 줄이다', () => {
    const r = addItem(parse(MD), 0, 0, 'bullets');
    const item = r.days[0].blocks[0].items[1];
    expect(item.content).toEqual([{ kind: 'bullets', items: [''] }]);
    const written = { ...r };
    written.days[0].blocks[0].items[1] = {
      ...item,
      client: 'AB Z+',
      workType: '새 항목',
      content: turnToListInContent([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }, { kind: 'out', text: '조치' }, { kind: 'note', text: '상세' }] }], 0, 1, ['조치'])!.content,
    };
    const md = serialize(written);
    expect(md).toContain('@SUM [AB Z+] 새 항목\n  -> 문의\n- 조치\n> 상세\n');
    expect(parse(md).days[0].blocks[0].items[1].content).toEqual(written.days[0].blocks[0].items[1].content);
  });
});

describe('비주얼 편집기 — 항목 추가 때 본문 모양 고르기, 만든 뒤 바꾸기', () => {
  const lastMd = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as string;
  const addVia = (name: RegExp) => {
    act(() => screen.getAllByRole('button', { name: /항목 추가/ })[0].click());
    act(() => screen.getByRole('menuitem', { name }).click());
  };

  it('[항목 추가] → 메뉴에서 목록·대화 이력을 고른다 (목록이 먼저, 포커스도 목록)', () => {
    render(<VisualWeeklyEditor md={MD} onMd={() => {}} />);
    act(() => screen.getAllByRole('button', { name: /항목 추가/ })[0].click());
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items[0]).toMatch(/목록/);
    expect(items[1]).toMatch(/대화 이력/);
    expect(document.activeElement?.textContent).toMatch(/목록/);
  });

  it('목록으로 추가 → 목록 줄 하나가 생기고, 쓰면 "- " 줄로 저장된다', () => {
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={MD} onMd={onMd} />);
    addVia(/목록/);
    const box = document.getElementById('vitem-0-0-1')!;
    expect(box.querySelectorAll('textarea[data-turn]')).toHaveLength(0);
    const line = box.querySelector<HTMLTextAreaElement>('textarea[data-line="0"]')!;
    fireEvent.change(line, { target: { value: '수집서버 패치 적용' } });
    fireEvent.change(box.querySelector<HTMLTextAreaElement>('[data-field="workType"]')!, { target: { value: '패치' } });
    expect(lastMd(onMd)).toMatch(/@SUM \[AB Z\+\] 패치\n- 수집서버 패치 적용\n?/);
    expect(lastMd(onMd)).not.toMatch(/->|<-/);
  });

  it('대화 이력으로 추가 → 전처럼 상대·대응 한 쌍', () => {
    render(<VisualWeeklyEditor md={MD} onMd={() => {}} />);
    addVia(/대화 이력/);
    const box = document.getElementById('vitem-0-0-1')!;
    expect([...box.querySelectorAll('.vx-turn')].map((t) => (t as HTMLElement).dataset.kind)).toEqual(['in', 'out']);
  });

  it('턴 줄 앞에 "- " → 그 턴이 목록 줄이 되고 커서가 따라간다 (전에는 "-> - 내용"으로 저장)', () => {
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={MD} onMd={onMd} />);
    addVia(/대화 이력/);
    const box = document.getElementById('vitem-0-0-1')!;
    const turn = box.querySelector<HTMLTextAreaElement>('textarea[data-turn="0"]')!;
    act(() => {
      fireEvent.change(turn, { target: { value: '- 작업 내용' } });
    });
    const after = document.getElementById('vitem-0-0-1')!;
    expect(after.querySelectorAll('textarea[data-turn]')).toHaveLength(0);
    const line = after.querySelector<HTMLTextAreaElement>('textarea[data-line="0"]')!;
    expect(line.value).toBe('작업 내용');
    expect(document.activeElement).toBe(line);
    expect(lastMd(onMd)).toContain('\n- 작업 내용');
    expect(lastMd(onMd)).not.toContain('-> - 작업');
  });

  it('목록 줄 앞에 "-> " → 그 줄이 상대 발화가 되고, Enter로 내 대응을 이어 쓴다', () => {
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={MD} onMd={onMd} />);
    const box = document.getElementById('vitem-0-0-0')!;
    const line = box.querySelector<HTMLTextAreaElement>('textarea[data-line="0"]')!;
    act(() => {
      fireEvent.change(line, { target: { value: '-> 한 일' } });
    });
    const after = document.getElementById('vitem-0-0-0')!;
    const turns = [...after.querySelectorAll('.vx-turn')].map((t) => `${(t as HTMLElement).dataset.kind}:${(t.querySelector('textarea') as HTMLTextAreaElement).value}`);
    expect(turns).toEqual(['in:한 일', 'note:상세']);
    expect(document.activeElement).toBe(after.querySelector('textarea[data-turn="0"]'));
    expect(lastMd(onMd)).toContain('@SUM [AB Z+] (홍길동/메신저) 기존 항목\n  -> 한 일\n  > 상세');
  });

  it('턴 표지 메뉴의 [목록 줄], 목록 줄 표지 메뉴의 [상대 발화]·[내 대응]', () => {
    render(<VisualWeeklyEditor md={MD} onMd={() => {}} />);
    const box = () => document.getElementById('vitem-0-0-0')!;
    act(() => (box().querySelector('.vx-li-mark') as HTMLElement).click());
    const toOut = [...box().querySelectorAll('[role=menu] button')].find((b) => b.textContent?.includes('내 대응'))!;
    act(() => (toOut as HTMLElement).click());
    expect([...box().querySelectorAll('.vx-turn')].map((t) => (t as HTMLElement).dataset.kind)).toEqual(['out', 'note']);
    act(() => (box().querySelector('.vx-turn .vx-mark') as HTMLElement).click());
    const toList = [...box().querySelectorAll('[role=menu] button')].find((b) => b.textContent?.includes('목록 줄'))!;
    act(() => (toList as HTMLElement).click());
    expect(box().querySelectorAll('.vx-turn')).toHaveLength(0);
    expect([...box().querySelectorAll('.vx-li')].map((l) => `${(l as HTMLElement).dataset.kind}:${(l.querySelector('textarea') as HTMLTextAreaElement).value}`)).toEqual([
      'dash:한 일',
      'note:상세',
    ]);
  });
});
