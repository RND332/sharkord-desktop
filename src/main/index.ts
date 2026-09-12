import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  Tray
} from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { release as osRelease } from 'node:os';
import { loadConfig } from './config';
import { describeEnvironment, log, readLogTail } from './logger';
import { removeLegacyRouting } from './legacy';
import { pickDisplaySource, registerPickerIpc } from './picker';
import { normalizeServerUrl, readServerUrl, saveServerUrl } from './server-config';
import { runSelftest } from './selftest';
import { TapCapture } from './tap';
import { WindowsCapture, helperExists } from './windows-capture';
import { checkForUpdatesNow, installPendingUpdateSilently, setupAutoUpdates } from './updater';
import { writeWav } from './wav';

const config = loadConfig();

let warnedAboutEcho = false;

const tap = new TapCapture({ tapName: config.tapName, log });

/**
 * Windows: the helper activates WASAPI process loopback in exclude mode for our own process tree,
 * which Chromium itself refuses to do below Windows 11. Everywhere else the PipeWire tap does it.
 */
const windowsCapture = process.platform === 'win32' && helperExists() ? new WindowsCapture({ log }) : null;
const captureSource = windowsCapture ?? (config.mode === 'capture' ? tap : null);
/** Passed to the page so it knows where share audio comes from. */
const captureKind = captureSource === windowsCapture ? 'windows' : captureSource ? 'pipewire' : 'none';

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
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
    const wantsSystemPicker = process.env.SHARKORD_PICKER === 'system' || (wayland && process.env.SHARKORD_PICKER !== 'inapp');

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        // Thumbnails are only needed for our own picker; the portal dialog draws its own.
        thumbnailSize: wantsSystemPicker ? { width: 0, height: 0 } : { width: 320, height: 180 },
        fetchWindowIcons: !wantsSystemPicker
      });

      log('display sources:', JSON.stringify({ count: sources.length, picker: wantsSystemPicker ? 'system' : 'in-app' }));
      if (sources.length === 0) {
        void dialog.showMessageBox({
          type: 'warning',
          title: 'Nothing to share',
          message: 'The system reported no capturable screen or window.'
        });
      }

      const picked = wantsSystemPicker
        ? sources[0] ?? null
        : await pickDisplaySource(mainWindow, sources, log);

      if (!picked) {
        log('screen share cancelled: no source selected');
        callback({});
        return;
      }
      // The page owns the audio decision: it replaces whatever the browser captured with our own
      // capture where one exists, and otherwise only keeps the browser's audio if a probe proves the
      // voice channel is not in it. Linux is excluded because Chromium has no system audio there.
      const haveOwnCapture = captureSource !== null;
      const wantsBrowserAudio =
        request.audioRequested &&
        process.platform !== 'linux' &&
        process.env.SHARKORD_WINDOWS_AUDIO !== 'off';
      log(
        'screen share source:',
        JSON.stringify({
          name: picked.name,
          of: sources.length,
          picker: wantsSystemPicker ? 'system' : 'in-app',
          audio: haveOwnCapture
            ? 'our own capture, browser audio as a fallback'
            : wantsBrowserAudio
              ? 'browser loopback'
              : request.audioRequested
                ? 'unavailable'
                : 'not requested',
          helper: windowsCapture ? 'win-audio-capture.exe' : undefined,
          os: process.platform === 'win32' ? osRelease() : undefined
        })
      );
      callback(wantsBrowserAudio ? { video: picked, audio: 'loopback' } : { video: picked });
    } catch (error) {
      log('screen share failed:', error);
      callback({});
    }
  });
};

const registerIpc = (): void => {
  ipcMain.handle('patch:source', async () => readFile(join(__dirname, 'patch.js'), 'utf8'));
  ipcMain.handle('capture:acquire', async () => {
    // Rejecting matters: the page treats a resolved call as "audio is coming".
    if (!captureSource) throw new Error('this platform has no capture of its own');
    captureSource.start();
    // A helper that dies at startup (no exclude mode on this Windows build) must not look like one
    // that works, or the share would carry silence instead of falling back to system audio.
    if (windowsCapture) await windowsCapture.waitUntilCapturing();
  });
  ipcMain.handle('capture:release', () => {
    captureSource?.stop();
  });
  captureSource?.onData((chunk: Buffer) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pcm', chunk);
    }
    debugChunks.push(chunk);
  });
};

