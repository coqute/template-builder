/**
 * 탭마다 쓰는 메뉴가 다르다 — 지금 화면이 처리하는 채널만 켜고 나머지 항목은 끈다.
 * 전에는 모든 탭에서 모든 항목이 켜져 있어, 홈·작업일지에서 [샘플 보기]·[HTML 복사]·[임시보관함]·[Gmail 본문 가져오기]를
 * 눌러도 아무 일이 없었다(v0.26.0 점검). 화면이 무엇을 처리하는지는 renderer가 안다 — 탭 이름은 여기서 알 필요가 없다.
 * Electron을 import하지 않는다(테스트에서 가짜 메뉴로 돌린다).
 */

/** 탭에 따라 켜고 끄는 항목 — id는 renderer로 보내는 채널 이름과 같다. `menu:help`(설정 · 도움말)는 늘 켜 둔다 */
export const TAB_MENU_IDS = ['menu:new', 'menu:open', 'menu:save', 'menu:load-sample', 'menu:copy-html', 'menu:draft', 'menu:import-gmail'] as const;

interface MenuLike {
  getMenuItemById(id: string): { enabled: boolean } | null;
}

/** renderer가 보낸 채널 목록대로 항목을 켜고 끈다. 모르는 값은 버린다. 켠 항목 id를 돌려준다 */
export function applyMenuChannels(menu: MenuLike | null, channels: unknown): string[] {
  const on = new Set(Array.isArray(channels) ? channels.filter((x): x is string => typeof x === 'string') : []);
  const enabled: string[] = [];
  for (const id of TAB_MENU_IDS) {
    const item = menu?.getMenuItemById(id);
    if (!item) continue;
    item.enabled = on.has(id);
    if (item.enabled) enabled.push(id);
  }
  return enabled;
}
