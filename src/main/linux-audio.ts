import { defaultRunner, type Runner, type TapTarget } from './tap';

export type AudioWindow = { processId: number; title: string; appClass: string };

export const resolveLinuxAudioTarget = async (
  source: { id: string; name: string },
  options: {
    wayland: boolean;
    runner?: Runner;
    /** 0: video only; 1: explicitly confirmed entire screen; 2+: application. */
    choose?: (windows: AudioWindow[]) => Promise<number>;
  }
): Promise<TapTarget | null> => {
  const runner = options.runner ?? defaultRunner;
  // Electron/WebRTC's portal source is a restore-token ID, not a window ID. Its
  // screen/window prefix and generic name do NOT reveal what the portal selected.
  // Do not guess from focus, app name, title, or currently playing audio.
  if (options.wayland) {
    if (!options.choose) return null;
    let windows: AudioWindow[] = [];
    try {
      const clients: unknown = JSON.parse(await runner('hyprctl', ['clients', '-j']));
      if (Array.isArray(clients)) {
        windows = clients.filter((client) => client && client.mapped === true &&
          Number.isSafeInteger(client.pid) && client.pid > 1 &&
          typeof client.title === 'string' && typeof client.class === 'string')
          .map((client) => ({ processId: client.pid, title: client.title, appClass: client.class }));
      }
    } catch {
      // Unsupported compositor: remain video-only unless the user explicitly
      // confirms that they selected an entire screen. Never infer system audio.
    }
    const choice = await options.choose(windows);
    if (choice === 1) return { kind: 'screen' };
    const window = Number.isInteger(choice) && choice >= 2 ? windows[choice - 2] : undefined;
    return window ? { kind: 'application', processId: window.processId } : null;
  }
  if (/^screen:\d+:\d+$/.test(source.id)) return { kind: 'screen' };
  const window = /^window:([1-9]\d*):\d+$/.exec(source.id);
  if (!window) return null;
  try {
    const result = await runner('xprop', ['-id', window[1]!, '_NET_WM_PID']);
    const pid = /^_NET_WM_PID\(CARDINAL\) = ([1-9]\d*)\s*$/.exec(result);
    if (!pid || !Number.isSafeInteger(Number(pid[1]))) return null;
    return { kind: 'application', processId: Number(pid[1]) };
  } catch {
    return null;
  }
};
