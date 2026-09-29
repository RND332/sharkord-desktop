import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '', platform: 'win32' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  platform: () => state.platform
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => state.directory,
    getVersion: () => 'test',
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn()
  }
}));
import { app } from 'electron';

const argv = process.argv;
const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
let listeners: NodeJS.UncaughtExceptionListener[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  state.directory = mkdtempSync(join(tmpdir(), 'sharkord-rendering-test-'));
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: state.directory });
  listeners = process.listeners('uncaughtExceptionMonitor');
});

afterEach(() => {
  for (const listener of process.listeners('uncaughtExceptionMonitor')) {
    if (!listeners.includes(listener)) process.removeListener('uncaughtExceptionMonitor', listener);
  }
  process.argv = argv;
  if (resources) Object.defineProperty(process, 'resourcesPath', resources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(state.directory, { recursive: true, force: true });
});

it.each([
  ['win32', ['--software-rendering'], 1],
  ['win32', [], 0],
  ['win32', ['--software-rendering=false'], 0],
  ['linux', ['--software-rendering'], 0],
  ['darwin', ['--software-rendering'], 0]
])('applies the Windows rendering opt-in at startup: %s %j', async (platform, args, calls) => {
  state.platform = platform;
  process.argv = ['electron', 'app', ...args];
  const { initializeLogging } = await import('../src/main/logger');
  initializeLogging();
  // The request must be synchronous, before Electron's ready event; repeated init is harmless.
  expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(calls);
  initializeLogging();
  expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(calls);
  if (platform === 'win32') {
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-features', 'UseWindowsGraphicsCapture');
  }
});
