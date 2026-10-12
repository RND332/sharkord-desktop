import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  windows: [] as any[],
  display: null as null | ((request: any, callback: any) => Promise<void>),
  start: vi.fn(), stop: vi.fn(), resolveTarget: vi.fn(),
  getSources: vi.fn(async () => [{ id: 'screen:1:0', name: 'Screen 1' }])
}));
vi.mock('../src/main/logger', () => ({ initializeLogging() {}, log() {}, describeEnvironment() {}, readLogTail() {} }));
vi.mock('../src/main/config', () => ({ loadConfig: () => ({ mode: 'capture' }) }));
vi.mock('../src/main/updater', () => ({ setupAutoUpdates() {}, installPendingUpdateSilently() {}, checkForUpdatesNow() {} }));
vi.mock('../src/main/server-config', () => ({ readServerUrl: () => 'https://test.invalid', normalizeServerUrl: (s: string) => s, isServerOrigin: () => true, saveServerUrl() {} }));
vi.mock('../src/main/tap', () => ({ TapCapture: class { start = world.start; stop = world.stop; onData() {} } }));
vi.mock('../src/main/linux-audio', () => ({ resolveLinuxAudioTarget: world.resolveTarget }));
vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getGPUInfo: async () => ({}), getGPUFeatureStatus: () => ({}), configureHostResolver() {},
    getPath: () => '/home/rnd332/.hermes/cache/scratch', exit() {}, quit() {}
  }),
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, setWindowOpenHandler() {}, isCrashed: () => false,
      executeJavaScript: async () => ({ bridge: 'object', patched: true, capture: 'pipewire' }), send() {}
    });
    constructor() { super(); world.windows.push(this); }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
  },
  Tray: class { constructor() { throw new Error('no tray'); } },
  nativeImage: { createFromPath() {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (x: any) => x },
  Notification: { isSupported: () => false },
  session: { defaultSession: {
    setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    setDisplayMediaRequestHandler: (handler: any) => { world.display = handler; }
  } },
  ipcMain: { on() {}, handle: (channel: string, handler: any) => world.handlers.set(channel, handler) },
  desktopCapturer: { getSources: world.getSources },
  dialog: { showMessageBox: async () => ({ response: 0 }) }, clipboard: {}, shell: {}
}));

const event = () => ({ sender: world.windows[0].webContents, senderFrame: world.windows[0].webContents.mainFrame });
const request = () => ({ frame: event().senderFrame, securityOrigin: 'https://test.invalid', audioRequested: true });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeAll(async () => {
  vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
  await import('../src/main/index');
  await flush();
});
describe('Linux main capture boundary', () => {
  beforeEach(() => {
    event().sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    world.start.mockClear();
    world.resolveTarget.mockReset();
  });
  it('does not let a foreign frame discard the client audio selection', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845 });
    await world.display!(request(), vi.fn());
    await world.handlers.get('capture:mode')!({ sender: {}, senderFrame: {} }, { mode: 'system-audio-unavailable' });
    const id = await world.handlers.get('capture:acquire')!(event());
    expect(world.start).toHaveBeenCalledWith({ kind: 'application', processId: 10845 });
    await world.handlers.get('capture:release')!(event(), id);
  });
  it('clears an unacquired selection when the renderer reports video-only capture', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845 });
    await world.display!(request(), vi.fn());
    await world.handlers.get('capture:mode')!(event(), { mode: 'system-audio-unavailable' });
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
  });
  it('refuses overlapping source selection without overwriting the original target', async () => {
    const late = Promise.withResolvers<{ kind: 'application'; processId: number }>();
    world.resolveTarget.mockReturnValueOnce(late.promise);
    const firstCallback = vi.fn();
    const first = world.display!(request(), firstCallback);
    await flush();
    const otherCallback = vi.fn();
    await world.display!(request(), otherCallback);
    expect(otherCallback).toHaveBeenCalledWith(null);
    late.resolve({ kind: 'application', processId: 10845 });
    await first;
    const id = await world.handlers.get('capture:acquire')!(event());
    const activeCallback = vi.fn();
    await world.display!(request(), activeCallback);
    expect(activeCallback).toHaveBeenCalledWith(null);
    await world.handlers.get('capture:release')!(event(), id + 1);
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('active');
    await world.handlers.get('capture:release')!(event(), id);
    world.start.mockClear();
  });
  it('discards a source resolver that finishes after navigation', async () => {
    const late = Promise.withResolvers<{ kind: 'application'; processId: number }>();
    world.resolveTarget.mockReturnValueOnce(late.promise);
    const callback = vi.fn();
    const pending = world.display!(request(), callback);
    await flush();
    event().sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    late.resolve({ kind: 'application', processId: 999 });
    await pending;
    expect(callback).toHaveBeenCalledWith(null);
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
  });
  it('passes the selected application to the recorder and consumes the selection once', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845 });
    const callback = vi.fn();
    await world.display!(request(), callback);
    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:1:0', name: 'Screen 1' } });
    const id = await world.handlers.get('capture:acquire')!(event());
    expect(world.start).toHaveBeenCalledWith({ kind: 'application', processId: 10845 });
    await world.handlers.get('capture:release')!(event(), id);
    world.start.mockClear();
  });
  it('refuses capture without a selected audio target instead of silently capturing every app', async () => {
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
    expect(world.start).not.toHaveBeenCalled();
  });
});
