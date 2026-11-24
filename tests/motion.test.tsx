/**
 * 전환 효과 — 움직임 규칙의 뼈대(테마별 차이·움직임 줄이기·끝난 뒤 값을 남기지 않기)와, 그 클래스가 붙어야 할 곳에 붙어 있는지.
 * 실제로 도는 모습(이름·길이·곡선·시작 크기)은 웹 미리보기에서 getAnimations()로 본다 — jsdom은 애니메이션을 돌리지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Modal } from '../src/components/Modal';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('움직임 규칙 (src/styles/tokens.css)', () => {
  const css = read('src/styles/tokens.css');
  const block = (start: string): string => {
    const i = css.indexOf(start);
    expect([start, i > -1]).toEqual([start, true]);
    return css.slice(i, css.indexOf('}', css.indexOf('{', i)) + 1);
  };
  const MOVING = ['.tb-scrim', '.tb-pop', '.tb-page', '.tb-menu', '.tb-swap'];

  it('창·미리보기는 가운데에서 살짝 작게 시작해 커지며 또렷해진다', () => {
    expect(css).toMatch(/@keyframes tb-zoom\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(var\(--zoom, 1\)\);/);
    const pop = block('.tb-pop {');
    expect(pop).toContain('tb-zoom');
    expect(pop).toContain('--zoom: var(--zoom-pop)');
    expect(pop).toContain('transform-origin: center');
    // 시작 크기는 1보다 조금 작다 — 창은 눈에 띄게, 넓은 본문은 조금만
    const root = css.slice(css.lastIndexOf(':root {'));
    const pick = (name: string) => Number(new RegExp(`${name}:\\s*([0-9.]+);`).exec(root)?.[1]);
    expect(pick('--zoom-pop')).toBeGreaterThan(0.9);
    expect(pick('--zoom-pop')).toBeLessThan(1);
    expect(pick('--zoom-page')).toBeGreaterThan(pick('--zoom-pop'));
    expect(pick('--zoom-page')).toBeLessThan(1);
  });

  it('콘솔 테마는 커지지 않고 끊겨서 찍힌다', () => {
    const mono = css.slice(css.lastIndexOf("[data-theme='mono'] {"));
    expect(mono).toMatch(/--zoom-pop:\s*1;/);
    expect(mono).toMatch(/--zoom-page:\s*1;/);
    expect(mono).toMatch(/--ease-settle:\s*steps\(/);
  });

  it('움직임 줄이기를 켰으면 전부 끈다', () => {
    const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of MOVING) expect(reduce).toContain(cls);
    expect(reduce).toMatch(/animation:\s*none\s*!important/);
    expect(reduce).toMatch(/\.tb-drawer\s*\{\s*transition:\s*none/);
  });

  it('들어올 때만 움직이고 끝난 뒤에는 값을 남기지 않는다 (backwards) — 안에서 뜨는 창의 자리가 흔들리지 않게', () => {
    for (const cls of MOVING) {
      const rule = block(`${cls} {`);
      expect(rule).toContain('backwards');
      expect(rule).not.toMatch(/forwards|both/);
    }
  });
});

describe('전환 클래스가 붙는 곳', () => {
  afterEach(cleanup);

  it('공용 창 — 뒤 바탕과 창', () => {
    render(
      <Modal title="예시 창" onClose={() => undefined}>
        내용
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('tb-pop')).toBe(true);
    expect((dialog.parentElement as HTMLElement).classList.contains('tb-scrim')).toBe(true);
  });

  it('탭의 본문 · 그날 미리보기 · 메뉴 · 서랍 · 다른 창', () => {
    expect(read('src/App.tsx')).toMatch(/key=\{active\.id\} className="tb-page h-full"/);
    const peek = read('src/planner/components/DayPreview.tsx');
    expect(peek).toContain('className="hm-pk-scrim tb-scrim"');
    expect(peek).toContain('className="hm-pk tb-pop"');
    expect(peek).toMatch(/key=\{day\.date\} className="hm-pk-g tb-swap"/);
    expect(read('src/components/ToolbarButton.tsx')).toContain('className="tb-menu fixed');
    expect(read('src/components/HelpDrawer.tsx')).toContain("'tb-drawer absolute");
    for (const f of ['src/components/AiReviewDialog.tsx', 'src/components/OnboardingModal.tsx']) {
      expect([f, read(f).includes('tb-scrim') && read(f).includes('tb-pop')]).toEqual([f, true]);
    }
  });
});
