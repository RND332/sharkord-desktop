import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCapturerSource } from 'electron';
import { displayCapturerRequest, pickDisplaySource, registerPickerIpc } from '../src/main/picker';

type TestWindow = {
  destroyed: boolean;
  messages: Array<{ channel: string; payload: unknown }>;
  webContents: { mainFrame: object };
  destroy(): void;
};

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as TestWindow[],
  getSources: vi.fn(),
  loadFile: vi.fn()
}));

vi.mock('electron', () => {
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      messages: TestWindow['messages'] = [];
      webContents = {
        mainFrame: {},
        send: (channel: string, payload: unknown) => this.messages.push({ channel, payload })
      };
      constructor() {
        super();
        electron.windows.push(this);
      }
      loadFile(): Promise<void> {
        return electron.loadFile();
      }
      isDestroyed(): boolean {
        return this.destroyed;
      }
      show(): void {}
      destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
      }
    },
    desktopCapturer: { getSources: electron.getSources },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        electron.handlers.set(channel, handler);
      }
    }
  };
});

const source = (id: string, name: string): DesktopCapturerSource => ({
  id,
  name,
  display_id: '',
  thumbnail: { isEmpty: () => true } as DesktopCapturerSource['thumbnail'],
  appIcon: { isEmpty: () => true } as DesktopCapturerSource['appIcon']
});

const capturer = displayCapturerRequest({
  platform: 'win32', osRelease: '10.0.22621', systemPicker: false
});

const choose = (id: string | null): void => {
  const window = electron.windows.at(-1)!;
  electron.handlers.get('picker:choose')?.({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, id);
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  electron.windows.length = 0;
  electron.handlers.clear();
  electron.getSources.mockReset();
  electron.loadFile.mockReset().mockResolvedValue(undefined);
  registerPickerIpc();
});

afterEach(async () => {
  for (const window of electron.windows) window.destroy();
  await flush();
  vi.useRealTimers();
});

describe('picker lifecycle', () => {
  it('publishes newly opened windows and removes closed windows even without thumbnails', async () => {
    const next = source('window:2:0', 'Presentation');
    electron.getSources.mockResolvedValue([next]);
    const picked = pickDisplaySource(null, [source('window:1:0', 'Closed editor')], capturer);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(electron.windows[0]!.messages).toEqual([{
      channel: 'picker:refresh',
      payload: {
        sources: [{ id: 'window:2:0', name: 'Presentation', thumbnail: null, icon: null }],
        notice: null
      }
    }]);
    choose('window:2:0');
    expect(await picked).toBe(next);
  });

  it('publishes a renamed window when its thumbnail is unchanged', async () => {
    const renamed = source('window:1:0', 'Presentation — slide 2');
    electron.getSources.mockResolvedValue([renamed]);
    const picked = pickDisplaySource(null, [source('window:1:0', 'Presentation — slide 1')], capturer);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(electron.windows[0]!.messages).toEqual([{
      channel: 'picker:refresh',
      payload: {
        sources: [{ id: 'window:1:0', name: 'Presentation — slide 2', thumbnail: null, icon: null }],
        notice: null
      }
    }]);
    choose('window:1:0');
    expect(await picked).toBe(renamed);
  });

  it('publishes removal of the last window and refuses that vanished source', async () => {
    electron.getSources.mockResolvedValue([]);
    const picked = pickDisplaySource(null, [source('window:1:0', 'Closed editor')], capturer);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(electron.windows[0]!.messages).toEqual([{
      channel: 'picker:refresh',
      payload: { sources: [], notice: null }
    }]);
    choose('window:1:0');
    expect(await picked).toBeNull();
  });

  it('does not let a cancelled picker refresh replace the next picker sources', async () => {
    const late = Promise.withResolvers<DesktopCapturerSource[]>();
    electron.getSources.mockReturnValueOnce(late.promise);
    const first = pickDisplaySource(null, [source('window:1:0', 'First editor')], capturer);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    choose(null);
    expect(await first).toBeNull();

    const next = source('window:2:0', 'Next presentation');
    const second = pickDisplaySource(null, [next], capturer);
    await flush();
    late.resolve([source('window:9:0', 'Stale refresh')]);
    await flush();
    choose('window:2:0');
    expect(await second).toBe(next);
  });

  it('refuses an overlapping picker without losing the original choice', async () => {
    const original = source('window:1:0', 'Original presentation');
    const first = pickDisplaySource(null, [original], capturer);
    await flush();
    const second = pickDisplaySource(null, [source('window:2:0', 'Second editor')], capturer);
    await flush();

    expect(electron.windows).toHaveLength(1);
    expect(await second).toBeNull();
    choose('window:1:0');
    expect(await first).toBe(original);
  });

  it('settles cancellation and closes the picker when its page fails to load', async () => {
    electron.loadFile.mockRejectedValueOnce(new Error('picker page unavailable'));
    const picked = pickDisplaySource(null, [source('window:1:0', 'Presentation')], capturer);
    await flush();

    expect(electron.windows[0]!.destroyed).toBe(true);
    expect(await picked).toBeNull();
  });

  it('rejects a choice from another window without dismissing the picker', async () => {
    const original = source('window:1:0', 'Presentation');
    const picked = pickDisplaySource(null, [original], capturer);
    await flush();

    expect(electron.handlers.get('picker:choose')!({ sender: {}, senderFrame: {} }, null)).toBe(false);
    choose('window:1:0');
    expect(await picked).toBe(original);
  });
});
