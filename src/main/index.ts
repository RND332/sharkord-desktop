import { app, BrowserWindow, ipcMain, session } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { Capture } from './capture';
import { RoutingManager } from './routing';
import {
  getDefaultSink,
  listSinks,
  pickHardwareSink,
  realRunner,
  subscribe
} from './pipewire';
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

/** The real output device: everything the user hears except our own capture. */
const resolveHardwareSink = async (): Promise<string> => {
  if (config.hwSink) return config.hwSink;

  const [sinks, current] = await Promise.all([
    listSinks(realRunner),
    getDefaultSink(realRunner)
  ]);

  if (current && current !== config.sinkName && sinks.some((sink) => sink.name === current)) {
    return current;
  }

  const picked = pickHardwareSink(sinks, [config.sinkName]);
  if (!picked) throw new Error('no output device available to play captures back to');
  return picked;
};

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
    await routing?.stop();
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
    await routing.cleanupStale();
    log('cleanup done');
    app.exit(0);
    return;
  }

  hardwareSink = await resolveHardwareSink();
  // Our own playback never goes through the capture sink, so the voice channel is never re-broadcast.
  process.env.PULSE_SINK = hardwareSink;

  routing = new RoutingManager({
    statePath: config.statePath,
    sinkName: config.sinkName,
    hwSinkOverride: hardwareSink,
    log
  });
  await routing.start();
  log('routing up:', JSON.stringify(routing.state));

  installPermissionHandlers();
  registerIpc();
  subscribe(scheduleHealthCheck);

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Sharkord',
    autoHideMenuBar: true,
    show: !config.selftest,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  mainWindow = window;

  if (config.selftest) {
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
