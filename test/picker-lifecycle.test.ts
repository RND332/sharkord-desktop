import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCapturerSource } from 'electron';
import type { DisplayCapturerRequest } from '../src/main/picker';

type IpcHandler = (...args: unknown[]) => unknown;
const electron = await vi.hoisted(async () => {
  // Vitest runs this mock factory before static imports are initialized.
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    static instances: Window[] = [];
    destroyed = false;
    webContents = { mainFrame: {}, send: vi.fn() };
    constructor() { super(); Window.instances.push(this); }
    loadFile = vi.fn(async () => {});
    show() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = new Map<string, IpcHandler>();
  return { Window, handlers, getSources: vi.fn(), handle: (name: string, handler: IpcHandler) => handlers.set(name, handler) };
});
vi.mock('electron', () => ({
  BrowserWindow: electron.Window,
  desktopCapturer: { getSources: electron.getSources },
  ipcMain: { handle: electron.handle }
}));

import { pickDisplaySource, registerPickerIpc } from '../src/main/picker';
const request: DisplayCapturerRequest = { types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false, notice: null };
// The Electron image fixture only needs isEmpty because it contains no images.
const source = (id: string): DesktopCapturerSource =>
  ({ id, name: id, thumbnail: { isEmpty: () => true }, appIcon: null }) as unknown as DesktopCapturerSource;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('picker ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electron.Window.instances = [];
    electron.getSources.mockReset();
    electron.handlers.clear();
    registerPickerIpc();
  });
  afterEach(async () => {
    for (const win of electron.Window.instances) if (!win.destroyed) win.destroy();
    await flush();
    vi.useRealTimers();
  });

  it('does not replace a newer picker with an older in-flight refresh', async () => {
    const refresh = Promise.withResolvers<DesktopCapturerSource[]>();
    electron.getSources.mockReturnValue(refresh.promise);
    const first = pickDisplaySource(null, [source('window:1:0')], request);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    electron.Window.instances[0]!.destroy();
    expect(await first).toBeNull();
    const second = pickDisplaySource(null, [source('window:2:0')], request);
    await flush();
    refresh.resolve([source('window:3:0')]);
    await flush();
    const secondWindow = electron.Window.instances[1]!;
    electron.handlers.get('picker:choose')!({ sender: secondWindow.webContents, senderFrame: secondWindow.webContents.mainFrame }, 'window:2:0');
    expect((await second)?.id).toBe('window:2:0');
  });

  it('rejects a choice from another window without dismissing the picker', async () => {
    const result = pickDisplaySource(null, [source('window:1:0')], request);
    await flush();
    const win = electron.Window.instances[0]!;
    expect(electron.handlers.get('picker:choose')!({ sender: {}, senderFrame: {} }, null)).toBe(false);
    electron.handlers.get('picker:choose')!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'window:1:0');
    expect((await result)?.id).toBe('window:1:0');
  });
});
