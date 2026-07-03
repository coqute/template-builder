import type { Theme } from '../hooks/useTheme';

interface Props {
  theme: Theme;
  size?: number;
}

/**
 * K Monogram — 작성자 이니셜 wordmark + accent dot
 *  - 배경 없음, 글자만 anchor
 *  - White: ink K + red dot (휴무 색과 일관)
 *  - Mono : amber K + amber dot
 */
export function StampLogo({ theme, size = 28 }: Props) {
  const isMono = theme === 'mono';
  const letter = isMono ? 'var(--accent)' : 'var(--fg)';
  const dot = isMono ? 'var(--accent)' : 'var(--stamp-red)';

  return (
    <span
      role="img"
      aria-label="ExampleIT Template Builder"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <text
          x={2}
          y={25.5}
          textAnchor="start"
          fontFamily="'Pretendard Variable', Pretendard, -apple-system, system-ui, sans-serif"
          fontWeight={900}
          fontSize={28}
          fill={letter}
          style={{ letterSpacing: '-0.06em' }}
        >
          K
        </text>
        <circle cx={26} cy={24} r={2.6} fill={dot} />
      </svg>
    </span>
  );
}
