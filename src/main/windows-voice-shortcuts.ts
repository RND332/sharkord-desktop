import { app } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type VoiceShortcutCode = 'KeyM' | 'KeyD';

export const startWindowsVoiceShortcuts = (
  onShortcut: (code: VoiceShortcutCode) => void,
  log: (message: string, ...details: unknown[]) => void,
  platform: NodeJS.Platform = process.platform
): (() => void) => {
  if (platform !== 'win32') return () => {};
  const binary = app.isPackaged
    ? join(process.resourcesPath, 'native', 'win-voice-shortcuts.exe')
    : join(app.getAppPath(), 'native', 'out', 'win-voice-shortcuts.exe');
  const child = spawn(binary, [], { windowsHide: true, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  let stopped = false;
  lines.on('line', (line: string) => {
    if (stopped) return;
    if (line === 'KeyM' || line === 'KeyD') onShortcut(line);
    else log('Windows voice shortcuts:', line);
  });
  child.stderr.on('data', (data: Buffer) => log('Windows voice shortcuts:', data.toString().trim()));
  child.once('error', (error) => log('Windows voice shortcut helper failed:', error));
  child.once('exit', (code) => {
    lines.close();
    if (!stopped) log('Windows voice shortcut helper stopped:', code);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    lines.close();
    child.stdin.end();
    child.kill();
  };
};
