// Run after build with ulimit -c 0: electron test/renderer-crash-smoke.cjs
// Independent modes: --crash-loop, --readiness-crash, --picker-menu, --picker-tray, --picker-error,
// --startup-picker-crash, --error-picker-crash.
// Each run uses an isolated profile and local HTTP fixture.
const { app, BrowserWindow, Menu, Tray } = require('electron');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const profile = mkdtempSync(join(tmpdir(), 'sharkord-crash-smoke-'));
app.setPath('userData', join(profile, 'profile'));
app.setPath('appData', profile);
process.env.SHARKORD_TAP_NAME = `sharkord_crash_smoke_${process.pid}`;
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Crash regression fixture</title><body id="fixture">alive</body>');
});
const crashLoop = process.argv.includes('--crash-loop');
const readinessCrash = process.argv.includes('--readiness-crash');
let readinessInterrupted = false;
const interruptedPicker = process.argv.includes('--startup-picker-crash') ? 'startup'
  : process.argv.includes('--error-picker-crash') ? 'error' : null;
let pickerLoadInterrupted = false;
let pickerLoadRejected = false;
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function(path, options) {
  if (!interruptedPicker || pickerLoadInterrupted || !path.endsWith('connect.html')) {
    return loadFile.call(this, path, options);
  }
  pickerLoadInterrupted = true;
  expectedPickerUrl = require('node:url').pathToFileURL(path).href;
  if (options?.query?.error) expectedPickerUrl += `?error=${encodeURIComponent(options.query.error)}`;
  this.hide();
  // Hold the real native load's completion while its renderer is terminated. Electron
  // can leave loadFile pending after a crash; inject its rejecting variant from the
  // actual native termination signal, as in the readiness regression above.
  const terminated = new Promise((_resolve, reject) => {
    this.webContents.once('render-process-gone', () => {
      pickerLoadRejected = true;
      reject(new Error('picker load renderer terminated'));
    });
  });
  this.webContents.once('dom-ready', () => this.webContents.forcefullyCrashRenderer());
  const pending = loadFile.call(this, path, options).then(() => new Promise(resolve => {
    setTimeout(resolve, 10000);
  }), () => terminated); // Some versions reject the native load before reporting render-process-gone.
  return Promise.race([pending, terminated]);
};
const pickerMode = process.argv.includes('--picker-error') ? 'error'
  : process.argv.includes('--picker-tray') ? 'tray'
  : process.argv.includes('--picker-menu') ? 'menu' : null;
