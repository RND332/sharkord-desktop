import { BrowserWindow, desktopCapturer, ipcMain, type DesktopCapturerSource } from 'electron';
import { join } from 'node:path';

export type PickerSource = {
  id: string;
  name: string;
  thumbnail: string | null;
  icon: string | null;
};

export type PickerPayload = {
  sources: PickerSource[];
  notice: string | null;
};

export type DisplayCapturerRequest = {
  types: Array<'screen' | 'window'>;
  thumbnailSize: { width: number; height: number };
  fetchWindowIcons: boolean;
  notice: string | null;
};

type Pending = {
  sources: PickerSource[];
  notice: string | null;
  resolve: (id: string | null) => void;
  refreshTimer: NodeJS.Timeout | null;
  capturerRequest: DisplayCapturerRequest;
  window: BrowserWindow;
  /** Latest full capturer sources — a window that appeared mid-refresh can still be chosen. */
  latestSources: DesktopCapturerSource[];
};

/** How often the picker thumbnails refresh (ms). */
const REFRESH_INTERVAL_MS = 2000;

/**
 * How we ask Chromium for sources. Live DWM thumbnails of every window on
 * Windows use the same Graphics Capture path that can freeze Explorer
 * (Alt+Tab / Start menu), so the in-app picker lists windows by name and icon
 * only. The chosen window is still a real window share.
 */
export const displayCapturerRequest = (input: {
  platform: string;
  osRelease: string;
  systemPicker: boolean;
}): DisplayCapturerRequest => {
  const skipThumbs = input.systemPicker || input.platform === 'win32';
  return {
    types: ['screen', 'window'],
    thumbnailSize: skipThumbs ? { width: 0, height: 0 } : { width: 320, height: 180 },
    fetchWindowIcons: !input.systemPicker,
    notice: null
  };
};

let pending: Pending | null = null;

/** Renderer-safe view of the capture sources: images as data URLs, never the Electron objects. */
export const describeSources = (sources: DesktopCapturerSource[]): PickerSource[] =>
  sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
  }));

export const resolveChoice = (
  sources: DesktopCapturerSource[],
  id: string | null
): DesktopCapturerSource | null => (id === null ? null : sources.find((source) => source.id === id) ?? null);

/** Called once at startup; the picker page talks to these. */
export const registerPickerIpc = (): void => {
  ipcMain.handle('picker:sources', (): PickerPayload => ({
    sources: pending?.sources ?? [],
    notice: pending?.notice ?? null
  }));
  ipcMain.handle('picker:choose', (_event, id: unknown) => {
    const finish = pending?.resolve;
    stopRefresh();
    // Keep `pending` alive until pickDisplaySource reads latestSources, then clears it.
    finish?.(typeof id === 'string' ? id : null);
    return true;
  });
};

const stopRefresh = (): void => {
  if (pending?.refreshTimer) {
    clearInterval(pending.refreshTimer);
    pending.refreshTimer = null;
  }
};

const fetchSources = async (capturerRequest: DisplayCapturerRequest): Promise<DesktopCapturerSource[]> => {
  return desktopCapturer.getSources({
    types: capturerRequest.types,
    thumbnailSize: capturerRequest.thumbnailSize,
    fetchWindowIcons: capturerRequest.fetchWindowIcons
  });
};

/** Push only thumbnails that actually changed since the last refresh, to keep IPC light. */
const pushRefreshed = (fresh: PickerSource[]): void => {
  const window = pending?.window;
  if (!pending || !window || window.isDestroyed()) return;

  const previous = new Map(pending.sources.map((s) => [s.id, s.thumbnail]));
  const changed = fresh.filter((s) => previous.get(s.id) !== s.thumbnail);

  pending.sources = fresh;
  if (changed.length === 0) return;

  window.webContents.send('picker:refresh', {
    sources: changed,
    notice: pending.notice
  } satisfies PickerPayload);
};

const startRefresh = (capturerRequest: DisplayCapturerRequest): void => {
  stopRefresh();
  const window = pending?.window;
  if (!window || window.isDestroyed()) return;

  pending!.refreshTimer = setInterval(() => {
    if (!pending || window.isDestroyed()) {
      stopRefresh();
      return;
    }
    void fetchSources(capturerRequest)
      .then((freshSources) => {
        pending!.latestSources = freshSources;
        pushRefreshed(describeSources(freshSources));
      })
      .catch(() => {
        // Ignore transient capture errors between refresh cycles.
      });
  }, REFRESH_INTERVAL_MS);
  // Don't keep the process alive solely for thumbnail refresh.
  pending!.refreshTimer.unref();
};

/**
 * Asks the user what to share, in a window of our own. Windows and macOS have no system picker for
 * Electron, and Linux only gets one through the Wayland portal.
 *
 * `initialSources` are the first frame (already in hand from the display-media request);
 * the picker then takes over its own refresh loop so the thumbnails keep moving.
 */
export const pickDisplaySource = async (
  parent: BrowserWindow | null,
  initialSources: DesktopCapturerSource[],
  capturerRequest: DisplayCapturerRequest,
  log: (...parts: unknown[]) => void = () => {},
  notice: string | null = null
): Promise<DesktopCapturerSource | null> => {
  if (initialSources.length === 0) return null;
  log('picker opened with', initialSources.length, 'sources');

  const picker = new BrowserWindow({
    width: 920,
    height: 620,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    title: 'Share your screen',
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  const choice = Promise.withResolvers<string | null>();
  pending = {
    sources: describeSources(initialSources),
    notice,
    resolve: choice.resolve,
    refreshTimer: null,
    capturerRequest,
    window: picker,
    latestSources: initialSources
  };

  picker.on('closed', () => {
    const finish = pending?.resolve;
    stopRefresh();
    pending = null;
    finish?.(null);
  });

  try {
    await picker.loadFile(join(__dirname, 'picker.html'));
    if (picker.isDestroyed()) return null;
    picker.show();
    // Start the live refresh loop now that the renderer is ready to receive updates.
    startRefresh(capturerRequest);
  } catch {
    // The window can be closed while it is still loading; 'closed' has already settled the choice.
  }

  const id = await choice.promise;
  // Capture the most recent source list before destroying the window — windows that appeared
  // during the live refresh are in latestSources but not in the initial snapshot.
  const resolvedSources = pending?.latestSources ?? initialSources;
  stopRefresh();
  pending = null;
  if (!picker.isDestroyed()) picker.destroy();
  const picked = resolveChoice(resolvedSources, id);
  log('picker result:', picked ? picked.name : 'cancelled');
  return picked;
};
