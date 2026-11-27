/**
 * 작업일지 편집기의 줄 이동 — 홈에서 사안을 열 때는 그 줄을 편집 영역 맨 위에 놓는다(v0.27.1).
 * 실제 스크롤 위치는 설치본에서 잰다(happy-dom은 배치를 계산하지 않는다) — 여기서는 요청의 모양을 본다.
 */
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { JUMP_TOP_GAP, WorklogEditor, type WorklogEditorHandle } from '../src/components/WorklogEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = Array.from({ length: 60 }, (_, i) => (i % 10 === 2 ? `■ (홍길동/메일) 사안 ${i}` : `- 줄 ${i + 1}`)).join('\n');

function mount() {
  const ref = createRef<WorklogEditorHandle>();
  render(<WorklogEditor ref={ref} value={TEXT} onChange={() => undefined} file={null} vocab={{ requesters: [], channels: [] }} onFix={() => undefined} />);
  return ref.current as WorklogEditorHandle;
}

describe('작업일지 편집기 — 줄로 가기', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('top이면 그 줄을 맨 위에 놓으라고 요청한다(위 틈 조금) — 커서도 그 줄 처음으로', () => {
    const editor = mount();
    const spy = vi.spyOn(EditorView, 'scrollIntoView');
    editor.jumpToLine(43, { top: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ y: 'start', yMargin: JUMP_TOP_GAP });
    expect(editor.cursorLine()).toBe(43);
  });

  it('기본은 보이기만 하면 되는 이동이다(맨 위로 올리지 않는다)', () => {
    const editor = mount();
    const spy = vi.spyOn(EditorView, 'scrollIntoView');
    editor.jumpToLine(13);
    expect(spy).not.toHaveBeenCalled();
    expect(editor.cursorLine()).toBe(13);
  });

  it('범위를 벗어난 줄은 처음·끝 줄로 맞춘다', () => {
    const editor = mount();
    editor.jumpToLine(999, { top: true });
    expect(editor.cursorLine()).toBe(60);
    editor.jumpToLine(0, { top: true });
    expect(editor.cursorLine()).toBe(1);
  });
});
