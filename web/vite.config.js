import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.ASDD_API || 'http://127.0.0.1:5174';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Deliberately does not open a browser: the dev server restarts often, and each restart
    // launching another window is noise. Open http://localhost:5173 once and leave it.
    open: false,
    strictPort: true,
    proxy: {
      // Same-origin API in dev, so no CORS juggling and SSE works untouched.
      '/api': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
