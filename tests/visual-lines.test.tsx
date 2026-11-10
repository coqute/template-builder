/**
 * 비주얼 편집 — 목록(-)·노트(>) 줄 (v0.12.1).
 * 전에는 목록 블록 전체가 입력칸 하나라 노트(`> `)가 목록 줄과 섞인 글자로만 보였다.
 * 이제 줄마다 표지가 있고, 노트는 위 줄 아래로 들여 보인다. 저장되는 .md는 그대로다.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ItemEditor, splitTypedLines } from '../src/doctypes/weekly-visual/ItemEditor';
import { parseTolerant, serialize, type ClientItem, type ContentBlock } from '../src/core/index';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ClientItem | null = null;

function Harness({ initial }: { initial: ClientItem }) {
  const [it, setIt] = useState(initial);
  latest = it;
  const noop = () => {};
  return (
    <ItemEditor
      item={it}
      order={1}
      canMoveUp={false}
      canMoveDown={false}
      anchorId="vitem-0-0-0"
      continueDates={[]}
      collapsed={false}
      onToggleCollapse={noop}
      onField={noop}
      onClientCommit={noop}
      onMove={noop}
      onRemove={noop}
      onContinue={noop}
      onAddBlock={noop}
      onUpdateBlock={(ci: number, b: ContentBlock) => setIt((cur) => ({ ...cur, content: cur.content.map((c, k) => (k === ci ? b : c)) }))}
      onMoveBlock={noop}
      onRemoveBlock={noop}
      onIndentBlock={noop}
      onAddTurn={noop}
      onUpdateTurn={noop}
      onReplaceTurn={noop}
      onRemoveTurn={noop}
      onMoveTurn={noop}
      onTurnToList={() => null}
      onLineToTurn={() => null}
    />
  );
}

const rowsOf = (label: string) =>
  [...document.querySelectorAll(`[role=group][aria-label="${label}"] > .vx-li`)].map(
    (r) => `${(r as HTMLElement).dataset.kind}:${(r.querySelector('textarea') as HTMLTextAreaElement).value}`,
  );

const bullets = (items: string[]): ClientItem => ({ client: 'AB Z+', workType: '저장소 연동 설정 재적용', content: [{ kind: 'bullets', items }] });

describe('목록·노트 줄', () => {
  it('실제 보고서 모양 — 목록 줄마다 표지, 노트는 위 줄에 딸린 줄로 따로 보인다', () => {
    render(<Harness initial={bullets(['대상 서버: srv01', '특이사항', '> 보관기간 초과 시 자동 정리', '> 디스크 증설 요청'])} />);
    expect(rowsOf('목록')).toEqual(['dash:대상 서버: srv01', 'dash:특이사항', 'note:보관기간 초과 시 자동 정리', 'note:디스크 증설 요청']);
    expect(screen.getAllByRole('button', { name: '노트 줄 메뉴' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '목록 줄 메뉴' })).toHaveLength(2);
  });

  it('줄 앞에 "> "를 치면 노트, "- "를 치면 목록 줄 — 저장되는 .md는 같은 문법', () => {
    render(<Harness initial={bullets(['특이사항', '보관기간'])} />);
    const second = screen.getByLabelText('목록 2번째 줄 (목록)');
    act(() => {
      fireEvent.change(second, { target: { value: '> 보관기간' } });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항', 'note:보관기간']);
    expect(latest!.content[0]).toEqual({ kind: 'bullets', items: ['특이사항', '> 보관기간'] });
    act(() => {
      fireEvent.change(screen.getByLabelText('목록 2번째 줄 (노트)'), { target: { value: '- 보관기간' } });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항', 'dash:보관기간']);
  });

  it('Enter는 커서 자리에서 같은 종류의 새 줄, 빈 줄에서 Backspace는 줄 삭제', () => {
    render(<Harness initial={bullets(['특이사항', '> 자동 정리됨'])} />);
    const note = screen.getByLabelText('목록 2번째 줄 (노트)') as HTMLTextAreaElement;
    note.setSelectionRange(note.value.length, note.value.length);
    act(() => {
      fireEvent.keyDown(note, { key: 'Enter' });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항', 'note:자동 정리됨', 'note:']);
    expect(document.activeElement).toBe(screen.getByLabelText('목록 3번째 줄 (노트)'));
    act(() => {
      fireEvent.keyDown(screen.getByLabelText('목록 3번째 줄 (노트)'), { key: 'Backspace' });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항', 'note:자동 정리됨']);
    // 줄 가운데서 Enter — 뒤 글이 새 줄로
    const first = screen.getByLabelText('목록 1번째 줄 (목록)') as HTMLTextAreaElement;
    first.setSelectionRange(2, 2);
    act(() => {
      fireEvent.keyDown(first, { key: 'Enter' });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이', 'dash:사항', 'note:자동 정리됨']);
  });

  it('한글 조합 중 Enter는 줄을 만들지 않는다', () => {
    render(<Harness initial={bullets(['특이사항'])} />);
    act(() => {
      fireEvent.keyDown(screen.getByLabelText('목록 1번째 줄 (목록)'), { key: 'Enter', isComposing: true });
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항']);
  });

  it('여러 줄 붙여 넣기 — 줄마다 표지로 나눈다', () => {
    expect(splitTypedLines('dash', '대상 서버\n> 노트 하나\n  > 노트 둘\n- 다음 목록\n그냥 줄')).toEqual([
      '대상 서버',
      '> 노트 하나',
      '> 노트 둘',
      '다음 목록',
      '그냥 줄',
    ]);
    expect(splitTypedLines('note', '보충')).toEqual(['> 보충']);
    // 표지 뒤 공백이 없으면 글자다 (-> 화살표, >= 비교 같은 글)
    expect(splitTypedLines('dash', '->5분')).toEqual(['->5분']);
    expect(splitTypedLines('dash', '>=3')).toEqual(['>=3']);
  });

  it('표지 메뉴로 종류 바꾸기·줄 이동', () => {
    render(<Harness initial={bullets(['특이사항', '보관기간'])} />);
    act(() => {
      screen.getAllByRole('button', { name: '목록 줄 메뉴' })[1].click();
    });
    act(() => {
      screen.getByRole('menuitemradio', { name: /노트/ }).click();
    });
    expect(rowsOf('목록')).toEqual(['dash:특이사항', 'note:보관기간']);
    act(() => {
      screen.getByRole('button', { name: '노트 줄 메뉴' }).click();
    });
    act(() => {
      screen.getByRole('menuitem', { name: '줄 위로' }).click();
    });
    expect(rowsOf('목록')).toEqual(['note:보관기간', 'dash:특이사항']);
  });

  it('번호 작업의 세부도 같은 줄 편집 — 세부(-)와 노트(>)', () => {
    render(
      <Harness
        initial={{ client: 'AB Z+', workType: '패치', content: [{ kind: 'numbered', index: 1, title: '수집서버 패치', details: ['프로세스 재기동', '> 저장 모듈 포함'] }] }}
      />,
    );
    expect(rowsOf('세부 내용')).toEqual(['dash:프로세스 재기동', 'note:저장 모듈 포함']);
    act(() => {
      fireEvent.change(screen.getByLabelText('세부 내용 1번째 줄 (목록)'), { target: { value: '프로세스 재기동\n> 로그 확인' } });
    });
    expect(latest!.content[0]).toMatchObject({ details: ['프로세스 재기동', '> 로그 확인', '> 저장 모듈 포함'] });
  });

  it('왕복 — 화면에서 고친 목록·노트가 .md 문법 그대로 저장된다', () => {
    const md = '@PREV 2026-11-02 ~ 2026-11-08\n@CURRENT 2026-11-09 ~ 2026-11-15\n@AUTHOR 홍길동\n\n# 2026-11-03(화)\n@LOC 한강 제트플러스 4F\n@CUS IT SRE\n@SUM [AB Z+] 저장소 연동 설정 재적용\n- 특이사항\n> 자동 정리됨\n> 증설 요청\n';
    const report = parseTolerant(md).report;
    expect(report.days[0].blocks[0].items[0].content).toEqual([{ kind: 'bullets', items: ['특이사항', '> 자동 정리됨', '> 증설 요청'] }]);
    expect(serialize(report)).toContain('- 특이사항\n> 자동 정리됨\n> 증설 요청');
  });
});
