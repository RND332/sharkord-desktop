import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ version: '0.0.0-test', packaged: false }));

/** the SDK reads runtime versions that only exist inside a real Electron */
beforeAll(() => {
  Object.defineProperty(process.versions, 'electron', {
    value: '44.3.0',
    configurable: true
  });
});

/** The exact main-process surface @sentry/electron/main imports; emitters are real ones. */
vi.mock('electron', async () => {
  const app = Object.assign(new EventEmitter(), {
    getVersion: () => state.version,
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
    getName: () => 'Sharkord',
    getLocale: () => 'en-US',
    whenReady: async () => undefined,
    setPath: () => {},
    commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
    disableHardwareAcceleration: () => {}
  });

  // the SDK reads this as a property, and it has to follow the test state
  Object.defineProperty(app, 'isPackaged', { get: () => state.packaged });

  return {
    app,
    BrowserWindow: class {},
    autoUpdater: Object.assign(new EventEmitter(), { autoDownload: true }),
    contextBridge: { exposeInMainWorld: () => {} },
    crashReporter: { start: () => {}, getUploadedReports: () => [] },
    dialog: { showErrorBox: () => {} },
    ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
    ipcRenderer: { send: () => {}, invoke: async () => undefined },
    net: { isOnline: () => true, request: () => ({ on: () => {}, end: () => {} }) },
    powerMonitor: new EventEmitter(),
    protocol: { registerFileProtocol: () => {}, handle: () => {} },
    screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [] }),
    session: {
      default: { webRequest: { onBeforeSendHeaders: () => {} }, protocol: {} },
      fromPartition: () => ({
        webRequest: { onBeforeSendHeaders: () => {} },
        protocol: {}
      })
    },
    utilityProcess: Object.assign(new EventEmitter(), {
      fork: () => ({ on: () => {}, kill: () => {}, postMessage: () => {} })
    }),
    webContents: { getAllWebContents: () => [] }
  };
});

const Sentry = await import('@sentry/electron/main');
const { captureError, initSentry } = await import('../src/main/sentry');

afterEach(async () => {
  await Sentry.close(0);
});

it('stays out of the way when no dsn is configured', () => {
  initSentry(null);

  expect(Sentry.getClient()).toBeUndefined();
  expect(() => captureError(new Error('boom'))).not.toThrow();
});

it('reports main process crashes once a dsn is configured', () => {
  state.version = '1.2.3';
  state.packaged = true;
  initSentry('https://public@errors.example.com/3');

  const client = Sentry.getClient();

  expect(client).toBeDefined();
  expect(client?.getOptions().dsn).toBe('https://public@errors.example.com/3');
  expect(client?.getOptions().release).toBe('1.2.3');
  expect(client?.getOptions().environment).toBe('production');
  expect(() =>
    captureError(new Error('boom'), { area: 'child-process' })
  ).not.toThrow();
});

it('keeps capture paths and captured media details out of events', () => {
  state.packaged = false;
  initSentry('https://public@errors.example.com/3');

  const beforeSend = Sentry.getClient()?.getOptions().beforeSend;

  expect(Sentry.getClient()?.getOptions().environment).toBe('development');
  expect(typeof beforeSend).toBe('function');

  const scrubbed = (
    beforeSend as unknown as (event: unknown, hint: unknown) => unknown
  )(
    {
      event_id: 'kept',
      request: { url: 'file:///home/user/secret.png' },
      contexts: { response: { body: 'screen name' } },
      extra: { path: '/home/user' },
      tags: { area: 'child-process' }
    },
    {}
  ) as Record<string, unknown>;

  expect(scrubbed.event_id).toBe('kept');
  expect(scrubbed.tags).toEqual({ area: 'child-process' });
  expect(scrubbed.request).toBeUndefined();
  expect(scrubbed.contexts).toBeUndefined();
  expect(scrubbed.extra).toBeUndefined();
});
