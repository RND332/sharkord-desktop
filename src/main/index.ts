import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { Capture } from './capture';
import { RoutingManager } from './routing';
import { subscribe } from './pipewire';
import { runSelftest } from './selftest';
import { writeWav } from './wav';

const config = loadConfig();
const log = (...parts: unknown[]): void => {
  console.log('[sharkord-desktop]', ...parts);
};

const capture = new Capture({ sinkName: config.sinkName, log });

let routing: RoutingManager;
let mainWindow: BrowserWindow | null = null;
let hardwareSink: string | null = null;
let shuttingDown = false;
const debugChunks: Buffer[] = [];

const installPermissionHandlers = (): void => {
  const origin = new URL(config.url).origin;
  const allowed: Record<string, true> = {
    media: true,
    'display-capture': true,
    fullscreen: true,
    'clipboard-sanitized-write': true,
    notifications: true
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const fromApp = (contents?.getURL() ?? '').startsWith(origin);
    callback(fromApp && allowed[permission] === true);
  });

  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return requestingOrigin.startsWith(origin) && allowed[permission] === true;
  });

  // Electron has no default screen picker on Linux (getDisplayMedia rejects with NotSupportedError).
  // On Wayland this call opens the desktop's own picker — Hyprland's share dialog — and the first
  // source it returns is what the user selected there.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      });
      const picked = sources[0];
      if (!picked) {
        log('screen share cancelled: no source selected');
        callback({});
        return;
      }
      log('screen share source:', JSON.stringify({ name: picked.name, of: sources.length }));
      callback({ video: picked });
    } catch (error) {
      log('screen share failed:', error);
      callback({});
    }
  });
};

let healthTimer: NodeJS.Timeout | null = null;
const scheduleHealthCheck = (): void => {
  if (healthTimer || shuttingDown) return;
  healthTimer = setTimeout(() => {
    healthTimer = null;
    routing.ensureHealthy().catch((error) => log('health check failed:', error));
  }, 500);
};

const registerIpc = (): void => {
  ipcMain.handle('patch:source', async () => readFile(join(__dirname, 'patch.js'), 'utf8'));
  ipcMain.handle('capture:acquire', () => {
    capture.start();
  });
  ipcMain.handle('capture:release', () => {
    capture.stop();
  });
  capture.onData((chunk) => {
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
    capture.stop();
  } catch (error) {
    log('capture stop failed:', error);
  }
  if (config.debugPcm && debugChunks.length > 0) {
    try {
      const interleaved = new Float32Array(
        Buffer.concat(debugChunks).buffer,
        0,
        Math.floor(debugChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) / 4)
      );
      await writeWav(config.debugPcm, interleaved, 48000, 2);
      log('captured PCM written to', config.debugPcm);
    } catch (error) {
      log('could not write debug PCM:', error);
    }
  }
  try {
    routing?.stopSync();
  } catch (error) {
    log('routing teardown failed:', error);
  }
  app.exit(code);
};

const bootstrap = async (): Promise<void> => {
  routing = new RoutingManager({
    statePath: config.statePath,
    sinkName: config.sinkName,
    hwSinkOverride: config.hwSink,
    log
  });

  if (config.cleanup) {
    if (config.mode === 'capture') await routing.cleanupStale();
    log('cleanup done');
    app.exit(0);
    return;
  }

  if (config.mode === 'capture') {
    const routingState = await routing.start();
    hardwareSink = routingState.hwSink;
    // Our own playback never goes through the capture sink, so the voice channel is never re-broadcast.
    if (hardwareSink) process.env.PULSE_SINK = hardwareSink;
    log('routing up:', JSON.stringify(routingState));
  } else {
    log(`${process.platform}: no PipeWire routing — screen-share audio follows the platform`);
  }

  installPermissionHandlers();
  registerIpc();
  if (config.mode === 'capture') subscribe(scheduleHealthCheck);

  const preloadPath = join(__dirname, 'preload.js');
  if (!existsSync(preloadPath)) log('WARNING: preload bundle missing at', preloadPath);

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

  window.webContents.on('preload-error', (_event, path, error) => {
    log('preload failed:', path, error);
  });
  mainWindow = window;

  if (config.selftest) {
    if (!hardwareSink) throw new Error('selftest needs a playback device');
    const pagePath = join(tmpdir(), 'sharkord-desktop-selftest.html');
    await writeFile(pagePath, '<!doctype html><meta charset="utf-8"><title>selftest</title><body>selftest</body>');
    await window.loadFile(pagePath);
    const result = await runSelftest({
      config,
      routing,
      capture,
      window,
      hardwareSink,
      log
    });
    await shutdown(result.pass ? 0 : 1);
    return;
  }

  await window.loadURL(config.url);
  log('client loaded:', config.url);

  if (config.mode !== 'capture') {
    return;
  }

  // The patch is injected asynchronously from the preload; give it a moment before judging.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const readiness = (await window.webContents.executeJavaScript(
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

  window.on('closed', () => {
    void shutdown(0);
  });
};

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown(0);
  });

  app.on('window-all-closed', () => {
    void shutdown(0);
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  app.whenReady().then(bootstrap).catch((error) => {
    log('startup failed:', error);
    void shutdown(1);
  });
}
