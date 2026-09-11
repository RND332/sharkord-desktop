import { contextBridge, ipcRenderer, webFrame } from 'electron';

type PcmHandler = (event: unknown, chunk: Uint8Array) => void;

let holders = 0;

const bridge = {
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

// Only Linux needs the injection: there the capture is ours. Elsewhere the platform already
// provides system audio and wrapping getDisplayMedia would throw it away.
if (process.platform === 'linux') {
  void (async () => {
    try {
      const source = (await ipcRenderer.invoke('patch:source')) as string;
      await webFrame.executeJavaScript(source);
    } catch (error) {
      console.error('[sharkord-desktop] failed to inject the display-media patch', error);
    }
  })();
} else {
  console.info(
    `[sharkord-desktop] ${process.platform}: using the platform's own display capture (no PipeWire routing)`
  );
}
