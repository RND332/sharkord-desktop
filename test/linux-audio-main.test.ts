import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  windows: [] as any[],
  display: null as null | ((request: any, callback: any) => Promise<void>),
  start: vi.fn(), stop: vi.fn(), resolveTarget: vi.fn(),
  portalStart: vi.fn(async () => true),
  portalSelection: vi.fn(async (): Promise<any> => null),
  portalSelectionList: [] as any[],
  portalInvalidated: false,
  portalVerifyWindow: vi.fn(async (_target?: unknown) => true),
  portalStop: vi.fn(), bindTarget: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })), log: vi.fn(), steps: [] as string[],
  getSources: vi.fn(async () => { world.steps.push('get-sources'); return [{ id: 'screen:1:0', name: 'Screen 1' }]; })
}));
vi.mock('../src/main/logger', () => ({ initializeLogging() {}, log: world.log, describeEnvironment() {}, readLogTail() {}, attachRendererConsoleLogging() {} }));
vi.mock('../src/main/config', () => ({ loadConfig: () => ({ mode: 'capture' }) }));
vi.mock('../src/main/updater', () => ({ setupAutoUpdates() {}, installPendingUpdateSilently() {}, checkForUpdatesNow() {} }));
vi.mock('../src/main/server-config', () => ({ readServerUrl: () => 'https://test.invalid', normalizeServerUrl: (s: string) => s, isServerOrigin: () => true, saveServerUrl() {} }));
vi.mock('../src/main/tap', () => ({ TapCapture: class { start = world.start; stop = world.stop; tapNode = 'sharkord_capture'; onData() {} } }));
vi.mock('../src/main/linux-audio', () => ({
  resolveLinuxAudioTarget: world.resolveTarget,
  bindPortalCaptureTarget: world.bindTarget
}));
vi.mock('../src/main/portal-selection', () => ({
  createPortalSelectionObserver: () => {
    let active = false;
    return {
      start: async () => {
        world.steps.push('observer-ready');
        active = await world.portalStart();
        return active;
      },
      get isActive() { return active && !world.portalInvalidated; },
      get selections() { return active && !world.portalInvalidated ? world.portalSelectionList : []; },
      windowContinuity: {
        get isActive() { return active && !world.portalInvalidated; },
        resolveWindowClass: async () => null
      },
      verifyWindowTarget: async (target: unknown) => active && await world.portalVerifyWindow(target),
      selectionAfterCapture: async () => {
        const selection = await world.portalSelection();
        if (selection && active) world.portalSelectionList.push(selection);
        return active ? selection : null;
      },
      stop: () => { active = false; world.portalStop(); }
    };
  }
}));
vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getGPUInfo: async () => ({}), getGPUFeatureStatus: () => ({}), configureHostResolver() {},
    getPath: () => '/home/rnd332/.hermes/cache/scratch', exit() {}, quit() {},
    getAppPath: () => '/home/rnd332/.hermes/cache/scratch', getName: () => 'Sharkord',
    getVersion: () => '0.0.0-test', getLocale: () => 'en-US', isPackaged: true,
    setPath() {}, disableHardwareAcceleration() {},
    commandLine: { appendSwitch() {}, hasSwitch: () => false }
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
  dialog: { showMessageBox: world.showMessageBox }, clipboard: {}, shell: {}
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
    world.start.mockReset().mockReturnValue(true);
    world.stop.mockClear();
    world.resolveTarget.mockReset();
    world.portalStart.mockReset().mockResolvedValue(true);
    world.portalSelection.mockReset().mockResolvedValue(null);
    world.portalSelectionList.length = 0;
    world.portalInvalidated = false;
    world.portalVerifyWindow.mockReset().mockResolvedValue(true);
    world.portalStop.mockClear();
    world.bindTarget.mockReset().mockImplementation(async (target: unknown) => target);
    world.showMessageBox.mockClear();
    world.log.mockClear();
    world.getSources.mockClear();
    world.steps.length = 0;
  });
  it('does not let a foreign frame discard the client audio selection', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
    await world.display!(request(), vi.fn());
    await world.handlers.get('capture:mode')!({ sender: {}, senderFrame: {} }, { mode: 'system-audio-unavailable' });
    const id = await world.handlers.get('capture:acquire')!(event());
    expect(world.start).toHaveBeenCalledWith({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
    await world.handlers.get('capture:release')!(event(), id);
  });
  it('clears an unacquired selection when the renderer reports video-only capture', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
    await world.display!(request(), vi.fn());
    expect(world.portalStop).not.toHaveBeenCalled();
    await world.handlers.get('capture:mode')!(event(), { mode: 'system-audio-unavailable' });
    expect(world.portalStop).toHaveBeenCalledTimes(1);
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
  });
  it('does not cancel a separate video-only picker when pending audio falls back', async () => {
    world.resolveTarget.mockResolvedValueOnce({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
    await world.display!(request(), vi.fn());
    const late = Promise.withResolvers<Array<{ id: string; name: string }>>();
    world.getSources.mockImplementationOnce(() => late.promise);
    const callback = vi.fn();
    const pendingVideo = world.display!({ ...request(), audioRequested: false }, callback);
    await flush();
    await world.handlers.get('capture:mode')!(event(), { mode: 'system-audio-unavailable' });
    expect(world.portalStop).toHaveBeenCalledTimes(1);
    late.resolve([{ id: 'screen:2:0', name: 'Second video share' }]);
    await pendingVideo;
    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:2:0', name: 'Second video share' } });
  });
  it('refuses overlapping source selection without overwriting the original target', async () => {
    const late = Promise.withResolvers<{ kind: 'application'; processId: number; processStartTime: string }>();
    world.resolveTarget.mockReturnValueOnce(late.promise);
    const firstCallback = vi.fn();
    const first = world.display!(request(), firstCallback);
    await flush();
    const otherCallback = vi.fn();
    await world.display!(request(), otherCallback);
    expect(otherCallback).toHaveBeenCalledWith(null);
    late.resolve({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
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
    const late = Promise.withResolvers<{ kind: 'application'; processId: number; processStartTime: string }>();
    world.resolveTarget.mockReturnValueOnce(late.promise);
    const callback = vi.fn();
    const pending = world.display!(request(), callback);
    await flush();
    event().sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    late.resolve({ kind: 'application', processId: 999, processStartTime: 'start-999' });
    await pending;
    expect(callback).toHaveBeenCalledWith(null);
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
  });
  it('observes the native selection before getSources and routes app audio without a second dialog', async () => {
    const selection = {
      generation: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      sourceType: 2 as const,
      windowClass: 'google-chrome',
      windowHandle: '812',
      pipewireSerial: '9001'
    };
    const target = {
      kind: 'application' as const,
      processId: 10845,
      processStartTime: 'start-10845',
      portalGeneration: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      portalSourceType: 2 as const,
      portalWindowClass: 'google-chrome',
      portalWindowHandle: '812',
      portalPipewireSerial: '9001'
    };
    const boundTarget = { ...target, portalPipewireSerial: '9002' };
    world.portalSelection.mockResolvedValueOnce(selection);
    world.resolveTarget.mockResolvedValueOnce(target);
    world.bindTarget.mockImplementationOnce(async (grant, getSelections, options) => {
      expect(grant).toEqual(target);
      expect(getSelections()).toEqual([selection]);
      expect(options.isActive()).toBe(true);
      return boundTarget;
    });
    const callback = vi.fn();

    await world.display!(request(), callback);

    expect(world.steps).toEqual(['observer-ready', 'get-sources']);
    expect(world.resolveTarget).toHaveBeenCalledWith(
      { id: 'screen:1:0', name: 'Screen 1' },
      { wayland: true, selection, windowWitness: expect.objectContaining({ isActive: true }) }
    );
    expect(world.showMessageBox).not.toHaveBeenCalled();
    expect(world.portalStop).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:1:0', name: 'Screen 1' } });
    const id = await world.handlers.get('capture:acquire')!(event());
    expect(world.bindTarget).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      isActive: expect.any(Function), tapName: expect.any(String)
    });
    expect(world.start).toHaveBeenCalledWith(boundTarget);
    expect(world.portalVerifyWindow).toHaveBeenCalledWith({
      processId: 10845,
      processStartTime: 'start-10845',
      portalWindowClass: 'google-chrome'
    });
    expect(world.portalStop).toHaveBeenCalledTimes(1);
    await world.handlers.get('capture:release')!(event(), id);
  });
  it('routes an explicitly selected type-1 monitor as whole-screen audio bound to its exact video stream', async () => {
    const selection = {
      generation: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      sourceType: 1 as const,
      output: 'DP-1',
      pipewireSerial: '9001'
    };
    const target = {
      kind: 'screen' as const,
      portalGeneration: selection.generation,
      portalSourceType: 1 as const,
      portalOutput: 'DP-1',
      portalPipewireSerial: '9001'
    };
    const boundTarget = { ...target, portalPipewireSerial: '9002' };
    world.portalSelection.mockResolvedValueOnce(selection);
    world.resolveTarget.mockResolvedValueOnce(target);
    world.bindTarget.mockImplementationOnce(async (_grant, getSelections, options) => {
      expect(getSelections()).toEqual([selection]);
      expect(options.isActive()).toBe(true);
      return boundTarget;
    });
    const callback = vi.fn();

    await world.display!(request(), callback);

    expect(world.resolveTarget).toHaveBeenCalledWith(
      { id: 'screen:1:0', name: 'Screen 1' },
      { wayland: true, selection, windowWitness: expect.objectContaining({ isActive: true }) }
    );
    expect(world.showMessageBox).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:1:0', name: 'Screen 1' } });
    const id = await world.handlers.get('capture:acquire')!(event());
    expect(world.bindTarget).toHaveBeenCalled();
    expect(world.start).toHaveBeenCalledWith(boundTarget);
    expect(world.portalVerifyWindow).not.toHaveBeenCalled();
    await world.handlers.get('capture:release')!(event(), id);
  });
  it('keeps a screen grant video-only when the portal observer invalidates after binding', async () => {
    const selection = {
      generation: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      sourceType: 1 as const,
      output: 'DP-1',
      pipewireSerial: '9001'
    };
    const target = {
      kind: 'screen' as const,
      portalGeneration: selection.generation,
      portalSourceType: 1 as const,
      portalOutput: selection.output,
      portalPipewireSerial: selection.pipewireSerial
    };
    world.portalSelection.mockResolvedValueOnce(selection);
    world.resolveTarget.mockResolvedValueOnce(target);
    world.bindTarget.mockImplementationOnce(async () => {
      world.portalInvalidated = true;
      return target;
    });
    await world.display!(request(), vi.fn());
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('portal');
    expect(world.start).not.toHaveBeenCalled();
  });
  it('keeps an unresolved selected window video-only instead of falling back to whole-system audio', async () => {
    world.portalSelection.mockResolvedValueOnce({
      generation: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      sourceType: 2,
      windowClass: 'fixture-app',
      pipewireSerial: '9001'
    });
    world.resolveTarget.mockResolvedValueOnce(null);
    const callback = vi.fn();
    await world.display!(request(), callback);
    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:1:0', name: 'Screen 1' } });
    expect(world.showMessageBox).not.toHaveBeenCalled();
    expect(world.log).toHaveBeenCalledWith(expect.stringContaining('unique continuous pre-picker process identity'));
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
    expect(world.start).not.toHaveBeenCalled();
  });
  it('does not start audio when acquisition finishes after main-frame navigation', async () => {
    const selection = {
      generation: 'f4c6f96e-9d9a-4d17-a7c2-9d7bf032a773',
      sourceType: 2 as const,
      windowClass: 'google-chrome',
      windowHandle: '812',
      pipewireSerial: '9001'
    };
    const target = {
      kind: 'application' as const,
      processId: 10845,
      processStartTime: 'start-10845',
      portalGeneration: selection.generation,
      portalSourceType: 2 as const,
      portalWindowClass: selection.windowClass,
      portalWindowHandle: selection.windowHandle,
      portalPipewireSerial: selection.pipewireSerial
    };
    const late = Promise.withResolvers<typeof target>();
    world.portalSelection.mockResolvedValueOnce(selection);
    world.resolveTarget.mockResolvedValueOnce(target);
    world.bindTarget.mockReturnValueOnce(late.promise);
    await world.display!(request(), vi.fn());

    const acquisition = world.handlers.get('capture:acquire')!(event());
    const outcome = acquisition.then(
      () => 'started',
      () => 'cancelled'
    );
    await flush();
    expect(world.bindTarget).toHaveBeenCalled();
    event().sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    late.resolve(target);

    expect(await outcome).toBe('cancelled');
    expect(world.start).not.toHaveBeenCalled();
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
  });

  it('refuses capture without a selected audio target instead of silently capturing every app', async () => {
    await expect(world.handlers.get('capture:acquire')!(event())).rejects.toThrow('source');
    expect(world.start).not.toHaveBeenCalled();
  });
});
