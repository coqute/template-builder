/**
 * Mac식 움직임 — 누른 자리에서 부드럽게 커지며 열리고, 닫을 때 그 자리로 돌아간다 (설계 §19.12).
 *
 * macOS의 창 움직임(훑어보기·Dock에서 열기)에서 가져온 것:
 * 1. 나온 자리가 이어진다 — 창은 누른 것(아이콘·칸)의 자리와 크기에서 시작해 제자리로 커진다. 닫을 때는 같은 길로 돌아간다.
 * 2. 스프링으로 움직인다 — 처음에 빠르고 끝에서 길게 풀린다. 뚝 멈추지 않고, 창은 튕기지 않는다(임계 감쇠).
 * 3. 크기·자리·또렷함이 함께 움직이되 또렷함이 먼저 끝난다 — 작을 때부터 내용이 보인다.
 * 4. 닫힘은 열림보다 짧다(약 60%) — 길을 비키는 데 시간을 쓰지 않는다.
 * 5. 뒤 바탕은 창과 함께 어두워지고 함께 걷힌다.
 *
 * CSS만으로는 "누른 자리에서"와 "닫힐 때"를 할 수 없어 Web Animations API를 쓴다.
 * 움직일 수 없는 곳(테스트 환경, OS의 움직임 줄이기)에서는 아무것도 하지 않고 바로 끝난다.
 */

/** 튕기지 않는 스프링(임계 감쇠) — x(t) = 1 − (1 + ωt)·e^(−ωt), ω = 9.2. tokens.css의 --ease-spring과 같은 값이다 */
export const SPRING =
  'linear(0, 0.015 2%, 0.0532 4%, 0.1064 6%, 0.1684 8%, 0.2348 10%, 0.3192 12.5%, 0.4012 15%, 0.493 18%, 0.5753 21%, 0.6691 25%, 0.762 30%, 0.8314 35%, 0.8902 41%, 0.9346 48%, 0.9644 56%, 0.9837 66%, 0.9937 78%, 0.9976 90%, 1)';
/** 닫힐 때 — 천천히 떼서 빨라지며 제자리로 들어간다 */
const LEAVE = 'cubic-bezier(0.4, 0, 0.9, 0.6)';
/** 스프링 곡선을 모르는 엔진에서 쓰는 곡선 */
const SPRING_FALLBACK = 'cubic-bezier(0.22, 1, 0.36, 1)';

export const OPEN_MS = 480;
export const CLOSE_MS = 280;
/** 자리를 모를 때의 시작 크기 — 가운데에서 살짝 작게 */
const POP_SCALE = 0.9;
/** 누른 것이 아주 작아도 이보다 작게 시작하지는 않는다 */
const MIN_SCALE = 0.1;

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 이 요소를 움직일 수 있는가 — 화면에 그려져 있고(크기가 있고) 움직임 줄이기가 꺼져 있을 때만.
 * 테스트 환경은 요소를 그리지 않는다(크기 0) — animate가 있어도 끝났다고 알려 주지 않으므로 기다리면 안 된다.
 */
export function canAnimate(el: Element | null | undefined): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).animate !== 'function' || reducedMotion()) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** 닫히는 중인 창 */
const leaving = new WeakSet<HTMLElement>();
/** 닫은 뒤 이만큼 지나도 창이 남아 있으면 되돌린다 */
const STAY_CHECK_MS = 120;

/** 요소마다 지금 돌고 있는 열림·닫힘 — 새로 시작하기 전에 멈춘다 */
const active = new WeakMap<HTMLElement, Animation>();

/**
 * 앞서 건 움직임을 걷어 낸다 — 걸려 있는 채로 자리를 재면 변형된(작아진) 모습이 재어져 시작 모습이 틀어진다.
 * 개발 모드는 효과를 두 번 걸기 때문에(StrictMode) 이것이 없으면 두 번째가 "제자리에서 제자리로"가 되어 움직임이 보이지 않는다.
 */
function settle(el: HTMLElement): void {
  active.get(el)?.cancel();
  active.delete(el);
}

