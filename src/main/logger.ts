import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { release as osRelease } from 'node:os';
import { inspect } from 'node:util';
import { app, type WebContents } from 'electron';

/**
 * Chromium flags needed for platform capture. Called before `app.ready` so the GPU process and
 * every renderer inherit them. Keep Chromium's normal frame pacing: globally disabling it makes
 * animated client pages render thousands of frames per second and starve interaction handling.
 */
export const performanceFlags = (runtimePlatform: NodeJS.Platform): Array<[string, string?]> =>
  runtimePlatform === 'win32' ? [['enable-features', 'UseWindowsGraphicsCapture']] : [];

const applyPerformanceFlags = (): void => {
  // Opt-in GPU/driver workaround for an invisible local cursor during Windows sharing.
  // This does not replace WGC or change the cursor embedded in the shared video.
  if (platform() === 'win32' && process.argv.includes('--software-rendering')) {
    app.disableHardwareAcceleration();
    log('software rendering requested: hardware acceleration disabled');
  }
  for (const [name, value] of performanceFlags(platform())) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
};

const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;
const NATIVE_MAX_BYTES = 2 * 1024 * 1024;
const CLIENT_MAX_BYTES = 2 * 1024 * 1024;
const CLIENT_KEEP_BYTES = 1 * 1024 * 1024;
const SESSION_COUNT = 5;
let directory: string | null = null;
let initialized = false;

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
const clientLogPath = (): string => join(sessionDirectory(), 'renderer.log');

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

/** One line, one append, bounded by actual size so a second writer cannot slip past the cap. */
const appendBounded = (path: string, line: string, maxBytes: number, keepBytes: number): void => {
  appendFileSync(path, line, { mode: 0o600 });
  if (statSync(path).size > maxBytes) trim(path, maxBytes, keepBytes);
};

const stamp = (): string => `[${new Date().toISOString()} pid=${process.pid}] `;

/** Preserve Error stacks/causes and tolerate circular objects, bigint and failed writes. */
export const log = (...parts: unknown[]): void => {
  try {
    const message = parts.map((part) => typeof part === 'string' ? part : inspect(part, {
      depth: 5, getters: false, customInspect: false, maxArrayLength: 50, maxStringLength: 8192, colors: false
    })).join(' ');
    const line = `${stamp()}${message.slice(0, 32768)}\n`;
    try { console.log('[sharkord-desktop]', line.trimEnd()); } catch { /* Closed stdout must not lose the file log. */ }
    appendBounded(logPath(), line, MAX_BYTES, KEEP_BYTES);
  } catch {
    // Logging must never turn a recoverable failure into a crash.
  }
};

/**
 * The client's own console output only lives in its window, so a voice or demo failure disappears
 * with the renderer. Keep it in its own file: client chatter must not push crash evidence out of
 * `main.log`. Errors and warnings survive a normal run; the rest needs `--verbose-logs`.
 */
export const attachRendererConsoleLogging = (contents: WebContents, verbose = false): void => {
  contents.on('console-message', (details) => {
    if (!verbose && details.level !== 'error' && details.level !== 'warning') return;
    try {
      const line = `${stamp()}${details.level} ${details.message.slice(0, 8192)} (${details.sourceId}:${details.lineNumber})\n`;
      appendBounded(clientLogPath(), line, CLIENT_MAX_BYTES, CLIENT_KEEP_BYTES);
    } catch {
      // A failed client log must not take the window down with it.
    }
  });
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
  `client:    ${clientLogPath()}`,
  `chromium:  ${nativeLogPath()}`
].join('\n');

export const readLogTail = (maxLines = 300): string => {
  if (maxLines <= 0) return '';
  const read = (path: string, bytes = KEEP_BYTES): string => {
    try { return tail(path, bytes).toString('utf8').split('\n').filter(Boolean).slice(-maxLines).join('\n'); }
    catch { return '(no log yet)'; }
  };
  try {
    return [
      `Application:\n${read(logPath())}`,
      `Client console:\n${read(clientLogPath(), CLIENT_KEEP_BYTES)}`,
      `Chromium (may contain private paths/URLs):\n${read(nativeLogPath())}`
    ].join('\n\n');
  } catch { return '(logs unavailable)'; }
};
