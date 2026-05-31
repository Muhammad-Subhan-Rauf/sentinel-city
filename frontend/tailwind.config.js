/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        '3xl': '1920px',
        '4xl': '2560px',
      },
      colors: {
        sentinel: {
          bg: '#070a14',
          bgRaised: '#0a0e1a',
          panel: '#0f1629',
          card: '#141d35',
          border: '#1e2d4d',
          borderSoft: 'rgba(255,255,255,0.06)',
          accent: '#f97316',
          accentHover: '#ea6c0a',
          info: '#22d3ee',
          infoHover: '#0ea5b7',
          danger: '#ef4444',
          warn: '#f59e0b',
          safe: '#22c55e',
          muted: '#4b6082',
          text: '#e6eefb',
          textDim: '#9aaecf',
          textMuted: '#6b82a8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'glass': '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 0 0 1px rgba(255,255,255,0.04), 0 12px 32px -8px rgba(0,0,0,0.6)',
        'glass-hover': '0 1px 0 0 rgba(255,255,255,0.1) inset, 0 0 0 1px rgba(34,211,238,0.18), 0 16px 40px -8px rgba(0,0,0,0.7)',
        'glow': '0 0 24px rgba(34,211,238,0.22)',
        'glow-accent': '0 0 24px rgba(249,115,22,0.28)',
        'glow-danger': '0 0 28px rgba(239,68,68,0.4)',
        'depth-1': '0 1px 2px rgba(0,0,0,0.4)',
        'depth-2': '0 4px 12px -2px rgba(0,0,0,0.5)',
        'depth-3': '0 12px 32px -4px rgba(0,0,0,0.6)',
      },
      backdropBlur: {
        xs: '4px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 1.8s linear infinite',
        'slide-in': 'slideIn 0.3s ease-out',
        'fade-in': 'fadeIn 0.5s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateX(-100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
