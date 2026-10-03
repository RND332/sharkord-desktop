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
  refreshing: boolean;
  settled: boolean;
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
  ipcMain.handle('picker:sources', (event): PickerPayload => ({
    sources: event.sender === pending?.window.webContents ? pending.sources : [],
    notice: event.sender === pending?.window.webContents ? pending.notice : null
  }));
  ipcMain.handle('picker:choose', (event, id: unknown) => {
    const active = pending;
    if (!active || event.sender !== active.window.webContents || event.senderFrame !== event.sender.mainFrame) return false;
    active.settled = true;
    stopRefresh(active);
    active.resolve(typeof id === 'string' ? id : null);
    return true;
  });
};

const stopRefresh = (active: Pending): void => {
  if (active.refreshTimer) {
    clearInterval(active.refreshTimer);
    active.refreshTimer = null;
  }
};

const fetchSources = async (capturerRequest: DisplayCapturerRequest): Promise<DesktopCapturerSource[]> => {
  return desktopCapturer.getSources({
    types: capturerRequest.types,
    thumbnailSize: capturerRequest.thumbnailSize,
    fetchWindowIcons: capturerRequest.fetchWindowIcons
  });
};

/** Send a full source snapshot only when membership, metadata, or thumbnails change. */
const pushRefreshed = (active: Pending, fresh: PickerSource[]): void => {
  const previous = active.sources;
  const changed = fresh.length !== previous.length || fresh.some((source, index) => {
    const before = previous[index];
    return source.id !== before?.id || source.name !== before?.name ||
      source.thumbnail !== before?.thumbnail || source.icon !== before?.icon;
  });
  active.sources = fresh;
  if (changed) {
    active.window.webContents.send('picker:refresh', { sources: fresh, notice: active.notice } satisfies PickerPayload);
  }
};

const startRefresh = (active: Pending): void => {
  stopRefresh(active);
  active.refreshTimer = setInterval(() => {
    if (pending !== active || active.settled || active.window.isDestroyed()) {
      stopRefresh(active);
      return;
    }
    if (active.refreshing) return;
    active.refreshing = true;
    void fetchSources(active.capturerRequest)
      .then((freshSources) => {
        if (pending !== active || active.settled || active.window.isDestroyed()) return;
        active.latestSources = freshSources;
        pushRefreshed(active, describeSources(freshSources));
      })
      .catch(() => {
        // Ignore transient capture errors between refresh cycles.
      })
      .finally(() => { active.refreshing = false; });
  }, REFRESH_INTERVAL_MS);
  active.refreshTimer.unref();
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
  if (initialSources.length === 0 || pending) return null;
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
  const active: Pending = {
    sources: describeSources(initialSources),
    notice,
    resolve: choice.resolve,
    refreshTimer: null,
    refreshing: false,
    settled: false,
    capturerRequest,
    window: picker,
    latestSources: initialSources
  };

  pending = active;
  picker.on('closed', () => {
    active.settled = true;
    stopRefresh(active);
    if (pending === active) pending = null;
    active.resolve(null);
  });

  try {
    await picker.loadFile(join(__dirname, 'picker.html'));
    if (picker.isDestroyed()) return null;
    picker.show();
    // Start the live refresh loop now that the renderer is ready to receive updates.
    startRefresh(active);
  } catch {
    active.resolve(null);
  }

  const id = await choice.promise;
  // Capture the most recent source list before destroying the window — windows that appeared
  // during the live refresh are in latestSources but not in the initial snapshot.
  const resolvedSources = active.latestSources;
  stopRefresh(active);
  if (pending === active) pending = null;
  if (!picker.isDestroyed()) picker.destroy();
  const picked = resolveChoice(resolvedSources, id);
  log('picker result:', picked ? picked.name : 'cancelled');
  return picked;
};
