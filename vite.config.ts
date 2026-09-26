import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  base: './',
  build: {
    // The CodeMirror editor makes the single app bundle about 540 kB.
    chunkSizeWarningLimit: 800,
  },
  worker: {
    format: 'es',
  },
});
