/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard Variable', 'Pretendard', '-apple-system', 'BlinkMacSystemFont',
          'Apple SD Gothic Neo', 'Malgun Gothic', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'D2Coding', 'Consolas', 'monospace'],
        report: ['Malgun Gothic', '맑은 고딕', 'sans-serif'],
      },
      colors: {
        bg: 'var(--bg)',
        'bg-elevated': 'var(--bg-elevated)',
        'bg-deep': 'var(--bg-deep)',
        'bg-sunken': 'var(--bg-sunken)',
        fg: 'var(--fg)',
        'fg-soft': 'var(--fg-soft)',
        'fg-muted': 'var(--fg-muted)',
        'fg-faint': 'var(--fg-faint)',
        rule: 'var(--rule)',
        'rule-thin': 'var(--rule-thin)',
        'rule-strong': 'var(--rule-strong)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-glow': 'var(--accent-glow)',
        'stamp-red': 'var(--stamp-red)',
        'stamp-green': 'var(--stamp-green)',
        'stamp-amber': 'var(--stamp-amber)',
      },
      borderRadius: {
        sharp: 'var(--radius-sharp)',
        DEFAULT: 'var(--radius)',
        card: 'var(--radius-card)',
      },
      borderWidth: {
        rule: 'var(--rule-width)',
      },
      boxShadow: {
        themed: 'var(--shadow)',
      },
      spacing: {
        '4.5': '1.125rem',
      },
    },
  },
  plugins: [],
};
