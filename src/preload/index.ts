import { contextBridge, ipcRenderer, webFrame } from 'electron';

type PcmHandler = (event: unknown, chunk: Uint8Array, sessionId?: number) => void;

let holders = 0;
let acquiring: Promise<number | null> | null = null;
let session: number | null = null;
let sessionEnded = false;
let endedThrough = 0;
const endedListeners = new Set<() => void>();

const notifyEnded = (): void => {
  for (const listener of endedListeners) listener();
};

ipcRenderer.on('capture:ended', ((_event: unknown, sessionId?: number) => {
  if (typeof sessionId !== 'number') {
    notifyEnded();
    return;
  }
  if (sessionId <= endedThrough) return;
  endedThrough = sessionId;
  if (sessionId !== session) return;
  sessionEnded = true;
  notifyEnded();
}) as never);

const bridge = {
  /** The page picks its capture strategy from this. */
  platform: process.platform,
  /** 'pipewire' | 'windows' | 'none' — whether the app captures share audio itself (from main). */
  captureSource: (process.argv.find((arg) => arg.startsWith('--sharkord-capture=')) ?? '--sharkord-capture=none').split('=')[1],
  forceSystemAudio: process.env.SHARKORD_WINDOWS_AUDIO === 'on',
  /** Version/platform for the badge the page shows in its corner. */
  appInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info'),
  /** The page reports which capture strategy it installed; it lands in the log. */
  reportCaptureMode: (info: {
    mode: string;
    echoTest?: string;
    ownAudioSupported?: boolean;
    ownAudioApplied?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('capture:mode', info),
  /** Used by the built-in server picker; harmless on the client page. */
  currentServer: (): Promise<string | null> => ipcRenderer.invoke('server:current'),
  submitServer: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('server:submit', url),
  /** Used by the built-in picker window. */
  pickerSources: (): Promise<unknown> => ipcRenderer.invoke('picker:sources'),
  pickerChoose: (id: string | null): Promise<boolean> => ipcRenderer.invoke('picker:choose', id),
  onPickerRefresh: (callback: (payload: { sources: Array<{ id: string; name: string; thumbnail: string | null; icon: string | null }> }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { sources: Array<{ id: string; name: string; thumbnail: string | null; icon: string | null }> }) => callback(payload);
    ipcRenderer.on('picker:refresh', handler as never);
    return () => {
      ipcRenderer.off('picker:refresh', handler as never);
    };
  },
  acquireCapture: async (): Promise<void> => {
    if (holders === 0) {
      acquiring ??= ipcRenderer
        .invoke('capture:acquire')
        .then((sessionId: unknown): number | null => {
          if (typeof sessionId === 'number' && sessionId <= endedThrough) {
            throw new Error('capture ended while it was being acquired');
          }
          return typeof sessionId === 'number' ? sessionId : null;
        })
        .finally(() => {
          acquiring = null;
        });
      try {
        session = await acquiring;
        sessionEnded = false;
      } catch (error) {
        session = null;
        sessionEnded = false;
        throw error;
      }
    }
    holders += 1;
  },
  releaseCapture: async (): Promise<void> => {
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    const releasing = session;
    session = null;
    sessionEnded = false;
    await ipcRenderer.invoke('capture:release', releasing ?? undefined);
  },
  onPcm: (callback: (chunk: Uint8Array) => void): (() => void) => {
    const handler: PcmHandler = (_event, chunk, sessionId) => {
      if (session !== null ? sessionId !== session : typeof sessionId === 'number') return;
      callback(new Uint8Array(chunk));
    };
    ipcRenderer.on('pcm', handler as never);
    return () => {
      ipcRenderer.off('pcm', handler as never);
    };
  },
  onCaptureEnded: (callback: () => void): (() => void) => {
    endedListeners.add(callback);
    if (session !== null && sessionEnded) callback();
    return () => {
      endedListeners.delete(callback);
    };
  }
};

contextBridge.exposeInMainWorld('sharkordDesktop', bridge);
console.log('[sharkord-desktop] preload ready, bridge exposed');

void (async () => {
  try {
    const source = (await ipcRenderer.invoke('patch:source')) as string;
    await webFrame.executeJavaScript(source);
  } catch (error) {
    console.error('[sharkord-desktop] failed to inject the display-media patch', error);
  }
})();
