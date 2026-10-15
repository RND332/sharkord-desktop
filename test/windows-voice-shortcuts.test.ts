import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ spawn: vi.fn(), app: { isPackaged: false, getAppPath: () => '/fixture' } }));
vi.mock('node:child_process', () => ({ spawn: native.spawn }));
vi.mock('electron', () => ({ app: native.app }));

class HelperProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn();
}

let child: HelperProcess;
let stop: (() => void) | undefined;
beforeEach(() => {
  child = new HelperProcess();
  native.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { stop?.(); stop = undefined; });

describe('Windows voice shortcut helper', () => {
  it('forwards deafen but never treats diagnostics as commands', async () => {
    const { startWindowsVoiceShortcuts } = await import('../src/main/windows-voice-shortcuts');
    const onShortcut = vi.fn();
    stop = startWindowsVoiceShortcuts(onShortcut, vi.fn(), 'win32');

    child.stdout.write('REGISTERED Ctrl+Shift+D\nKeyD\nKeyQ\nREADY\n');

    expect(onShortcut).toHaveBeenCalledExactlyOnceWith('KeyD');
  });

  it.each(['linux', 'darwin'] as const)('leaves %s shortcuts to the existing platform setup', async (platform) => {
    const { startWindowsVoiceShortcuts } = await import('../src/main/windows-voice-shortcuts');
    stop = startWindowsVoiceShortcuts(vi.fn(), vi.fn(), platform);
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('stops the owned process once and discards late commands', async () => {
    const { startWindowsVoiceShortcuts } = await import('../src/main/windows-voice-shortcuts');
    const onShortcut = vi.fn();
    stop = startWindowsVoiceShortcuts(onShortcut, vi.fn(), 'win32');
    stop();
    stop();
    child.stdout.write('KeyM\n');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdin.writableEnded).toBe(true);
    expect(onShortcut).not.toHaveBeenCalled();
  });

  it('reports a missing helper without crashing the client', async () => {
    const { startWindowsVoiceShortcuts } = await import('../src/main/windows-voice-shortcuts');
    const log = vi.fn();
    stop = startWindowsVoiceShortcuts(vi.fn(), log, 'win32');
    const error = new Error('spawn ENOENT');
    child.emit('error', error);
    expect(log).toHaveBeenCalledWith('Windows voice shortcut helper failed:', error);
  });

  it('forwards complete microphone events across split stdout chunks', async () => {
    const { startWindowsVoiceShortcuts } = await import('../src/main/windows-voice-shortcuts');
    const onShortcut = vi.fn();
    stop = startWindowsVoiceShortcuts(onShortcut, vi.fn(), 'win32');

    child.stdout.write('Key');
    expect(onShortcut).not.toHaveBeenCalled();
    child.stdout.write('M\n');

    expect(onShortcut).toHaveBeenCalledExactlyOnceWith('KeyM');
    expect(native.spawn).toHaveBeenCalledWith(expect.stringContaining('win-voice-shortcuts.exe'), [], expect.objectContaining({ windowsHide: true, stdio: 'pipe' }));
  });
});
