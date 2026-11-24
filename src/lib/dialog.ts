/**
 * 가운데에 뜨는 창의 키보드 초점 — 창이 떠 있는 동안 Tab이 창 밖(가려진 화면)으로 나가지 않게 돌리고,
 * 닫히면 열기 전에 있던 자리(누른 단추·날 칸)로 초점을 돌려준다.
 * 마우스로만 쓰면 차이가 없지만, 키보드로 날을 넘겨 보다가 닫았을 때 자리를 잃지 않는다.
 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 창 안에서 Tab·Shift+Tab이 돌게 한다 — keydown에서 부른다 */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = !root.contains(active);
  if (e.shiftKey && (active === first || active === root || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || outside)) {
    e.preventDefault();
    first.focus();
  }
}

/** 지금 초점이 있는 곳을 기억해 두고, 돌려주는 함수를 준다 — 창이 열릴 때 부르고 닫힐 때(떼어질 때) 돌려준다 */
export function rememberFocus(): () => void {
  const prev = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  return () => {
    if (prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  };
}
