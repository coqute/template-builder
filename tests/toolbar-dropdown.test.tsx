/**
 * 툴바 드롭다운 (v0.6.1) — 툴바 머리가 overflow-hidden이라 그 안에 펼친 메뉴가 잘려 보이지 않았다.
 * 메뉴는 body에 떠야 하고(잘리는 조상 밖), 바깥 클릭·Esc로 닫힌다.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MoreMenu, OpenSplitButton } from '../src/components/ToolbarButton';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('툴바 드롭다운 — 잘리는 툴바 밖에 뜬다', () => {
  it('더보기 메뉴는 overflow-hidden 툴바 밖(body)에 뜨고, 항목을 누르면 실행 후 닫힌다', () => {
    const onClick = vi.fn();
    const { container } = render(
      <header style={{ overflow: 'hidden' }}>
        <MoreMenu items={[{ label: '샘플 보기', onClick }]} />
      </header>,
    );
    act(() => screen.getByLabelText('더보기').click());
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    // 화면 기준 고정 위치 — 버튼 바로 아래 오른쪽 끝에 맞춘다
    expect(menu.className).toContain('fixed');
    expect(menu.style.top).not.toBe('');
    expect(menu.style.right).not.toBe('');
    act(() => screen.getByRole('menuitem', { name: '샘플 보기' }).click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('바깥을 누르거나 Esc면 닫힌다 — 메뉴 안을 누르는 것은 바깥이 아니다', () => {
    render(<MoreMenu items={[{ label: '샘플 보기', onClick: () => {} }]} />);
    act(() => screen.getByLabelText('더보기').click());
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => screen.getByLabelText('더보기').click());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('열기의 최근 파일 목록도 body에 뜬다', () => {
    const onOpenRecent = vi.fn();
    const { container } = render(
      <header style={{ overflow: 'hidden' }}>
        <OpenSplitButton onOpen={() => {}} recentFiles={['C:/보고/2026-10-12.md']} onOpenRecent={onOpenRecent} />
      </header>,
    );
    act(() => screen.getByLabelText('최근 파일').click());
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    act(() => screen.getByRole('menuitem').click());
    expect(onOpenRecent).toHaveBeenCalledWith('C:/보고/2026-10-12.md');
  });
});
