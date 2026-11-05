/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.WPCG_API ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    // The browser only talks to /api on its own origin; Vite forwards it to the API server.
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  preview: { port: 4174, proxy: { '/api': { target: API_TARGET } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 800 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
