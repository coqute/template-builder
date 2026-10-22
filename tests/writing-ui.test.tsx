/**
 * 작성 흐름 UI 회귀 (v0.4.0) — 턴 키 동작·마커 입력·Tab 경로·되돌리기·접기
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ItemEditor } from '../src/doctypes/weekly-visual/ItemEditor';
import { VisualWeeklyEditor } from '../src/doctypes/weekly-visual/VisualWeeklyEditor';
import type { ClientItem } from '../src/core/index';
import { buildWeeklyTemplate } from '../src/hooks/useTemplate';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Node 22+ localStorage 스텁 가림 대응 — 인메모리
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

const item = (turns: ClientItem['content']): ClientItem => ({ client: 'MX', workType: '제목', content: turns });

function renderItem(it: ClientItem) {
  const handlers = {
    onAddTurn: vi.fn(),
    onUpdateTurn: vi.fn(),
    onReplaceTurn: vi.fn(),
    onRemoveTurn: vi.fn(),
    onTurnToList: vi.fn(() => null),
    onLineToTurn: vi.fn(() => null),
  };
  render(
    <ItemEditor
      item={it}
      order={1}
      canMoveUp={false}
      canMoveDown={false}
      anchorId="vitem-0-0-0"
      continueDates={[]}
      collapsed={false}
      onToggleCollapse={() => {}}
      onField={() => {}}
      onClientCommit={() => {}}
      onMove={() => {}}
      onRemove={() => {}}
      onContinue={() => {}}
      onAddBlock={() => {}}
      onUpdateBlock={() => {}}
      onMoveBlock={() => {}}
      onRemoveBlock={() => {}}
      onIndentBlock={() => {}}
      onAddTurn={handlers.onAddTurn}
      onUpdateTurn={handlers.onUpdateTurn}
      onReplaceTurn={handlers.onReplaceTurn}
      onRemoveTurn={handlers.onRemoveTurn}
      onMoveTurn={() => {}}
      onTurnToList={handlers.onTurnToList}
      onLineToTurn={handlers.onLineToTurn}
    />,
  );
  return handlers;
}

describe('대화 턴 입력 — 키 동작', () => {
  it('Ctrl+Enter는 턴을 만들지 않는다 (전역 임시보관함 단축키에 양보)', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }] }]));
    const ta = screen.getAllByLabelText('턴 내용')[0];
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(h.onAddTurn).not.toHaveBeenCalled();
  });

  it('Enter — 다음 턴이 비어 있으면 새 턴을 끼우지 않고 그 칸으로 간다', () => {
    const h = renderItem(
      item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }, { kind: 'out', text: '' }] }]),
    );
    const [first, second] = screen.getAllByLabelText('턴 내용');
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(h.onAddTurn).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(second);
  });

  it('Enter — 다음 턴이 없으면 반대 방향 턴을 추가한다', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }] }]));
    fireEvent.keyDown(screen.getByLabelText('턴 내용'), { key: 'Enter' });
    expect(h.onAddTurn).toHaveBeenCalledWith(0, { kind: 'out', text: '' }, 1);
  });

  it('줄 앞에 *<- 를 치면 미결 대응으로 바뀐다', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'out', text: '' }] }]));
    fireEvent.change(screen.getByLabelText('턴 내용'), { target: { value: '*<- 제조사 문의 예정' } });
    expect(h.onUpdateTurn).toHaveBeenCalledWith(0, 0, { kind: 'out', pending: true, text: '제조사 문의 예정' });
  });

  it('마커 줄이 섞인 여러 줄을 붙여넣으면 턴으로 나뉜다', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }] }]));
    fireEvent.change(screen.getByLabelText('턴 내용'), { target: { value: '-> 재시작해도 동일\n<- 로그 요청' } });
    expect(h.onReplaceTurn).toHaveBeenCalledWith(0, 0, [
      { kind: 'in', text: '재시작해도 동일' },
      { kind: 'out', text: '로그 요청' },
    ]);
  });

  it('Tab 경로 — 숨은 아이콘 버튼·턴 표지·메뉴 항목은 Tab 순서에서 빠진다', () => {
    renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '' }, { kind: 'out', text: '' }] }]));
    for (const label of ['턴 종류', '항목 삭제', '턴·블록 추가']) {
      for (const el of screen.getAllByLabelText(label)) expect(el.getAttribute('tabindex')).toBe('-1');
    }
    act(() => screen.getAllByLabelText('턴 종류')[0].click());
    for (const label of ['들여쓰기 (한 단계 하위로)', '턴 삭제']) {
      expect(screen.getByLabelText(label).getAttribute('tabindex')).toBe('-1');
    }
  });

  it('턴 표지 메뉴 — 턴 삭제·블록 들여쓰기를 메뉴에서 한다 (본문 위에 뜨는 도구 없음)', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }, { kind: 'out', text: '답' }] }]));
    expect(document.querySelector('.vx-blocktools, .vx-turntools')).toBeNull();
    act(() => screen.getAllByLabelText('턴 종류')[1].click());
    act(() => screen.getByLabelText('턴 삭제').click());
    expect(h.onRemoveTurn).toHaveBeenCalledWith(0, 1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('+ 메뉴 — 고른 종류의 턴을 마지막 대화 이력에 붙이고, 마지막 턴이 비어 있으면 그 턴의 종류만 바꾼다', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }] }]));
    act(() => screen.getByLabelText('턴·블록 추가').click());
    const pendingOpt = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent?.includes('미결'))!;
    act(() => (pendingOpt as HTMLElement).click());
    expect(h.onAddTurn).toHaveBeenCalledWith(0, { kind: 'out', pending: true, text: '' });
  });

  it('+ 메뉴 — 빈 마지막 턴은 새로 쌓지 않는다', () => {
    const h = renderItem(item([{ kind: 'dialog', indent: 1, turns: [{ kind: 'in', text: '문의' }, { kind: 'out', text: '' }] }]));
    act(() => screen.getByLabelText('턴·블록 추가').click());
    const concl = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent?.includes('결론'))!;
    act(() => (concl as HTMLElement).click());
    expect(h.onAddTurn).not.toHaveBeenCalled();
    expect(h.onUpdateTurn).toHaveBeenCalledWith(0, 1, { kind: 'conclusion', pending: undefined });
  });
});

describe('비주얼 편집기 — 되돌리기·추가 후 포커스·접기', () => {
  const md = buildWeeklyTemplate({ authorName: '홍길동', baseDate: new Date('2026-09-29T09:00:00') }).md;

  it('항목 추가 후 Ctrl+Z로 되돌린다 · 다시 실행은 Ctrl+Shift+Z', () => {
    const onMd = vi.fn();
    const { container } = render(<VisualWeeklyEditor md={md} onMd={onMd} />);
    const add = screen.getAllByRole('button', { name: /항목 추가/ })[0];
    act(() => add.click());
    act(() => screen.getByRole('menuitem', { name: /대화 이력/ }).click());
    const afterAdd = onMd.mock.calls.at(-1)![0] as string;
    expect(afterAdd.match(/^@SUM/gm)!.length).toBe(6);
    const root = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(root, { key: 'z', ctrlKey: true });
    expect(onMd.mock.calls.at(-1)![0]).toBe(md);
    fireEvent.keyDown(root, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(onMd.mock.calls.at(-1)![0]).toBe(afterAdd);
  });

  it('항목 추가 후 새 항목의 고객사 칸에 포커스', () => {
    render(<VisualWeeklyEditor md={md} onMd={() => {}} />);
    act(() => screen.getAllByRole('button', { name: /항목 추가/ })[0].click());
    act(() => screen.getByRole('menuitem', { name: /목록/ }).click());
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('data-field')).toBe('client');
    expect(focused.closest('[id]')?.id).toBe('vitem-0-0-1');
  });

  it('일자 접기 — 입력칸이 사라지고 요약만 남는다', () => {
    render(<VisualWeeklyEditor md={md} onMd={() => {}} />);
    const before = screen.getAllByLabelText('턴 내용').length;
    act(() => screen.getAllByTitle('접기')[0].click());
    expect(screen.getAllByLabelText('턴 내용').length).toBe(before - 2);
    expect(screen.getByText('아직 작성 전')).toBeTruthy();
  });

  it('지난주 미결 목록 — 날짜를 고르면 그날 항목으로 들어가고 목록에서 빠진다', () => {
    localStorage.setItem(
      'tb:carry:v1',
      JSON.stringify({
        week: '2026-09-21',
        from: '지난주.md',
        items: [
          {
            locations: ['원격'],
            customer: 'MX',
            header: { client: 'MX', contact: '담당A', channel: '메일', workType: '에이전트 이름 변경' },
            pending: [{ kind: 'out', text: '로그 확인 후 문의 예정' }],
            lastDate: '2026-09-16',
          },
        ],
      }),
    );
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={md} onMd={onMd} />);
    expect(screen.getByText('지난주 미결 1건')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('이어 쓸 날짜'), { target: { value: '2026-09-22' } });
    const out = onMd.mock.calls.at(-1)![0] as string;
    expect(out).toMatch(/# 2026-09-22\(화\)\n@LOC 원격\n@CUS MX\n@SUM \[MX\] \(담당A\/메일\) 에이전트 이름 변경/);
    expect(screen.queryByText('지난주 미결 1건')).toBeNull();
  });
});

describe('비주얼 편집 — 많아져도 어디에 무엇이 있는지 읽히는 화면 (v0.5.1)', () => {
  const heavy = readFileSync(resolvePath(__dirname, 'fixtures/heavy-week.md'), 'utf8');

  it('요일 띠 — 일자마다 쓴 항목 수와 미결 수, 휴일 표시', () => {
    render(<VisualWeeklyEditor md={heavy} onMd={() => {}} />);
    const strip = screen.getByRole('navigation', { name: '일자로 이동' });
    const days = [...strip.querySelectorAll('.vx-strip-day')].map((b) => b.getAttribute('aria-label'));
    expect(days).toEqual([
      '월요일 12일 항목 3 미결 1',
      '화요일 13일 항목 2 미결 1',
      '수요일 14일 항목 2 미결 1',
      '목요일 15일 항목 2',
      '금요일 16일 항목 1',
      '토요일 17일 휴일',
      '일요일 18일 휴일',
    ]);
  });

  it('요일 띠를 누르면 그 날로 — 누른 날이 바로 표시되고, 띠 단추에는 scrollIntoView를 쓰지 않는다(편집 영역 스크롤을 멈춰 한 칸씩만 가던 결함)', () => {
    const calls: Element[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const orig = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    try {
      render(<VisualWeeklyEditor md={heavy} onMd={() => {}} />);
      const strip = screen.getByRole('navigation', { name: '일자로 이동' });
      const fri = strip.querySelector<HTMLElement>('.vx-strip-day[aria-label^="금요일 16일"]')!;
      fireEvent.click(fri);
      expect(fri.getAttribute('aria-current')).toBe('true');
      expect(strip.querySelectorAll('.vx-strip-day[aria-current="true"]')).toHaveLength(1);
      // 띠 표시가 바뀌어도(효과 실행) 스크롤 대상은 그 날 구역 하나뿐
      expect(calls.map((el) => el.id)).toEqual(['vday-2026-10-16']);
      // 스크롤 중 지나치는 날로 표시가 흔들리지 않는다
      fireEvent.scroll(document.querySelector('.vx')!);
      expect(fri.getAttribute('aria-current')).toBe('true');
    } finally {
      proto.scrollIntoView = orig;
    }
  });

  it('항목 머리 — 칸마다 이름이 붙은 상자, 빈 칸도 사라지지 않는다 (손대도 줄이 밀리지 않게)', () => {
    render(<VisualWeeklyEditor md={heavy} onMd={() => {}} />);
    const item = document.getElementById('vitem-0-0-0')!;
    const chips = [...item.querySelectorAll('.vx-meta .vx-chip')].map((c) => [
      c.querySelector('.vx-chip-k')!.textContent,
      (c.querySelector('input') as HTMLInputElement).value,
    ]);
    expect(chips).toEqual([
      ['고객사', 'MX'],
      ['건물', ''],
      ['담당자', '담당A'],
      ['채널', '메일'],
    ]);
    // 제목과 대화 턴은 상자 하나 안에 — 상자 하나가 보고서 내용 칸의 한 건
    const box = item.querySelector('.vx-box')!;
    expect(box.querySelector('[data-field="workType"]')).toBeTruthy();
    expect(box.querySelectorAll('textarea[data-turn]').length).toBe(4);
  });

  it('행 머리 띠 — 지원장소·고객사|작업구분이 이름표 칸으로', () => {
    render(<VisualWeeklyEditor md={heavy} onMd={() => {}} />);
    const head = document.querySelector('#vrow-0-0 .vx-rowhead')!;
    expect([...head.querySelectorAll('.vx-chip-k')].map((k) => k.textContent)).toEqual(['지원장소', '고객사|작업구분']);
    expect((head.querySelector('[data-field="locations"]') as HTMLInputElement).value).toBe('파트너사');
  });

  it('턴 표지 — 기호와 짧은 이름, 누르면 종류 메뉴 — 고르면 그 종류로 저장', () => {
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={heavy} onMd={onMd} />);
    const item = document.getElementById('vitem-0-0-0')!;
    expect([...item.querySelectorAll('.vx-mark')].map((m) => m.textContent)).toEqual([
      '->상대',
      '<-대응',
      '->상대',
      '*<-미결',
    ]);
    const second = document.getElementById('vitem-0-0-1')!;
    act(() => (second.querySelector('.vx-mark') as HTMLElement).click());
    const option = [...second.querySelectorAll('[role="menu"] button')].find((b) => b.textContent?.includes('대기'))!;
    act(() => (option as HTMLElement).click());
    expect(onMd.mock.calls.at(-1)![0]).toContain('  *-> 11월 만료 예정 라이선스 연장 일정 문의');
  });

  it('턴 표지 메뉴의 들여쓰기 — 대화 이력 블록 전체가 한 단계 안으로', () => {
    const onMd = vi.fn();
    render(<VisualWeeklyEditor md={heavy} onMd={onMd} />);
    const item = document.getElementById('vitem-0-0-1')!;
    act(() => (item.querySelector('.vx-mark') as HTMLElement).click());
    act(() => (item.querySelector('[aria-label="들여쓰기 (한 단계 하위로)"]') as HTMLElement).click());
    const out = onMd.mock.calls.at(-1)![0] as string;
    expect(out).toContain('\n    -> 11월 만료 예정 라이선스 연장 일정 문의');
    expect(out).toContain('\n    <- 영업 담당 통해 연장 견적 진행 안내');
  });

  it('의미 없는 순번(01·02)은 표시하지 않는다', () => {
    const { container } = render(<VisualWeeklyEditor md={heavy} onMd={() => {}} />);
    expect(container.querySelector('.work-numeral')).toBeNull();
  });
});
