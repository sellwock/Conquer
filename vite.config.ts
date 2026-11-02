/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode single` inlines everything (JS, CSS, worker) into one index.html for embedding/previews.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [preact(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  worker: { format: 'es' },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  server: {
    // Same-origin proxy for local dev in case ESPN ever drops CORS headers.
    proxy: {
      '/espn-site': { target: 'https://site.api.espn.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/espn-site/, '') },
      '/espn-web': { target: 'https://site.web.api.espn.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/espn-web/, '') },
      '/espn-core': { target: 'https://sports.core.api.espn.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/espn-core/, '') },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
