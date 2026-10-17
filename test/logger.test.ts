import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'sharkord-logger-test-'));
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state.directory, { recursive: true, force: true });
});
const files = (): string[] => readdirSync(state.directory, { recursive: true })
  .filter((name): name is string => typeof name === 'string' && name.endsWith('.log'))
  .map((name) => join(state.directory, name));
const output = (): string => files().map((path) => readFileSync(path, 'utf8')).join('\n');

it('preserves exception stack and cause in the file, not just the console', async () => {
  const { log } = await import('../src/main/logger');
  const error = new Error('GPU launch failed', { cause: new Error('helper missing') });
  log('failure', error);
  expect(output()).toContain('GPU launch failed');
  expect(output()).toContain('helper missing');
  expect(output()).toContain('logger.test.ts');
});

it('keeps subsequent diagnostics usable after cyclic data and bigint', async () => {
  const { log } = await import('../src/main/logger');
  const details: Record<string, unknown> = { bytes: 12n };
  details.self = details;
  log(details);
  log('still recording');
  expect(output()).toContain('12');
  expect(output()).toContain('still recording');
});

it('bounds file growth during a single long session while retaining recent errors', async () => {
  const { log } = await import('../src/main/logger');
  for (let i = 0; i < 1500; i += 1) log('é'.repeat(4096));
  log('latest failure');
  expect(output()).toContain('latest failure');
  expect(output()).not.toContain('\uFFFD');
  expect(files().reduce((sum, path) => sum + statSync(path).size, 0)).toBeLessThan(8 * 1024 * 1024);
});
