import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, Set<IpcHandler>>();
  return {
    handlers,
    invoke: vi.fn(),
    on: vi.fn((event: string, handler: IpcHandler) => {
      const listeners = handlers.get(event) ?? new Set<IpcHandler>();
      listeners.add(handler);
      handlers.set(event, listeners);
    }),
    off: vi.fn((event: string, handler: IpcHandler) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of Array.from(handlers.get(event) ?? [])) handler({}, ...args);
    },
    expose: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined)
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
  webFrame: { executeJavaScript: electron.executeJavaScript }
}));

type Bridge = {
  acquireCapture(): Promise<void>;
  releaseCapture(): Promise<void>;
  onPcm(callback: (chunk: Uint8Array) => void): () => void;
  onCaptureEnded(callback: () => void): () => void;
};

const loadBridge = async (): Promise<Bridge> => {
  vi.resetModules();
  electron.expose.mockClear();
  await import('../src/preload');
  const exposed = electron.expose.mock.calls.at(-1)?.[1];
  if (!exposed) throw new Error('preload exposed no bridge');
  return exposed as Bridge;
};

const acquiredCalls = (): unknown[] =>
  electron.invoke.mock.calls.filter((call) => call[0] === 'capture:acquire');

let restoreLog: (() => void) | null = null;

beforeEach(() => {
  electron.handlers.clear();
  electron.invoke.mockReset();
  electron.invoke.mockResolvedValue(undefined);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  restoreLog = () => spy.mockRestore();
});

afterEach(() => {
  restoreLog?.();
  restoreLog = null;
});

describe('preload bridge: capture sessions', () => {
  it('delivers PCM only for the session the page holds', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce(7);
    await bridge.acquireCapture();

    const chunks: number[][] = [];
    bridge.onPcm((chunk) => chunks.push(Array.from(chunk)));
    electron.emit('pcm', new Uint8Array([1]), 6);
    electron.emit('pcm', new Uint8Array([2]), 7);
    electron.emit('pcm', new Uint8Array([3]));

    expect(chunks).toEqual([[2]]);
  });

  it('rejects an acquisition whose session ended before the acknowledgement', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockImplementationOnce(async () => {
      electron.emit('capture:ended', 7);
      return 7;
    });

    await expect(bridge.acquireCapture()).rejects.toThrow();
    expect(acquiredCalls()).toHaveLength(1);
  });

  it('delivers the end of the held session, including to a listener that joins late', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce(7);
    await bridge.acquireCapture();

    electron.emit('capture:ended', 7);
    const late = vi.fn();
    bridge.onCaptureEnded(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  it('releases the session the page acquired and ignores stale ends afterwards', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce(7);
    await bridge.acquireCapture();
    await bridge.releaseCapture();
    expect(electron.invoke).toHaveBeenCalledWith('capture:release', 7);

    electron.invoke.mockResolvedValueOnce(11);
    await bridge.acquireCapture();
    const ended = vi.fn();
    bridge.onCaptureEnded(ended);
    electron.emit('capture:ended', 7);

    expect(ended).not.toHaveBeenCalled();
    await bridge.releaseCapture();
    expect(electron.invoke).toHaveBeenLastCalledWith('capture:release', 11);
  });

  it('shares one acquisition between concurrent callers', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce(7);
    await Promise.all([bridge.acquireCapture(), bridge.acquireCapture()]);
    await bridge.releaseCapture();
    await bridge.releaseCapture();

    expect(acquiredCalls()).toHaveLength(1);
    expect(electron.invoke).toHaveBeenCalledWith('capture:release', 7);
  });

  it('keeps platforms without session ids delivering audio and releasing', async () => {
    const bridge = await loadBridge();
    await bridge.acquireCapture();

    const chunks: number[][] = [];
    bridge.onPcm((chunk) => chunks.push(Array.from(chunk)));
    electron.emit('pcm', new Uint8Array([4]));

    expect(chunks).toEqual([[4]]);
    await bridge.releaseCapture();
    expect(electron.invoke).toHaveBeenLastCalledWith('capture:release', undefined);
  });
});
