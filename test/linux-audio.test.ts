import { describe, expect, it, vi } from 'vitest';
import { resolveLinuxAudioTarget } from '../src/main/linux-audio';

describe('Linux audio selection', () => {
  it.each(['window:0:0', 'window:001:0', 'window:123x:0', 'window:123:0:extra', 'screen:bogus:0', 'unknown:123:0'])('rejects malformed source %s without running a command', async (id) => {
    const runner = vi.fn(async () => '_NET_WM_PID(CARDINAL) = 10845');
    expect(await resolveLinuxAudioTarget({ id, name: 'Chrome' }, { wayland: false, runner })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(['_NET_WM_PID:  not found.', '_NET_WM_PID(CARDINAL) = 0', '_NET_WM_PID(CARDINAL) = 1, 10845', '_NET_WM_PID(CARDINAL) = 999999999999999999999'])('fails closed for unresolved X11 ownership: %s', async (output) => {
    expect(await resolveLinuxAudioTarget({ id: 'window:123:0', name: 'Chrome' }, { wayland: false, runner: async () => output })).toBeNull();
  });
  it('never automatically uses system audio on unsupported Wayland compositors', async () => {
    const runner = async () => { throw new Error('hyprctl unavailable'); };
    expect(await resolveLinuxAudioTarget({ id: 'screen:1:0', name: 'Screen 1' }, { wayland: true, runner, choose: async () => 0 })).toBeNull();
    expect(await resolveLinuxAudioTarget({ id: 'screen:1:0', name: 'Screen 1' }, { wayland: true, runner, choose: async () => 2 })).toBeNull();
  });
  it('allows all-other-apps audio only after explicit entire-screen confirmation on Wayland', async () => {
    expect(await resolveLinuxAudioTarget({ id: 'window:1:0', name: 'Screen 1' }, { wayland: true, runner: async () => '[]', choose: async () => 1 })).toEqual({ kind: 'screen' });
  });
  it('requires explicit application choice for opaque portal selections and validates the choice', async () => {
    const runner = vi.fn(async () => JSON.stringify([
      { mapped: true, pid: 10845, title: 'YouTube', class: 'google-chrome' },
      { mapped: true, pid: 999, title: 'YouTube', class: 'other' }
    ]));
    const choose = vi.fn(async () => 2);
    expect(await resolveLinuxAudioTarget({ id: 'screen:1:0', name: 'Screen 1' }, { wayland: true, runner, choose }))
      .toEqual({ kind: 'application', processId: 10845 });
    expect(choose).toHaveBeenCalledWith([
      { processId: 10845, title: 'YouTube', appClass: 'google-chrome' },
      { processId: 999, title: 'YouTube', appClass: 'other' }
    ]);
    expect(await resolveLinuxAudioTarget({ id: 'window:1:0', name: 'YouTube' }, { wayland: true, runner, choose: async () => 99 }))
      .toBeNull();
  });
  it('keeps full-screen audio on X11 but never infers it from an opaque Wayland screen ID', async () => {
    const runner = vi.fn(async () => '');
    expect(await resolveLinuxAudioTarget({ id: 'screen:0:0', name: 'Screen 1' }, { wayland: false, runner }))
      .toEqual({ kind: 'screen' });
    expect(await resolveLinuxAudioTarget({ id: 'screen:0:0', name: 'Screen 1' }, { wayland: true, runner }))
      .toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
  it('maps an X11 window to its PID rather than all playback', async () => {
    const runner = vi.fn(async () => '_NET_WM_PID(CARDINAL) = 10845\n');
    expect(await resolveLinuxAudioTarget({ id: 'window:123:0', name: 'Chrome' }, { wayland: false, runner }))
      .toEqual({ kind: 'application', processId: 10845 });
    expect(runner).toHaveBeenCalledWith('xprop', ['-id', '123', '_NET_WM_PID']);
  });
});
