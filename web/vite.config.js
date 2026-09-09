import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.ASDD_API || 'http://localhost:5174';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Same-origin API in dev, so no CORS juggling and SSE works untouched.
      '/api': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
