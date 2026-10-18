// Builds every example gallery page to dist/examples/<name> to prove each
// demo compiles against the engine. Run: node scripts/build-examples.mjs
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examples = ['playground', 'weather-showcase', 'netcode-demo', 'village', 'quest-playground'];

for (const name of examples) {
  console.log(`building example: ${name}`);
  await build({
    root: path.join(repo, 'examples', name),
    logLevel: 'warn',
    build: {
      outDir: path.join(repo, 'dist', 'examples', name),
      emptyOutDir: true,
      target: 'es2022',
    },
  });
}
console.log('all examples built OK');
