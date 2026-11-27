/**
 * 앱 셸의 머리 줄 — 앱 이름 글자 없이 로고만 두고, 탭 줄에는 홈이 없으며, 로고를 누르면 홈으로 간다(v0.27.1).
 * 화면(워크스페이스)은 가짜로 바꿔 셸의 동작만 본다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Node 22+의 실험적 localStorage가 happy-dom 것을 가린다 — 인메모리 스텁
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

vi.mock('../src/doctypes', () => {
  const mk = (id: string, label: string, switchHint?: string) => ({ id, label, switchHint, Workspace: () => <div data-testid={`ws-${id}`}>{label} 화면</div> });
  const mods = [mk('home', '홈', '남은 작업과 정해진 일정'), mk('weekly', '주간보고서'), mk('email', '이메일')];
  return { DOC_TYPE_MODULES: mods, getDocTypeModule: (id: string) => mods.find((m) => m.id === id) ?? mods[0] };
});

import { App } from '../src/App';
import { Toolbar } from '../src/components/Toolbar';

const header = () => document.querySelector('header') as HTMLElement;
const logo = () => within(header()).getByRole('button', { name: '홈' });
const radios = () => within(header()).getAllByRole('radio');

describe('머리 줄 — 로고가 홈 단추다', () => {
  beforeEach(() => store.clear());
  afterEach(cleanup);

  it('앱 이름 글자가 없고 로고만 있다 — 탭 줄에는 홈이 없다', () => {
    render(<App />);
    expect(screen.getByTestId('ws-home')).toBeTruthy(); // 켜면 홈
    expect(header().querySelector('h1')).toBeNull();
    expect(header().textContent).not.toMatch(/template.?builder/i);
    expect(logo().querySelector('[role="img"]')).not.toBeNull();
    expect(radios().map((r) => r.textContent)).toEqual(['주간보고서', '이메일']);
    // 홈에서는 탭 줄의 어느 칸도 켜지지 않고, 로고가 "여기"를 알린다
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(logo().getAttribute('aria-current')).toBe('page');
    expect(logo().getAttribute('title')).toBe('홈 — 남은 작업과 정해진 일정');
  });

  it('로고에는 테두리가 없고, 로고와 탭 줄 사이에 구분선도 없다 (v0.27.2)', () => {
    render(<App />);
    // 로고 바로 다음이 탭 줄이다 — 세로 구분선(빈 span)을 두지 않는다
    expect(logo().nextElementSibling?.getAttribute('role')).toBe('radiogroup');
    // 스타일: 어느 상태에서도 테두리·바탕을 켜지 않는다(홈에 있을 때 포함)
    const css = readFileSync(path.join(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    const rules = css.slice(css.indexOf('.tb-logo {')).split('\n\n')[0];
    expect(rules).toContain('border: 0;');
    expect(rules).not.toMatch(/border-color|bg-elevated/);
    expect(css).not.toContain(".tb-logo[aria-current='page']");
    // 탭 묶음에도 테두리 상자가 없다(v0.27.3) — 상자의 왼쪽 변이 로고 옆의 세로선으로 보였다
    const group = within(header()).getByRole('radiogroup');
    expect(group.className).not.toMatch(/\bborder\b|border-rule/);
    expect(group.getAttribute('style') ?? '').not.toContain('background');
  });

  it('다른 화면에서 로고를 누르면 홈으로 돌아온다', () => {
    render(<App />);
    fireEvent.click(within(header()).getByRole('radio', { name: '이메일' }));
    expect(screen.getByTestId('ws-email')).toBeTruthy();
    expect(screen.queryByTestId('ws-home')).toBeNull();
    expect(logo().getAttribute('aria-current')).toBeNull();
    expect(within(header()).getByRole('radio', { name: '이메일' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(logo());
    expect(screen.getByTestId('ws-home')).toBeTruthy();
    expect(screen.queryByTestId('ws-email')).toBeNull();
    expect(logo().getAttribute('aria-current')).toBe('page');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
  });

  it('콘솔 테마에서도 글자 없이 로고만', () => {
    render(<Toolbar options={[{ id: 'weekly', label: '주간보고서' }]} docType="weekly" onDocTypeChange={() => undefined} onHome={() => undefined} onToolbarSlot={() => undefined} onToggleHelp={() => undefined} theme="mono" />);
    expect(header().textContent).not.toMatch(/template.?builder/i);
    expect(logo()).toBeTruthy();
  });

  it('홈 화면이 등록되지 않았으면 로고는 그림으로만 남는다', () => {
    render(<Toolbar options={[{ id: 'weekly', label: '주간보고서' }]} docType="weekly" onDocTypeChange={() => undefined} onToolbarSlot={() => undefined} onToggleHelp={() => undefined} theme="paper" />);
    expect(within(header()).queryByRole('button', { name: '홈' })).toBeNull();
    expect(header().querySelector('[role="img"]')).not.toBeNull();
  });
});
