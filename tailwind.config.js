/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
      colors: {
        dem: { DEFAULT: '#2563eb', light: '#93c5fd' },
        rep: { DEFAULT: '#dc2626', light: '#fca5a5' },
        ind: { DEFAULT: '#7c3aed' },
      },
    },
  },
  plugins: [],
};
