/**
 * Mac식 움직임 — 누른 자리에서 커지며 열리고 그 자리로 닫히는 계산(lib/motion), 닫힘이 움직임이 끝난 뒤에 일어나는지,
 * 규칙의 뼈대(스프링 곡선·움직임 줄이기·끝난 뒤 값을 남기지 않기)와 그 클래스가 붙어야 할 곳.
 * 실제로 도는 모습은 웹 미리보기에서 getAnimations()로 본다 — 테스트 환경은 요소를 그리지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../src/components/Modal';
import { canAnimate, CLOSE_MS, growFrom, leave, OPEN_MS, shrinkTo, SPRING, transformFrom } from '../src/lib/motion';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** 화면에 그려진 것처럼 — 크기가 있고, animate가 부른 내용을 남기며, 끝나는 때를 테스트가 정한다 */
function drawn(box: DOMRect) {
  const el = document.createElement('div');
  const calls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const finish: Array<() => void> = [];
  el.getBoundingClientRect = () => box;
  (el as unknown as { animate: unknown }).animate = (frames: Keyframe[], options: KeyframeAnimationOptions) => {
    calls.push({ frames, options });
    let done = () => undefined as void;
    const finished = new Promise<void>((r) => {
      done = r;
    });
    finish.push(done);
    return { finished, cancel: () => undefined };
  };
  return { el, calls, finish };
}

