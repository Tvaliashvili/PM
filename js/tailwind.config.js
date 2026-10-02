// Tailwind CDN theme config - must load right after the Tailwind CDN script.
// Light theme. The class names in the pages come from the dark one, so the
// colours behind them are remapped here rather than renamed everywhere:
// ink-* run from the page (950) to borders (700), "white" text is the dark
// heading colour, and the pale text shades meant for a dark page are darkened.
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'Noto Sans Georgian', 'system-ui', 'sans-serif'] },
      colors: {
        white: '#0f172a',
        ink:   { 950: '#fafafa', 900: '#ffffff', 850: '#f8fafc', 800: '#f1f5f9', 700: '#e2e8f0' },
        brand: { 400: '#2563eb', 500: '#2563eb', 600: '#1d4ed8' },
        slate: { 200: '#1e293b', 300: '#334155', 400: '#65758b' },
        amber: { 300: '#b45309', 400: '#d97706' },
        rose: { 300: '#dc2626', 400: '#dc2626' },
        emerald: { 300: '#15803d', 400: '#16a34a' },
        sky: { 300: '#0369a1' },
      },
    },
  },
};
