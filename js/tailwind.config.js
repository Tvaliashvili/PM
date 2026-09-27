// Tailwind CDN theme config - must load right after the Tailwind CDN script.
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'Noto Sans Georgian', 'system-ui', 'sans-serif'] },
      colors: {
        ink:   { 950: '#0b0f14', 900: '#11161d', 850: '#161c25', 800: '#1c2430', 700: '#2a3441' },
        brand: { 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706' },
      },
    },
  },
};