const shutdown = async (code: number, options: { quit?: boolean } = {}): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (code ${code}${options.quit === false ? ', exiting directly' : ''})`);
  try {
    captureSource?.stop();
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
    // A downloaded update is swapped in on the way out — silently, and without relaunching.
    if (installPendingUpdateSilently(log)) {
      log('installing the downloaded update on the way out');
      return;
    }
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
    let mentionedTray = false;
    window.on('close', (event) => {
      if (shuttingDown) return;
      log('window closed, staying in the tray');
      event.preventDefault();
      window.hide();
      if (!mentionedTray && Notification.isSupported()) {
        mentionedTray = true;
        log('telling the user the app is still in the tray');
        new Notification({
          title: 'Sharkord is still running',
          body: 'Closing the window keeps it in the tray. Quit from the tray menu.'
        }).show();
      }
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
        backgroundThrottling: false,
        // The page reads this to know whether share audio comes from us or the browser.
        additionalArguments: [`--sharkord-capture=${captureKind}`]
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

    let mentionedTray = false;
    window.on('close', (event) => {
      if (shuttingDown) return;
      log('window closed, staying in the tray');
      event.preventDefault();
      window.hide();
      if (!mentionedTray && Notification.isSupported()) {
        mentionedTray = true;
        log('telling the user the app is still in the tray');
        new Notification({
          title: 'Sharkord is still running',
          body: 'Closing the window keeps it in the tray. Quit from the tray menu.'
        }).show();
      }
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
            label: 'Share a screen…',
            click: () => {
              void (async () => {
                try {
                  const sources = await desktopCapturer.getSources({
                    types: ['screen', 'window'],
                    thumbnailSize: { width: 320, height: 180 },
                    fetchWindowIcons: true
                  });
                  log('picker test:', JSON.stringify({ count: sources.length }));
                  if (sources.length === 0) {
                    await dialog.showMessageBox({
                      type: 'warning',
                      title: 'Nothing to share',
                      message: 'The system reported no capturable screen or window.'
                    });
                    return;
                  }
                  const picked = await pickDisplaySource(mainWindow, sources, log);
                  await dialog.showMessageBox({
                    type: 'info',
                    title: 'Picker test',
                    message: picked ? `You picked: ${picked.name}` : 'Cancelled'
                  });
                } catch (error) {
                  log('picker test failed:', error);
                  await dialog.showMessageBox({
                    type: 'error',
                    title: 'Picker test failed',
                    message: error instanceof Error ? error.message : String(error)
                  });
                }
              })();
            }
          },
          {
            label: 'Show diagnostics…',
            click: () => {
              void (async () => {
                const { response } = await dialog.showMessageBox({
                  type: 'info',
                  title: 'Diagnostics',
                  message: 'Sharkord Desktop',
                  detail: `${describeEnvironment()}\n\n${readLogTail(40)}`,
                  buttons: ['Copy to clipboard', 'Close'],
                  defaultId: 1,
                  cancelId: 1
                });
                if (response === 0) {
                  clipboard.writeText(`${describeEnvironment()}\n\n${readLogTail(300)}`);
                  log('diagnostics copied to the clipboard');
                }
              })();
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

    // The patch is injected asynchronously from the preload; give it a moment before judging.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const readiness = (await target.webContents.executeJavaScript(
        `({
          bridge: typeof window.sharkordDesktop,
          platform: window.sharkordDesktop?.platform ?? 'missing',
          capture: window.sharkordDesktop?.captureSource ?? 'missing',
          badge: document.querySelector('[data-sharkord-desktop-version]')?.textContent ?? 'missing',
          patched: navigator.mediaDevices?.getDisplayMedia?.__sharkordDesktop === true,
          source: String(navigator.mediaDevices?.getDisplayMedia ?? '').slice(0, 120),
          generator: typeof MediaStreamTrackGenerator === 'function'
        })`,
        true
      )) as {
        bridge: string;
        platform: string;
        capture: string;
        badge: string;
        patched: boolean;
        source: string;
        generator: boolean;
      };
      if (readiness.bridge === 'object' && readiness.patched) {
        log('screen-share audio ready:', JSON.stringify(readiness));
        if (readiness.capture !== captureKind) {
          log(`WARNING: expected the "${captureKind}" capture path, got "${readiness.capture}"`);
          log('injected getDisplayMedia source:', readiness.source);
          if (Notification.isSupported()) {
            new Notification({
              title: 'Screen-share audio is not active',
              body: 'The capture path did not load. Screen shares will be silent — check Server → Show diagnostics…'
            }).show();
          }
        }
        break;
      }
      if (attempt === 9) {
        log('WARNING: screen-share audio patch is not installed:', JSON.stringify(readiness));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  ipcMain.handle('capture:mode', (_event, info: unknown) => {
    const details = (info ?? {}) as { mode?: string; echoTest?: string };
    log('page capture mode:', JSON.stringify(details));

    // A new share always gets its own verdict, so an old warning does not silence a new one.
    if (details.mode === 'captured-pcm') {
      warnedAboutEcho = false;
      return true;
    }

    if (details.mode === 'system-audio-echo' && !warnedAboutEcho) {
      warnedAboutEcho = true;
      log(
        "WARNING: the system-audio capture provably carried this app's own playback (16 kHz probe, " +
          `${details.echoTest}), so the share was left silent rather than sending the voice channel back to the channel. ` +
          'Playing Sharkord through a different device than the one being shared — client Settings → Devices → playback device — ' +
          'makes system audio usable again.'
      );
      if (Notification.isSupported()) {
        new Notification({
          title: 'Sharing video only',
          body: 'Your viewers would have heard themselves, so this share has no sound. Play Sharkord through a different device (Settings → Devices → playback device) to share with audio.'
        }).show();
      }
    }

    if (details.mode === 'system-audio-unavailable' && !warnedAboutEcho) {
      warnedAboutEcho = true;
      log(
        'WARNING: this share could not prove the captured audio excludes this app, so it stays video-only ' +
          '(no echo). Check Server → Show diagnostics… for the capture log; playing Sharkord through a device that is ' +
          'not being shared makes system audio usable again.'
      );
      if (Notification.isSupported()) {
        new Notification({
          title: 'Sharing video only',
          body: 'System audio could not be captured without your own voice in it, so this share has no sound. See Server → Show diagnostics… for details.'
        }).show();
      }
    }
    return true;
  });
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

  if (process.env.SHARKORD_DEBUG_QUIT_AFTER) {
    setTimeout(() => void shutdown(0), Number(process.env.SHARKORD_DEBUG_QUIT_AFTER) * 1000);
  }
  if (process.env.SHARKORD_DEBUG_APP_QUIT_AFTER) {
    setTimeout(() => app.quit(), Number(process.env.SHARKORD_DEBUG_APP_QUIT_AFTER) * 1000);
  }

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

  app.on('before-quit', () => log('event: before-quit'));
  app.on('will-quit', () => log('event: will-quit'));
  app.on('quit', () => log('event: quit'));

  // With a tray icon around, losing the window must not quit the app.
  app.on('window-all-closed', () => {
    log('event: window-all-closed');
    if (tray && !shuttingDown) return;
    void shutdown(0);
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    // We just cancelled this quit, so we must finish the job ourselves.
    void shutdown(0, { quit: false });
  });

  process.on('SIGINT', () => void shutdown(0, { quit: false }));
  process.on('SIGTERM', () => void shutdown(0, { quit: false }));

  app.whenReady().then(bootstrap).catch((error) => {
    log('startup failed:', error);
    void shutdown(1);
  });
}
