import type { Config } from 'tailwindcss';

/**
 * Ryuma design tokens (design-reference/HANDOFF.md §Design Tokens) as Tailwind
 * theme extensions. Dark mode is the default — there is no light theme yet.
 * Status / rank palettes live in src/lib/theme.ts as className maps (they need
 * paired text/bg/border colors keyed by a runtime value).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#b91c1c',
          bright: '#dc2626',
          soft: '#f0a8a8',
        },
        base: '#0a0809',
        sidebar: '#0a0708',
        surface: {
          DEFAULT: '#0d0a0b',
          2: '#120e0d',
          3: '#15100f',
          4: '#1a1413',
        },
        ink: {
          DEFAULT: '#f5f1f0',
          muted: '#9a9290',
          muted2: '#b9b1af',
          faint: '#6f6764',
        },
      },
      borderColor: {
        subtle: 'rgba(255,255,255,.07)',
        hair: 'rgba(255,255,255,.06)',
        accent: 'rgba(185,28,28,.5)',
        'accent-soft': 'rgba(185,28,28,.18)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'var(--font-thai)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      borderRadius: {
        card: '14px',
        btn: '13px',
      },
      boxShadow: {
        cta: '0 8px 22px -8px rgba(185,28,28,.7)',
        frame: '0 40px 90px -30px rgba(0,0,0,.9), 0 0 0 1px rgba(185,28,28,.1)',
      },
      backgroundImage: {
        cta: 'linear-gradient(180deg, #dc2626, #b91c1c)',
        success: 'linear-gradient(180deg, #16a34a, #15803d)',
        stripe: 'repeating-linear-gradient(135deg, #1b1413 0 10px, #150f0e 10px 20px)',
      },
      keyframes: {
        pulseRed: {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(220,38,38,.45)' },
          '50%': { boxShadow: '0 0 0 8px rgba(220,38,38,0)' },
        },
        // coupon "อลังการ" effects
        couponShine: {
          '0%': { transform: 'translateX(-140%) skewX(-18deg)' },
          '100%': { transform: 'translateX(260%) skewX(-18deg)' },
        },
        twinkle: {
          '0%,100%': { opacity: '0', transform: 'scale(.4)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
        couponPop: {
          '0%': { opacity: '0', transform: 'scale(.7) translateY(14px)' },
          '60%': { opacity: '1', transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        floatY: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        // แบนเนอร์ Event: ไฟกระพริบ = gradient วิ่งรอบกรอบ + เต้นสว่าง
        pulseGlow: {
          '0%,100%': { backgroundPosition: '0% 50%', opacity: '.9', filter: 'blur(3px)' },
          '50%': { backgroundPosition: '100% 50%', opacity: '.5', filter: 'blur(6px)' },
        },
      },
      animation: {
        pulseGlow: 'pulseGlow 1.8s ease-in-out infinite',
        pulseRed: 'pulseRed 2.2s infinite',
        couponShine: 'couponShine 2.6s ease-in-out infinite',
        twinkle: 'twinkle 1.9s ease-in-out infinite',
        couponPop: 'couponPop .55s cubic-bezier(.2,.9,.3,1.25)',
        floatY: 'floatY 3.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
