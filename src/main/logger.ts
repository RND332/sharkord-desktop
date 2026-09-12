import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Keep the log small enough to attach to a bug report. */
const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;

let file: string | null = null;

const logPath = (): string => {
  if (file) return file;
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'main.log');
  try {
    if (statSync(file).size > MAX_BYTES) {
      const content = readFileSync(file, 'utf8');
      writeFileSync(file, content.slice(-KEEP_BYTES));
    }
  } catch {
    // fresh log
  }
  return file;
};

/** Console plus a file the user can send along with a bug report. */
export const log = (...parts: unknown[]): void => {
  const line = `[${new Date().toISOString()}] ${parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part)))
    .join(' ')}`;
  console.log('[sharkord-desktop]', ...parts);
  try {
    appendFileSync(logPath(), `${line}\n`);
  } catch {
    // never let logging break the app
  }
};

export const describeEnvironment = (): string => {
  const lines = [
    `version:   ${app.getVersion()}`,
    `platform:  ${process.platform} ${process.arch}`,
    `electron:  ${process.versions.electron} (chromium ${process.versions.chrome})`,
    `packaged:  ${app.isPackaged}`,
    `session:   ${process.env.XDG_SESSION_TYPE ?? 'n/a'}`,
    `log:       ${logPath()}`
  ];
  return lines.join('\n');
};

export const readLogTail = (maxLines = 300): string => {
  try {
    const content = readFileSync(logPath(), 'utf8');
    return content.split('\n').filter(Boolean).slice(-maxLines).join('\n');
  } catch {
    return '(no log yet)';
  }
};
