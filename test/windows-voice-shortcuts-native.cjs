const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const exec = promisify(execFile);
if (process.platform !== 'win32') throw new Error('This native test requires Windows');
const baseline = process.env.SHARKORD_SHORTCUT_BASELINE === '1';
app.setPath('userData', join(app.getAppPath(), 'profile'));
app.setPath('appData', join(app.getAppPath(), 'app-data'));
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Sharkord shortcut receiver</title><p>Keyboard fixture</p>
<script>window.voiceKeys=[];window.addEventListener('keydown',event=>{
if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&['KeyM','KeyD'].includes(event.code)){
event.preventDefault();if(!event.repeat)window.voiceKeys.push(event.code);
}},true);</script>`);
});
let running = false;
let finished = false;
const result = { platform: process.platform, baseline, phases: [] };
const finish = (code, error) => {
  if (finished) return;
  finished = true;
  if (error) { result.error = error.stack || String(error); console.error(result.error); }
  writeFileSync(process.env.SHARKORD_SHORTCUT_RESULT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  server.close();
  if (code === 0) app.quit();
  else {
    for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('closed');
    app.exit(code);
  }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-finish-load', async () => {
    if (running || !contents.getURL().startsWith('http://127.0.0.1:')) return;
    running = true;
    try {
      const window = BrowserWindow.fromWebContents(contents);
      await pause(800);
      const send = async (phase, mode) => {
        const before = await contents.executeJavaScript('window.voiceKeys.length');
        const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-File', join(__dirname, 'windows-shortcut-input.ps1'), '-Mode', mode, '-TargetWindow', handle], { timeout: 20000, windowsHide: true });
        const input = JSON.parse(stdout.trim());
        assert.equal(input.foregroundVerified, true);
        await pause(300);
        const keys = await contents.executeJavaScript(`window.voiceKeys.slice(${before})`);
        result.phases.push({ phase, keys, input });
        if (baseline) {
          assert.deepEqual(keys, []);
          result.expectedMissingGlobalBindings = true;
          finish(42);
          return;
        }
        assert.deepEqual(keys, ['KeyM', 'KeyD'], `${phase}: exactly one event per held combination`);
      };
      window.hide();
      await send('hidden-background', 'background');
      if (baseline) return;
      assert.equal(window.isVisible(), false, 'hotkey raised the hidden client');
      window.show();
      window.minimize();
      await pause(300);
      await send('minimized-background', 'background');
      assert.equal(window.isMinimized(), true, 'hotkey restored the minimized client');
      window.restore();
      window.show();
      window.focus();
      await pause(500);
      await send('focused-no-duplicate', 'foreground');
      result.verified = true;
      finish(0);
    } catch (error) { finish(1, error); }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.argv.push(`--url=http://127.0.0.1:${server.address().port}`);
  require(process.env.SHARKORD_SHORTCUT_MAIN);
});
setTimeout(() => finish(1, new Error('Native shortcut test timed out')), 60000).unref();
