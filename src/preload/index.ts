import { contextBridge, ipcRenderer, webFrame } from 'electron';

type PcmHandler = (event: unknown, chunk: Uint8Array) => void;

let holders = 0;

const bridge = {
  /** The page picks its capture strategy from this. */
  platform: process.platform,
  /** 'pipewire' | 'windows' | 'none' — whether the app captures share audio itself (from main). */
  captureSource: (process.argv.find((arg) => arg.startsWith('--sharkord-capture=')) ?? '--sharkord-capture=none').split('=')[1],
  /** SHARKORD_WINDOWS_AUDIO=on: include system audio even where it cannot exclude our own playback. */
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
  acquireCapture: async (): Promise<void> => {
    if (holders === 0) await ipcRenderer.invoke('capture:acquire');
    holders += 1;
  },
  releaseCapture: async (): Promise<void> => {
    holders = Math.max(0, holders - 1);
    if (holders === 0) await ipcRenderer.invoke('capture:release');
  },
  onPcm: (callback: (chunk: Uint8Array) => void): (() => void) => {
    const handler: PcmHandler = (_event, chunk) => callback(new Uint8Array(chunk));
    ipcRenderer.on('pcm', handler as never);
    return () => {
      ipcRenderer.off('pcm', handler as never);
    };
  }
};

contextBridge.exposeInMainWorld('sharkordDesktop', bridge);
console.log('[sharkord-desktop] preload ready, bridge exposed');

// Linux gets PCM injected from PipeWire; Windows and macOS only add `restrictOwnAudio` so the
// system audio Chromium captures leaves out this client's own playback.
void (async () => {
  try {
    const source = (await ipcRenderer.invoke('patch:source')) as string;
    await webFrame.executeJavaScript(source);
  } catch (error) {
    console.error('[sharkord-desktop] failed to inject the display-media patch', error);
  }
})();
