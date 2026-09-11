import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node22'
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('src/connect/connect.html', 'dist/connect.html');
await copyFile('src/picker/picker.html', 'dist/picker.html');
if (!existsSync('build/icon.png')) {
  throw new Error('build/icon.png is missing — run `bun run icon`');
}
await copyFile('build/icon.png', 'dist/icon.png');

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
