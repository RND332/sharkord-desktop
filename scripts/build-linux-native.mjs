import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

if (process.platform !== 'linux') {
  throw new Error('The Linux portal metadata helper must be built on Linux for the current host architecture.');
}
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error(`Unsupported Linux portal helper architecture: ${process.arch}`);
}

const cflags = execFileSync('pkg-config', ['--cflags', 'libsystemd'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const libraries = execFileSync('pkg-config', ['--libs', 'libsystemd'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const output = `native/out/portal-metadata-linux-${process.arch}`;
await mkdir('native/out', { recursive: true });
execFileSync('cc', [
  '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  ...cflags,
  'native/linux/portal-metadata.c',
  '-o', output,
  ...libraries
], { stdio: 'inherit' });
console.log(`Built ${output} against libsystemd; no runtime compiler or download is used.`);
