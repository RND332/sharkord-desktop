import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { loadConfig } from './config';

const config = loadConfig();

const main = async () => {
  await app.whenReady();
  execFile('pactl', ['get-default-sink'], (err, stdout) => {
    console.log('[scaffold] default sink:', err ? `error: ${err.message}` : stdout.trim());
  });
  const win = new BrowserWindow({ width: 1200, height: 800, show: true });
  await win.loadURL('about:blank');
  console.log('[scaffold] config:', JSON.stringify(config));
};

void main();
