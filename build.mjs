import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node22'
};

await rm('dist', { recursive: true, force: true });

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  }),
  build({
    ...shared,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  }),
  build({
    ...shared,
    entryPoints: ['src/patch/entry.ts'],
    outfile: 'dist/patch.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120'
  })
]);
