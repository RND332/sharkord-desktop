import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, session, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { removeLegacyRouting } from './legacy';
import { pickDisplaySource, registerPickerIpc } from './picker';
import { normalizeServerUrl, readServerUrl, saveServerUrl } from './server-config';
import { runSelftest } from './selftest';
import { TapCapture } from './tap';
import { checkForUpdatesNow, setupAutoUpdates } from './updater';
import { writeWav } from './wav';

const config = loadConfig();
const log = (...parts: unknown[]): void => {
  console.log('[sharkord-desktop]', ...parts);
};

const tap = new TapCapture({ tapName: config.tapName, log });

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let shuttingDown = false;
let allowedOrigin = '';
let currentServerUrl: string | null = null;
const debugChunks: Buffer[] = [];

const installPermissionHandlers = (origin: () => string): void => {
  const allowed: Record<string, true> = {
    media: true,
    'display-capture': true,
    fullscreen: true,
    'clipboard-sanitized-write': true,
    notifications: true
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const fromApp = origin() !== '' && (contents?.getURL() ?? '').startsWith(origin());
    callback(fromApp && allowed[permission] === true);
  });

  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return origin() !== '' && requestingOrigin.startsWith(origin()) && allowed[permission] === true;
  });

  // Electron has no screen picker of its own. On Wayland `getSources` raises the desktop's own
  // dialog (Hyprland's share picker) and returns what the user chose there; everywhere else —
  // Windows, macOS, X11 — we have to ask ourselves, in a window like Discord's.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
    const wantsSystemPicker = process.env.SHARKORD_PICKER === 'system' || (wayland && process.env.SHARKORD_PICKER !== 'inapp');

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        // Thumbnails are only needed for our own picker; the portal dialog draws its own.
        thumbnailSize: wantsSystemPicker ? { width: 0, height: 0 } : { width: 320, height: 180 },
        fetchWindowIcons: !wantsSystemPicker
      });

      const picked = wantsSystemPicker
        ? sources[0] ?? null
        : await pickDisplaySource(mainWindow, sources);

      if (!picked) {
        log('screen share cancelled: no source selected');
        callback({});
        return;
      }
      log('screen share source:', JSON.stringify({ name: picked.name, of: sources.length, picker: wantsSystemPicker ? 'system' : 'in-app' }));
      callback({ video: picked });
    } catch (error) {
      log('screen share failed:', error);
      callback({});
    }
  });
};

const registerIpc = (): void => {
  ipcMain.handle('patch:source', async () => readFile(join(__dirname, 'patch.js'), 'utf8'));
  ipcMain.handle('capture:acquire', () => {
    if (config.mode !== 'capture') return;
    tap.start();
  });
  ipcMain.handle('capture:release', () => {
    tap.stop();
  });
  tap.onData((chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pcm', chunk);
    }
    debugChunks.push(chunk);
  });
};

const shutdown = async (code: number): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    tap.stop();
  } catch (error) {
    log('capture stop failed:', error);
  }

  if (config.debugPcm && debugChunks.length > 0) {
    try {
      const bytes = Buffer.concat(debugChunks);
      const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
      await writeWav(config.debugPcm, samples, 48000, 2);
      log('recorded PCM written to', config.debugPcm);
    } catch (error) {
      log('could not write debug PCM:', error);
    }
  }

  if (code === 0) {
    // A normal quit goes through app.quit() so a downloaded update can install on the way out.
    app.quit();
    return;
  }
  app.exit(code);
};

