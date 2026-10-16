import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.directory, getVersion: () => '0.0.0-test', isPackaged: true }
}));

type TConsoleMessage = {
  message: string;
  level: 'info' | 'warning' | 'error' | 'debug';
  lineNumber: number;
  sourceId: string;
};

const contents = (): EventEmitter => new EventEmitter();

const emit = (target: EventEmitter, level: TConsoleMessage['level'], message: string): void => {
  target.emit('console-message', {
    message,
    level,
    lineNumber: 42,
    sourceId: 'https://discord.rnd332.com/assets/client.js'
  } satisfies TConsoleMessage);
};

const clientLogPath = (): string | undefined => readdirSync(state.directory, { recursive: true })
  .filter((name): name is string => typeof name === 'string' && name.endsWith('renderer.log'))
  .map((name) => join(state.directory, name))[0];

const clientLog = (): string => {
  const path = clientLogPath();
  return path ? readFileSync(path, 'utf8') : '';
};

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'sharkord-renderer-log-test-'));
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state.directory, { recursive: true, force: true });
});

it('keeps the client voice failure on disk with its level and source', async () => {
  const { attachRendererConsoleLogging } = await import('../src/main/logger');
  const window = contents();
  attachRendererConsoleLogging(window as never);

  emit(window, 'error', 'demo: stopping presenter media failed {"error":"InvalidStateError"}');

  expect(clientLog()).toContain('demo: stopping presenter media failed');
  expect(clientLog()).toContain('InvalidStateError');
  expect(clientLog()).toContain('error');
  expect(clientLog()).toContain('client.js:42');
});

it('records warnings and errors but leaves info out until verbose logging is asked for', async () => {
  const { attachRendererConsoleLogging } = await import('../src/main/logger');
  const quiet = contents();
  attachRendererConsoleLogging(quiet as never);

  emit(quiet, 'warning', 'transport connection failed');
  emit(quiet, 'error', 'consumer closed unexpectedly');
  emit(quiet, 'info', '[VOICE] joined voice channel');

  expect(clientLog()).toContain('transport connection failed');
  expect(clientLog()).toContain('consumer closed unexpectedly');
  expect(clientLog()).not.toContain('joined voice channel');
});

it('records the full client console when verbose logging is on', async () => {
  const { attachRendererConsoleLogging } = await import('../src/main/logger');
  const window = contents();
  attachRendererConsoleLogging(window as never, true);

  emit(window, 'info', '[VOICE] started receiving demo');
  emit(window, 'debug', 'consumer stats poll');

  expect(clientLog()).toContain('started receiving demo');
  expect(clientLog()).toContain('consumer stats poll');
});

it('bounds client console growth during a long session while retaining the newest failure', async () => {
  const { attachRendererConsoleLogging } = await import('../src/main/logger');
  const window = contents();
  attachRendererConsoleLogging(window as never, true);

  for (let i = 0; i < 4000; i += 1) emit(window, 'info', `stats ${i} ${'x'.repeat(1024)}`);
  emit(window, 'error', 'demo stopped with an error');

  expect(statSync(clientLogPath()!).size).toBeLessThan(3 * 1024 * 1024);
  expect(clientLog()).toContain('demo stopped with an error');
  expect(clientLog()).not.toContain('\uFFFD');
});

it('never lets a failing client log take the window down', async () => {
  const { attachRendererConsoleLogging } = await import('../src/main/logger');
  const window = contents();
  state.directory = join(state.directory, 'blocked');
  writeFileSync(state.directory, 'not a directory');
  attachRendererConsoleLogging(window as never);

  expect(() => emit(window, 'error', 'demo stopped with an error')).not.toThrow();
});

it('ships the client console with the copied logs', async () => {
  const { attachRendererConsoleLogging, describeEnvironment, readLogTail } = await import('../src/main/logger');
  const window = contents();
  attachRendererConsoleLogging(window as never);
  emit(window, 'error', 'demo: stopping presenter media failed');

  expect(describeEnvironment()).toContain('renderer.log');
  expect(readLogTail()).toContain('demo: stopping presenter media failed');
});
