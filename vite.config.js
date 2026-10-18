import { defineConfig } from 'vite';

// Dev playground + production build both target examples/playground.
// The demo imports the engine from ../../src, so `vite build` type-checks
// every engine module by compiling it.
export default defineConfig({
  root: 'examples/playground',
  server: { port: 5173 },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // Top-level await is used in the demo (and valid in modern browsers).
    target: 'es2022',
  },
});