let pickerStage = 'client';
let expectedPickerUrl;
let trayMenu;
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(menu) {
  trayMenu = menu;
  return setContextMenu.call(this, menu);
};
let crashCount = 0;
let crashed = false;
let finished = false;
let deadline;
const finish = (code, message) => {
  if (finished) return;
  finished = true;
  console.log(message);
  clearTimeout(deadline);
  server.close();
  // app.exit destroys windows; the application's tray reopen handler must not run during test teardown.
  for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('closed');
  app.exit(code);
};
app.on('web-contents-created', (_event, contents) => {
  if (readinessCrash) {
    const execute = contents.executeJavaScript.bind(contents);
    contents.executeJavaScript = (source, ...args) => {
      if (!readinessInterrupted && source.includes('bridge: typeof window.sharkordDesktop')) {
        readinessInterrupted = true;
        crashed = true;
        BrowserWindow.fromWebContents(contents).hide();
        // Keep a real renderer evaluation pending, then destroy that renderer.
        const pending = execute(`new Promise(resolve => setTimeout(() => resolve(${source}), 10000))`, ...args);
        // Electron versions differ: a terminated evaluation can reject or remain pending.
        // Model the rejecting variant using the actual native renderer termination signal.
        const terminated = new Promise((_resolve, reject) => {
          contents.once('render-process-gone', () => reject(new Error('readiness renderer terminated')));
        });
        setTimeout(() => contents.forcefullyCrashRenderer(), 50);
        return Promise.race([pending, terminated]);
      }
      return execute(source, ...args);
    };
  }
  contents.on('did-finish-load', async () => {
    if (readinessCrash && !readinessInterrupted) return;
    if (interruptedPicker) {
      if (!pickerLoadRejected) return;
      try {
        const window = BrowserWindow.fromWebContents(contents);
        const actual = new URL(contents.getURL());
        const expected = new URL(expectedPickerUrl);
        if (actual.protocol !== expected.protocol || actual.pathname !== expected.pathname ||
            actual.searchParams.toString() !== expected.searchParams.toString()) {
          throw new Error(`interrupted picker recovery changed route/error: ${actual.href} != ${expected.href}`);
        }
        const state = await contents.executeJavaScript(`(async () => ({
          form: !!document.getElementById('form'),
          remembered: await window.sharkordDesktop.currentServer(),
          error: new URL(location.href).searchParams.get('error')
        }))()`);
        if (!state.form) throw new Error('recovered picker is not usable');
        if (interruptedPicker === 'error' && (!state.error || !state.remembered?.startsWith('http://127.0.0.1:'))) {
          throw new Error('startup connection failure state lost');
        }
        if (interruptedPicker === 'startup' && state.remembered) throw new Error('startup picker unexpectedly selected a server');
        if (window.isVisible()) throw new Error('interrupted picker recovery showed hidden window');
        // Give the obsolete bootstrap rejection time to reach its shutdown handler.
        await new Promise(resolve => setTimeout(resolve, 500));
        finish(0, `PASS: ${interruptedPicker} picker interrupted by native crash recovered without bootstrap shutdown; picker usable; route/error retained; window stayed hidden`);
      } catch (error) { finish(1, `FAIL: ${error.message}`); }
      return;
    }
    if (pickerMode) {
      const window = BrowserWindow.fromWebContents(contents);
      try {
        if (pickerStage === 'client') {
          if (!contents.getURL().startsWith('http://127.0.0.1:')) return;
          pickerStage = 'opening';
          // Start after the normal client readiness probe, exercising real menu/IPC paths.
          setTimeout(async () => {
            try {
              if (pickerMode === 'error') {
                await new Promise(resolve => server.close(resolve));
                await contents.executeJavaScript('void window.sharkordDesktop.submitServer(location.href)');
              } else {
                const menu = pickerMode === 'tray' ? trayMenu : Menu.getApplicationMenu().items[0].submenu;
                const change = menu?.items.find(item => item.label === 'Change server…');
                if (!change) throw new Error('Change server menu item missing');
                change.click(change, window);
              }
            } catch (error) { finish(1, `FAIL: ${error.message}`); }
          }, 500);
        } else if (pickerStage === 'opening') {
          if (!contents.getURL().includes('/connect.html')) {
            if (pickerMode === 'error') return; // Chromium's failed-navigation error document finishes first.
            throw new Error('picker did not open');
          }
          expectedPickerUrl = contents.getURL();
          if (pickerMode === 'error' && !new URL(expectedPickerUrl).searchParams.has('error')) {
            throw new Error('connection failure did not open the error picker');
          }
          pickerStage = 'crashed';
          window.hide();
          setTimeout(() => contents.forcefullyCrashRenderer(), 500);
        } else {
          if (contents.getURL() !== expectedPickerUrl) throw new Error('recovery left the active picker route');
          const usable = await contents.executeJavaScript(`(async () => ({
            form: !!document.getElementById('form'),
            remembered: await window.sharkordDesktop.currentServer()
          }))()`);
          if (!usable.form || !usable.remembered?.startsWith('http://127.0.0.1:')) {
            throw new Error('picker not usable or remembered server lost');
          }
          if (window.isVisible()) throw new Error('picker recovery showed the hidden window');
          finish(0, `PASS: ${pickerMode} picker route recovered; remembered server retained; window stayed hidden`);
        }
      } catch (error) { finish(1, `FAIL: ${error.message}`); }
      return;
    }
    if (!contents.getURL().startsWith('http://127.0.0.1:')) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (crashLoop) {
      clearTimeout(deadline);
      if (crashCount === 4) return finish(1, 'FAIL: recovery entered a rapid crash/reload loop');
      window.hide();
      setTimeout(() => {
        crashCount += 1;
        deadline = setTimeout(() => {
          if (crashCount === 4 && contents.isCrashed()) finish(0, 'PASS: recovered three times and stopped the rapid crash loop');
          else finish(1, 'FAIL: recovery stopped before the allowed three attempts');
        }, 2000);
        contents.forcefullyCrashRenderer();
      }, 500);
      return;
    }
    if (!crashed) {
      crashed = true;
      window.hide();
      // Let the application's initial readiness probe finish first.
      setTimeout(() => {
        deadline = setTimeout(() => finish(1, 'FAIL: crashed renderer never reloaded the client'), 6000);
        console.log('Triggering a real renderer crash while the window is hidden');
        contents.forcefullyCrashRenderer();
      }, 500);
    } else {
      try {
        const alive = await contents.executeJavaScript('document.getElementById("fixture")?.textContent');
        if (alive !== 'alive') throw new Error('fixture did not reload');
        if (window.isVisible()) throw new Error('recovery unexpectedly showed the hidden window');
        if (readinessCrash) await new Promise(resolve => setTimeout(resolve, 500));
        finish(0, readinessCrash
          ? 'PASS: crash during initial readiness recovered without bootstrap shutdown; fixture usable; window stayed hidden'
          : 'PASS: real renderer crash recovered; fixture usable; hidden window stayed hidden');
      } catch (error) { finish(1, `FAIL: ${error.message}`); }
    }
  });
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  if (interruptedPicker !== 'startup') process.argv.push(`--url=${url}`);
  if (interruptedPicker === 'error') await new Promise(resolve => server.close(resolve));
  require(process.env.SHARKORD_SMOKE_MAIN || '../dist/main.js');
});
setTimeout(() => finish(1, 'FAIL: smoke test startup timed out'), 15000).unref();
