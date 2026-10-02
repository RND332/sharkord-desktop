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
    stopRefresh(pending);
    finish?.(typeof id === 'string' ? id : null);
    return true;
  });
};

const stopRefresh = (request: Pending | null): void => {
  if (request?.refreshTimer) {
    clearInterval(request.refreshTimer);
    request.refreshTimer = null;
  }
};

const fetchSources = async (capturerRequest: DisplayCapturerRequest): Promise<DesktopCapturerSource[]> => {
  return desktopCapturer.getSources({
    types: capturerRequest.types,
    thumbnailSize: capturerRequest.thumbnailSize,
    fetchWindowIcons: capturerRequest.fetchWindowIcons
  });
};

/** Send changed metadata and removed IDs without resending unchanged thumbnails. */
const pushRefreshed = (request: Pending, fresh: PickerSource[]): void => {
  const previous = new Map(request.sources.map((source) => [source.id, source]));
  const currentIds = new Set(fresh.map((source) => source.id));
  const removed = request.sources.filter((source) => !currentIds.has(source.id)).map((source) => source.id);
  const changed = fresh.filter((source) => {
    const old = previous.get(source.id);
    return !old || old.name !== source.name || old.thumbnail !== source.thumbnail || old.icon !== source.icon;
  });

  request.sources = fresh;
  if (changed.length === 0 && removed.length === 0) return;

  request.window.webContents.send('picker:refresh', {
    sources: changed,
    removed,
    notice: request.notice
  } satisfies PickerPayload & { removed: string[] });
};

const startRefresh = (request: Pending): void => {
  stopRefresh(request);
  const window = request.window;
  let refreshing = false;

  request.refreshTimer = setInterval(() => {
    if (pending !== request || window.isDestroyed()) {
      stopRefresh(request);
      return;
    }
    if (refreshing) return;
    refreshing = true;
    void fetchSources(request.capturerRequest)
      .then((freshSources) => {
        if (pending !== request || window.isDestroyed()) return;
        request.latestSources = freshSources;
        pushRefreshed(request, describeSources(freshSources));
      })
      .catch(() => {
        // Ignore transient capture errors between refresh cycles.
      })
      .finally(() => {
        refreshing = false;
      });
  }, REFRESH_INTERVAL_MS);
  request.refreshTimer.unref();
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
  const request: Pending = {
    sources: describeSources(initialSources),
    notice,
    resolve: choice.resolve,
    refreshTimer: null,
    capturerRequest,
    window: picker,
    latestSources: initialSources
  };
  pending = request;

  picker.on('closed', () => {
    stopRefresh(request);
    if (pending === request) pending = null;
    choice.resolve(null);
  });

  try {
    await picker.loadFile(join(__dirname, 'picker.html'));
    if (picker.isDestroyed()) return null;
    picker.show();
    // Start the live refresh loop now that the renderer is ready to receive updates.
    startRefresh(request);
  } catch (error) {
    log('picker failed to load:', error);
    choice.resolve(null);
  }

  const id = await choice.promise;
  const resolvedSources = request.latestSources;
  stopRefresh(request);
  if (pending === request) pending = null;
  if (!picker.isDestroyed()) picker.destroy();
  const picked = resolveChoice(resolvedSources, id);
  log('picker result:', picked ? picked.name : 'cancelled');
  return picked;
};
