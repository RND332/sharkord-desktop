import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { release as osRelease } from 'node:os';
import { inspect } from 'node:util';
import { app } from 'electron';

/**
 * Chromium flags needed for platform capture. Called before `app.ready` so the GPU process and
 * every renderer inherit them. Keep Chromium's normal frame pacing: globally disabling it makes
 * animated client pages render thousands of frames per second and starve interaction handling.
 */
export const performanceFlags = (runtimePlatform: NodeJS.Platform): Array<[string, string?]> =>
  runtimePlatform === 'win32' ? [['enable-features', 'UseWindowsGraphicsCapture']] : [];

const applyPerformanceFlags = (): void => {
  for (const [name, value] of performanceFlags(platform())) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
};

const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;
const NATIVE_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_COUNT = 5;
let directory: string | null = null;
let initialized = false;
let writtenBytes = 0;

/** Independent of --user-data-dir: deleting a temporary profile must not delete the evidence. */
export const getLogsDirectory = (): string => join(app.getPath('appData'), 'sharkord-desktop', 'logs');

const sessionDirectory = (): string => {
  if (directory) return directory;
  const root = getLogsDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const next = join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  mkdirSync(next, { recursive: true, mode: 0o700 });
  directory = next;
  return next;
};
const logPath = (): string => join(sessionDirectory(), 'main.log');
const nativeLogPath = (): string => join(sessionDirectory(), 'chromium.log');

/** Read only the bounded tail; discard a partial first line rather than split UTF-8. */
const tail = (path: string, bytes: number): Buffer => {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const offset = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    const content = buffer.subarray(0, count);
    if (offset === 0) return content;
    const newline = content.indexOf(10);
    return newline === -1 ? Buffer.alloc(0) : content.subarray(newline + 1);
  } finally {
    closeSync(fd);
  }
};

/** Keep the inode: Chromium subprocesses may already hold it open for append. */
const trim = (path: string, maxBytes: number, keepBytes: number): void => {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  const content = tail(path, keepBytes);
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, content, 0, content.length, 0);
    ftruncateSync(fd, content.length);
  } finally {
    closeSync(fd);
  }
};

const pruneSessions = (): void => {
  const root = getLogsDirectory();
  const sessions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+$/.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  for (const name of sessions.slice(SESSION_COUNT)) {
    const pid = Number(name.slice(name.lastIndexOf('-') + 1));
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM is also a live process. Never prune a session still being written.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(join(root, name), { recursive: true });
    }
  }
};

/** Preserve Error stacks/causes and tolerate circular objects, bigint and failed writes. */
export const log = (...parts: unknown[]): void => {
  try {
    const message = parts.map((part) => typeof part === 'string' ? part : inspect(part, {
      depth: 5, getters: false, customInspect: false, maxArrayLength: 50, maxStringLength: 8192, colors: false
    })).join(' ');
    const line = `[${new Date().toISOString()} pid=${process.pid}] ${message.slice(0, 32768)}\n`;
    try { console.log('[sharkord-desktop]', line.trimEnd()); } catch { /* Closed stdout must not lose the file log. */ }
    appendFileSync(logPath(), line, { mode: 0o600 });
    writtenBytes += Buffer.byteLength(line);
    if (writtenBytes > MAX_BYTES) {
      trim(logPath(), MAX_BYTES, KEEP_BYTES);
      writtenBytes = statSync(logPath()).size;
    }
  } catch {
    // Logging must never turn a recoverable failure into a crash.
  }
};

/** Call before app.ready so Chromium subprocesses inherit native file logging. */
export const initializeLogging = (): void => {
  if (initialized) return;
  initialized = true;
  process.on('uncaughtExceptionMonitor', (error, origin) => log('uncaught exception:', origin, error));
  applyPerformanceFlags();
  try {
    const native = nativeLogPath();
    appendFileSync(native, '', { mode: 0o600 });
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', native);
    app.commandLine.appendSwitch('log-level', '1');
    log('session started', describeEnvironment(), {
      executable: process.execPath,
      executableExists: existsSync(process.execPath),
      resources: process.resourcesPath,
      resourcesExist: existsSync(process.resourcesPath),
      profile: app.getPath('userData')
    });
    try { pruneSessions(); } catch (error) { log('could not prune old logs:', error); }
    // Native writers run outside JS. This is a periodic bound, not an instantaneous disk quota.
    const timer = setInterval(() => {
      try { trim(native, NATIVE_MAX_BYTES, NATIVE_MAX_BYTES / 2); } catch { /* Best effort, including during shutdown. */ }
    }, 10_000);
    timer.unref();
  } catch (error) {
    log('could not initialize native logging:', error);
  }
};

export const describeEnvironment = (): string => [
  `version:   ${app.getVersion()}`,
  `platform:  ${process.platform} ${process.arch}`,
  `electron:  ${process.versions.electron} (chromium ${process.versions.chrome})`,
  `packaged:  ${app.isPackaged}`,
  `session:   ${process.env.XDG_SESSION_TYPE ?? 'n/a'}`,
  `os:        ${osRelease()}`,
  `log:       ${logPath()}`,
  `chromium:  ${nativeLogPath()}`
].join('\n');

export const readLogTail = (maxLines = 300): string => {
  if (maxLines <= 0) return '';
  const read = (path: string): string => {
    try { return tail(path, KEEP_BYTES).toString('utf8').split('\n').filter(Boolean).slice(-maxLines).join('\n'); }
    catch { return '(no log yet)'; }
  };
  try { return `Application:\n${read(logPath())}\n\nChromium (may contain private paths/URLs):\n${read(nativeLogPath())}`; }
  catch { return '(logs unavailable)'; }
};
