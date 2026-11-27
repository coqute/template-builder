export interface DocTypeOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
}

interface Props {
  options: readonly DocTypeOption[];
  docType: string;
  onChange: (next: string) => void;
}

/**
 * 화면 전환 스위치(문서 종류) — 옵션은 doctypes 레지스트리에서 주입. 홈은 여기에 없다: 로고가 홈 단추라 홈에서는 아무 칸도 켜지지 않는다.
 *
 * 모양(v0.28.0, 사용자가 시안에서 고른 것):
 * - 상자는 옆의 툴바 단추와 같은 높이(30px)다. 글자 12px, 아이콘 14px(단추와 같게), 누르는 자리 24px.
 * - **켜진 탭은 가라앉은 바탕 위의 흰 칸이다 — 채우지 않는다.** 채움(잉크색)은 결과를 내는 단추(주 동작)에만 쓴다:
 *   "어디에 있는가"와 "무엇을 누르는가"가 같은 색 덩어리로 보이지 않게.
 * - 탭 묶음을 두른 테두리 상자는 둔다(v0.27.3에서 없앴다가 되돌림 — 없애는 것은 로고와 탭 사이의 구분선뿐).
 */
export function DocTypeSwitch({ options, docType, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="화면"
      className="flex h-[30px] shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sharp border border-rule bg-bg-sunken p-0.5"
    >
      {options.map((opt) => {
        const active = docType === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
            className={[
              'flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sharp border px-2.5 text-xs leading-none transition',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg',
              active ? 'border-rule-strong bg-bg font-bold text-fg' : 'border-transparent font-medium text-fg-soft hover:text-fg',
            ].join(' ')}
          >
            {/* 아이콘은 모듈이 준 크기와 상관없이 14px — 옆의 툴바 단추와 같게 */}
            {opt.icon && (
              <span aria-hidden="true" className="flex shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">
                {opt.icon}
              </span>
            )}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