function run(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
  try {
    return el.animate(frames, options);
  } catch {
    // linear() 곡선을 모르는 엔진
    return el.animate(frames, { ...options, easing: SPRING_FALLBACK });
  }
}

/**
 * el이 `from` 자리·크기에 있을 때의 transform — 가운데를 맞추고 너비 비율로 줄인다(글자가 찌그러지지 않게 가로세로 같은 비율).
 * 움직이기 전(변형이 없는 상태)의 el을 잰다.
 */
export function transformFrom(el: HTMLElement, from: DOMRect | null | undefined): string {
  if (!from || from.width <= 0 || from.height <= 0) return `scale(${POP_SCALE})`;
  const to = el.getBoundingClientRect();
  if (to.width <= 0 || to.height <= 0) return `scale(${POP_SCALE})`;
  const scale = Math.min(1, Math.max(MIN_SCALE, from.width / to.width));
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)})`;
}

/** `from` 자리에서 제자리로 커지며 나타난다. `from`이 없으면 가운데에서 살짝 작게 시작한다 */
export function growFrom(el: HTMLElement | null, from?: DOMRect | null): Animation | null {
  if (!canAnimate(el)) return null;
  settle(el);
  const anim = run(
    el,
    [
      { transform: transformFrom(el, from), opacity: 0, transformOrigin: 'center' },
      { opacity: 1, offset: 0.3 },
      { transform: 'none', opacity: 1, transformOrigin: 'center' },
    ],
    { duration: OPEN_MS, easing: SPRING },
  );
  active.set(el, anim);
  return anim;
}

/** `to` 자리로 줄어들며 사라진다 — 끝나면(또는 움직일 수 없으면 바로) resolve. 끝 모습으로 멈춰 있으니 곧바로 떼어 낸다 */
export function shrinkTo(el: HTMLElement | null, to?: DOMRect | null): Promise<void> {
  if (!canAnimate(el)) return Promise.resolve();
  settle(el);
  const anim = run(
    el,
    [
      { transform: 'none', opacity: 1, transformOrigin: 'center' },
      { opacity: 1, offset: 0.45 },
      { transform: transformFrom(el, to), opacity: 0, transformOrigin: 'center' },
    ],
    { duration: CLOSE_MS, easing: LEAVE, fill: 'forwards' },
  );
  active.set(el, anim);
  return anim.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** 뒤 바탕 — 창과 함께 어두워진다 */
export function fadeIn(el: HTMLElement | null): Animation | null {
  if (!canAnimate(el)) return null;
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.7, easing: 'ease-out' });
}

/** 뒤 바탕 — 창과 함께 걷힌다 */
export function fadeOut(el: HTMLElement | null): Promise<void> {
  if (!canAnimate(el)) return Promise.resolve();
  return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' }).finished.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * 창을 닫는다 — 줄어드는 움직임이 끝난 뒤 `done`을 부른다. 움직일 수 없으면 바로 부른다.
 * 닫히는 동안에는 눌리지 않게 한다.
 */
export function leave(panel: HTMLElement | null, scrim: HTMLElement | null, to: DOMRect | null | undefined, done: () => void): void {
  if (!canAnimate(panel)) {
    done();
    return;
  }
  // 줄어드는 중에 또 닫으라고 하면(Esc를 두 번) 한 번만 한다
  if (leaving.has(panel)) return;
  leaving.add(panel);
  if (scrim) scrim.style.pointerEvents = 'none';
  void Promise.all([shrinkTo(panel, to), fadeOut(scrim)]).then(() => {
    done();
    // 닫으라고 했는데 창이 남아 있으면(닫기를 받아 주지 않은 경우) 사라진 모습으로 멈춰 있지 않게 되돌린다
    setTimeout(() => {
      leaving.delete(panel);
      if (!panel.isConnected) return;
      settle(panel);
      for (const a of scrim?.getAnimations?.() ?? []) a.cancel();
      if (scrim) scrim.style.pointerEvents = '';
    }, STAY_CHECK_MS);
  });
}
