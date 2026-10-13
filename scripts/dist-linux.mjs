import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
  throw new Error('dist:linux packages only the current supported Linux host architecture.');
}
execFileSync('electron-builder', ['--linux', `--${process.arch}`, '--publish', 'never'], { stdio: 'inherit' });
