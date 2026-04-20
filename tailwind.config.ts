import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          900: '#0f172a',
          800: '#1a1a2e',
          700: '#1e293b',
        },
        brand: {
          green: '#4CAF50',
          blue: '#2196F3',
          lightGreen: '#e8f5e9',
          lightBlue: '#e3f2fd',
        },
      },
      fontFamily: {
        sans: ['var(--font-noto)', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
