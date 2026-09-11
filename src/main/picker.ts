import { BrowserWindow, ipcMain, type DesktopCapturerSource } from 'electron';
import { join } from 'node:path';

export type PickerSource = {
  id: string;
  name: string;
  thumbnail: string | null;
  icon: string | null;
};

type Pending = {
  sources: PickerSource[];
  resolve: (id: string | null) => void;
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
  ipcMain.handle('picker:sources', () => pending?.sources ?? []);
  ipcMain.handle('picker:choose', (_event, id: unknown) => {
    const finish = pending?.resolve;
    pending = null;
    finish?.(typeof id === 'string' ? id : null);
    return true;
  });
};

/**
 * Asks the user what to share, in a window of our own. Windows and macOS have no system picker for
 * Electron, and Linux only gets one through the Wayland portal.
 */
export const pickDisplaySource = async (
  parent: BrowserWindow | null,
  sources: DesktopCapturerSource[]
): Promise<DesktopCapturerSource | null> => {
  if (sources.length === 0) return null;

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
  pending = { sources: describeSources(sources), resolve: choice.resolve };
  picker.on('closed', () => {
    const finish = pending?.resolve;
    pending = null;
    finish?.(null);
  });

  try {
    await picker.loadFile(join(__dirname, 'picker.html'));
    if (!picker.isDestroyed()) picker.show();
  } catch {
    // The window can be closed while it is still loading; 'closed' has already settled the choice.
  }

  const id = await choice.promise;
  if (!picker.isDestroyed()) picker.destroy();
  return resolveChoice(sources, id);
};