const bootstrap = async (): Promise<void> => {
  if (config.cleanup) {
    removeLegacyRouting(config.legacyStatePath, log);
    app.exit(0);
    return;
  }

  installPermissionHandlers(() => allowedOrigin);
  registerPickerIpc();
  registerIpc();

  const preloadPath = join(__dirname, 'preload.js');
  if (!existsSync(preloadPath)) log('WARNING: preload bundle missing at', preloadPath);

  const showWindow = (): void => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const attachWindow = (window: BrowserWindow): void => {
    window.webContents.on('preload-error', (_event, path, error) => {
      log('preload failed:', path, error);
    });
    window.on('close', (event) => {
      if (shuttingDown) return;
      log('window closed, staying in the tray');
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      mainWindow = null;
      // A page can destroy its own window; with a tray around, bring the client back.
      if (shuttingDown || !tray) return;
      log('window was destroyed, reopening it');
      const next = createWindow();
      void (currentServerUrl ? loadClient(currentServerUrl) : next.loadFile(connectPagePath));
    });
  };

  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      title: 'Sharkord',
      autoHideMenuBar: true,
      show: !config.selftest,
      backgroundColor: '#0b0d12',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false
      }
    });
    mainWindow = window;
    attachWindow(window);
    return window;
  };

  const window = createWindow();

  const connectPagePath = join(__dirname, 'connect.html');
  const serverConfigPath = join(app.getPath('userData'), 'config.json');

  // The window closes to the tray; the app keeps capturing and can be shown again from there.
  try {
    const iconPath = join(__dirname, 'icon.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Sharkord Desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Sharkord', click: showWindow },
        {
          label: 'Change server…',
          click: () => {
            showWindow();
            void mainWindow?.loadFile(connectPagePath);
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            void shutdown(0);
          }
        }
      ])
    );
    tray.on('click', showWindow);

    window.on('close', (event) => {
      if (shuttingDown) return;
      log('window closed, staying in the tray');
      event.preventDefault();
      window.hide();
    });
  } catch (error) {
    log('no system tray available, closing the window will quit:', error);
    window.on('closed', () => {
      void shutdown(0);
    });
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Server',
        submenu: [
          {
            label: 'Change server…',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => {
              void mainWindow?.loadFile(connectPagePath);
            }
          },
          {
            label: 'Check for updates…',
            click: () => {
              void checkForUpdatesNow(log);
            }
          },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' }
    ])
  );

  const loadClient = async (url: string): Promise<void> => {
    currentServerUrl = url;
    allowedOrigin = new URL(url).origin;
    const target = mainWindow;
    if (!target) return;
    await target.loadURL(url);
    log('client loaded:', url);

    if (config.mode !== 'capture') return;

    // The patch is injected asynchronously from the preload; give it a moment before judging.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const readiness = (await target.webContents.executeJavaScript(
        `({
          bridge: typeof window.sharkordDesktop,
          patched: !String(navigator.mediaDevices?.getDisplayMedia ?? '').includes('native code'),
          generator: typeof MediaStreamTrackGenerator === 'function'
        })`,
        true
      )) as { bridge: string; patched: boolean; generator: boolean };
      if (readiness.bridge === 'object' && readiness.patched) {
        log('screen-share audio ready:', JSON.stringify(readiness));
        break;
      }
      if (attempt === 9) {
        log('WARNING: screen-share audio patch is not installed:', JSON.stringify(readiness));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  ipcMain.handle('server:current', () => currentServerUrl);
  ipcMain.handle('server:submit', async (_event, raw: unknown) => {
    const normalized = normalizeServerUrl(typeof raw === 'string' ? raw : '');
    if (!normalized) {
      return { ok: false, error: 'Enter an address such as https://sharkord.example.com' };
    }
    try {
      saveServerUrl(serverConfigPath, normalized);
      await loadClient(normalized);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  if (config.selftest) {
    const pagePath = join(tmpdir(), 'sharkord-desktop-selftest.html');
    await writeFile(pagePath, '<!doctype html><meta charset="utf-8"><title>selftest</title><body>selftest</body>');
    await window.loadFile(pagePath);
    const result = await runSelftest({ config, tap, window, log });
    await shutdown(result.pass ? 0 : 1);
    return;
  }

  setupAutoUpdates({
    log,
    beforeInstall: () => {
      shuttingDown = true;
    }
  });

  const startUrl = config.url ?? readServerUrl(serverConfigPath);
  if (startUrl) {
    await loadClient(startUrl);
  } else {
    await window.loadFile(connectPagePath);
    log('no server chosen yet, showing the picker');
  }
};

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // With a tray icon around, losing the window must not quit the app.
  app.on('window-all-closed', () => {
    if (tray && !shuttingDown) return;
    void shutdown(0);
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown(0);
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  app.whenReady().then(bootstrap).catch((error) => {
    log('startup failed:', error);
    void shutdown(1);
  });
}