describe('누른 자리에서 커지고 그 자리로 닫힌다 (lib/motion)', () => {
  // 가운데 창(880×460, 화면 가운데쯤)과 띠의 날 칸(150×90, 왼쪽 위쪽)
  const WINDOW = rect(260, 105, 880, 460);
  const CELL = rect(60, 140, 154, 92);

  it('시작 모습 — 칸의 가운데에 맞추고 너비 비율로 줄인다(가로세로 같은 비율)', () => {
    const { el } = drawn(WINDOW);
    // 가운데 차이: x = (60 + 77) − (260 + 440) = −563, y = (140 + 46) − (105 + 230) = −149 · 크기 = 154 / 880 = 0.175
    expect(transformFrom(el, CELL)).toBe('translate(-563.0px, -149.0px) scale(0.1750)');
  });

  it('자리를 모르면 가운데에서 살짝 작게, 누른 것이 아주 작아도 0.1배보다 작게 시작하지 않는다', () => {
    const { el } = drawn(WINDOW);
    expect(transformFrom(el, null)).toBe('scale(0.9)');
    expect(transformFrom(el, rect(0, 0, 0, 0))).toBe('scale(0.9)');
    expect(transformFrom(el, rect(260, 105, 20, 20))).toMatch(/scale\(0\.1000\)$/);
    // 창보다 큰 것에서 나와도 커지지는 않는다
    expect(transformFrom(el, rect(0, 0, 2000, 900))).toMatch(/scale\(1\.0000\)$/);
  });

  it('열릴 때 — 스프링 곡선으로, 또렷함이 크기보다 먼저 끝나고, 끝난 뒤 값을 남기지 않는다', () => {
    const { el, calls } = drawn(WINDOW);
    expect(growFrom(el, CELL)).not.toBeNull();
    const { frames, options } = calls[0];
    expect(frames[0]).toMatchObject({ transform: 'translate(-563.0px, -149.0px) scale(0.1750)', opacity: 0 });
    expect(frames[1]).toMatchObject({ opacity: 1, offset: 0.3 });
    expect(frames.at(-1)).toMatchObject({ transform: 'none', opacity: 1 });
    expect(options).toEqual({ duration: OPEN_MS, easing: SPRING });
    expect(options.fill).toBeUndefined();
  });

  it('닫힐 때 — 같은 길로 돌아가고 열릴 때보다 짧다. 끝날 때까지 기다린다', async () => {
    const { el, calls, finish } = drawn(WINDOW);
    let done = false;
    void shrinkTo(el, CELL).then(() => {
      done = true;
    });
    const { frames, options } = calls[0];
    expect(frames[0]).toMatchObject({ transform: 'none', opacity: 1 });
    expect(frames.at(-1)).toMatchObject({ transform: 'translate(-563.0px, -149.0px) scale(0.1750)', opacity: 0 });
    expect(options.duration).toBe(CLOSE_MS);
    expect(CLOSE_MS).toBeLessThan(OPEN_MS * 0.7);
    expect(options.fill).toBe('forwards'); // 떼어 낼 때까지 사라진 모습으로 멈춰 있는다
    await Promise.resolve();
    expect(done).toBe(false);
    finish[0]();
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it('leave — 창과 뒤 바탕이 모두 끝난 뒤에 닫고, 그동안은 눌리지 않는다', async () => {
    const panel = drawn(WINDOW);
    const scrim = drawn(rect(0, 0, 1400, 950));
    const closed = vi.fn();
    leave(panel.el, scrim.el, CELL, closed);
    expect(scrim.el.style.pointerEvents).toBe('none');
    panel.finish[0]();
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    scrim.finish[0]();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('그려지지 않은 요소(테스트 환경)·움직임 줄이기에서는 움직이지 않고 바로 끝난다', async () => {
    const el = document.createElement('div');
    expect(canAnimate(el)).toBe(false);
    expect(growFrom(el, CELL)).toBeNull();
    const closed = vi.fn();
    leave(el, null, CELL, closed);
    expect(closed).toHaveBeenCalledTimes(1);

    const real = drawn(WINDOW);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    try {
      expect(canAnimate(real.el)).toBe(false);
      await shrinkTo(real.el, CELL);
      expect(real.calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('공용 창', () => {
  afterEach(cleanup);

  it('테스트 환경에서는 Esc·바깥·[×]가 전과 같이 바로 닫는다', () => {
    const onClose = vi.fn();
    render(
      <Modal title="예시 창" onClose={onClose}>
        내용
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <Modal title="예시 창" onClose={onClose}>
        내용
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole('dialog')); // 창 안
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('움직임 규칙 (src/styles/tokens.css)', () => {
  const css = read('src/styles/tokens.css');
  const motion = css.slice(css.indexOf(' * 전환 — Mac식 움직임'));
  const block = (start: string): string => {
    const i = motion.indexOf(start);
    expect([start, i > -1]).toEqual([start, true]);
    return motion.slice(i, motion.indexOf('}', motion.indexOf('{', i)) + 1);
  };
  const MOVING = ['.tb-scrim', '.tb-pop', '.tb-page', '.tb-menu', '.tb-swap'];

  it('CSS의 스프링 곡선은 lib/motion의 것과 같은 값이다', () => {
    expect(motion).toContain(`--ease-spring: ${SPRING};`);
  });

  it('스프링은 튕기지 않고(1을 넘지 않고) 줄곧 오른다', () => {
    const values = SPRING.slice('linear('.length, -1)
      .split(',')
      .map((p) => Number(p.trim().split(' ')[0]));
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    expect(values.every((v, i) => v <= 1 && (i === 0 || v >= values[i - 1]))).toBe(true);
    // 처음에 빠르다 — 시간의 4분의 1에 이미 3분의 2쯤 가 있다
    expect(SPRING).toContain('0.6691 25%');
  });

  it('두 테마가 같은 움직임이다 — 테마별 값을 따로 두지 않는다', () => {
    expect(motion).not.toContain("[data-theme='mono']");
  });

  it('창·메뉴는 조금 작게 시작해 커지고, 넓은 본문은 그보다 덜 줄인다', () => {
    const pick = (name: string) => Number(new RegExp(`${name}:\\s*([0-9.]+);`).exec(motion)?.[1]);
    expect(pick('--zoom-pop')).toBeGreaterThanOrEqual(0.85);
    expect(pick('--zoom-pop')).toBeLessThan(1);
    expect(pick('--zoom-page')).toBeGreaterThan(pick('--zoom-pop'));
    expect(pick('--zoom-page')).toBeLessThan(1);
    expect(block('.tb-menu {')).toContain('transform-origin: top right');
  });

  it('움직임 줄이기를 켰으면 전부 끈다', () => {
    const reduce = motion.slice(motion.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of MOVING) expect(reduce).toContain(cls);
    expect(reduce).toMatch(/animation:\s*none\s*!important/);
    expect(reduce).toMatch(/\.tb-drawer\s*\{\s*transition:\s*none/);
  });

  it('끝난 뒤에는 값을 남기지 않는다 (backwards) — 안에서 뜨는 창의 자리가 흔들리지 않게', () => {
    for (const cls of MOVING) {
      const rule = block(`${cls} {`);
      expect(rule).toContain('backwards');
      expect(rule).not.toMatch(/forwards|both/);
    }
  });
});

describe('움직임이 붙는 곳', () => {
  it('그날 미리보기와 공용 창은 자리에서 커지고 닫힌다(lib/motion)', () => {
    const peek = read('src/planner/components/DayPreview.tsx');
    expect(peek).toContain('growFrom(box.current, cellRect(day.date))');
    expect(peek).toContain('r.top >= window.innerHeight'); // 화면 밖으로 밀려난 칸으로는 닫히지 않는다
    expect(peek).toContain('leave(box.current, scrim.current, cellRect(day.date)');
    expect(peek).toMatch(/key=\{day\.date\} className="hm-pk-g tb-swap"/);
    const modal = read('src/components/Modal.tsx');
    expect(modal).toContain('growFrom(panel.current, null)');
    expect(modal).toContain('leave(panel.current, scrim.current, null, onClose)');
  });

  it('탭의 본문 · 메뉴 · 서랍 · 다른 창', () => {
    expect(read('src/App.tsx')).toMatch(/key=\{active\.id\} className="tb-page h-full"/);
    expect(read('src/components/ToolbarButton.tsx')).toContain('className="tb-menu fixed');
    expect(read('src/components/HelpDrawer.tsx')).toContain("'tb-drawer absolute");
    for (const f of ['src/components/AiReviewDialog.tsx', 'src/components/OnboardingModal.tsx']) {
      expect([f, read(f).includes('tb-scrim') && read(f).includes('tb-pop')]).toEqual([f, true]);
    }
  });
});
