import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const SERVICE_WORKER = 'sw.js';

// Writes the offline service worker after the build, listing every output
// file so they are all cached on the first visit.
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'zoomfract-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(outDir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        .filter((file) => file !== SERVICE_WORKER && file !== 'index.html')
        .sort();
      const hash = createHash('sha256');
      files.concat('index.html').forEach((file) => hash.update(file).update(readFileSync(join(outDir, file))));
      const header = `const FILES = ${JSON.stringify(['./', ...files])};\n`
        + `const CACHE = 'zoomfract-${hash.digest('hex').slice(0, 12)}';\n\n`;
      writeFileSync(join(outDir, SERVICE_WORKER), header + readFileSync('src/service-worker.js', 'utf8'));
    },
  };
}

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
  plugins: [serviceWorker()],
});