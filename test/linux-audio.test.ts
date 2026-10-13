import { describe, expect, it, vi } from 'vitest';
import { bindPortalCaptureTarget, resolveLinuxAudioTarget } from '../src/main/linux-audio';

const selection = {
  generation: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
  sourceType: 2 as const,
  windowClass: 'google-chrome',
  windowHandle: '812',
  pipewireSerial: '901'
};
const identity = (pid: number) => ({ pid, startTime: `start-${pid}` });
const captureGraph = (serial: string, pid = 2369069) => JSON.stringify([
  { id: 502, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Video/Source', 'object.serial': serial } } },
  { id: 710, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Stream/Input/Video', 'application.process.id': pid, 'node.driver-id': 502 } } }
]);

describe('Linux audio selection', () => {
  it.each(['window:0:0', 'window:001:0', 'window:123x:0', 'window:123:0:extra', 'screen:bogus:0', 'unknown:123:0'])(
    'rejects malformed source %s without running a command', async (id) => {
      const runner = vi.fn(async () => '_NET_WM_PID(CARDINAL) = 10845');
      expect(await resolveLinuxAudioTarget({ id, name: 'Chrome' }, { wayland: false, runner })).toBeNull();
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each(['_NET_WM_PID:  not found.', '_NET_WM_PID(CARDINAL) = 0', '_NET_WM_PID(CARDINAL) = 1, 10845', '_NET_WM_PID(CARDINAL) = 999999999999999999999'])(
    'fails closed for unresolved X11 ownership: %s', async (output) => {
      expect(await resolveLinuxAudioTarget(
        { id: 'window:123:0', name: 'Chrome' },
        { wayland: false, runner: async () => output, readIdentity: () => null }
      )).toBeNull();
    }
  );

  it('keeps unsupported Wayland selections video-only without guessing or asking another question', async () => {
    const runner = vi.fn(async () => JSON.stringify([{ mapped: true, pid: 10845, class: 'google-chrome' }]));
    expect(await resolveLinuxAudioTarget({ id: 'screen:1:0', name: 'Screen 1' }, { wayland: true, runner })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses a pre-consent continuity witness instead of resolving the latest same-class client', async () => {
    const witness = { isActive: true, resolveWindowClass: vi.fn(async () => null) };
    const runner = vi.fn(async () => JSON.stringify([
      { mapped: true, address: '0x2', pid: 2222, class: 'google-chrome' }
    ]));
    const target = await resolveLinuxAudioTarget(
      { id: 'screen:opaque:portal-token', name: 'Screen 1' },
      { wayland: true, selection, runner, readIdentity: identity, windowWitness: witness } as never
    );
    expect(target).toBeNull();
    expect(witness.resolveWindowClass).toHaveBeenCalledWith(selection.windowClass);
    expect(runner).not.toHaveBeenCalled();
  });

  it('represents an explicitly selected source_type 1 monitor as the whole-screen audio target', async () => {
    const screenSelection = {
      generation: selection.generation,
      sourceType: 1,
      output: 'DP-1',
      pipewireSerial: '901'
    };
    await expect(resolveLinuxAudioTarget(
      { id: 'window:opaque:restore-token', name: 'opaque portal name' },
      { wayland: true, selection: screenSelection as never }
    )).resolves.toEqual({
      kind: 'screen',
      portalGeneration: selection.generation,
      portalSourceType: 1,
      portalOutput: 'DP-1',
      portalPipewireSerial: '901'
    });
  });

  it('uses only the pre-picker process witness for the exact portal-selected class', async () => {
    const runner = vi.fn(async () => JSON.stringify([
      { mapped: true, pid: 10845, class: 'google-chrome' },
      { mapped: true, pid: 10845, class: 'google-chrome' },
      { mapped: true, pid: 999, class: 'other' }
    ]));
    const windowWitness = {
      isActive: true,
      resolveWindowClass: vi.fn(async () => ({ kind: 'application' as const, processId: 10845, processStartTime: 'start-10845' }))
    };
    const target = await resolveLinuxAudioTarget(
      { id: 'screen:opaque:portal-token', name: 'Screen 1' },
      { wayland: true, selection, runner, readIdentity: identity, windowWitness }
    );
    expect(target).toEqual({
      kind: 'application', processId: 10845, processStartTime: 'start-10845',
      portalGeneration: selection.generation, portalSourceType: 2,
      portalWindowClass: 'google-chrome', portalWindowHandle: '812', portalPipewireSerial: '901'
    });
    expect(windowWitness.resolveWindowClass).toHaveBeenCalledWith(selection.windowClass);
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails closed when the pre-picker witness is missing, inactive, or cannot uniquely resolve the class', async () => {
    const unavailable = await resolveLinuxAudioTarget({ id: 'window:opaque', name: 'x' }, {
      wayland: true, selection, windowWitness: { isActive: false, resolveWindowClass: vi.fn() } as never
    });
    const ambiguous = await resolveLinuxAudioTarget({ id: 'window:opaque', name: 'x' }, {
      wayland: true, selection, windowWitness: { isActive: true, resolveWindowClass: vi.fn(async () => null) } as never
    });
    expect(unavailable).toBeNull();
    expect(ambiguous).toBeNull();
  });

  it('binds the selected class to a same-generation active PipeWire capture serial, not the preview serial', async () => {
    const target = {
      kind: 'application' as const,
      processId: 10845,
      processStartTime: 'start-10845',
      portalGeneration: selection.generation,
      portalSourceType: 2 as const,
      portalWindowClass: selection.windowClass,
      portalWindowHandle: selection.windowHandle,
      portalPipewireSerial: selection.pipewireSerial
    };
    const observed = [selection];
    const runner = vi.fn(async () => captureGraph('902'));
    const bound = await bindPortalCaptureTarget(target, () => observed, {
      runner,
      captureProcess: (pid: number | null) => pid === 2369069,
      isActive: () => true,
      timeoutMs: 20,
      pollMs: 1,
      delay: async () => { observed.push({ ...selection, pipewireSerial: '902' }); }
    });
    expect(bound).toEqual({ ...target, portalPipewireSerial: '902' });
    expect(runner).toHaveBeenCalledWith('pw-dump', ['-i', '0']);
  });

  it('binds explicit screen audio to the exact generation, source type, output, and active video serial', async () => {
    const target = {
      kind: 'screen' as const,
      portalGeneration: selection.generation,
      portalSourceType: 1 as const,
      portalOutput: 'DP-1',
      portalPipewireSerial: '901'
    };
    const screenSelection = {
      generation: selection.generation,
      sourceType: 1,
      output: 'DP-1',
      pipewireSerial: '901'
    };
    const bound = await bindPortalCaptureTarget(target as never, () => [
      screenSelection,
      { ...screenSelection, pipewireSerial: '902' }
    ] as never, {
      runner: async () => captureGraph('902'),
      captureProcess: (pid: number | null) => pid === 2369069,
      isActive: () => true,
      timeoutMs: 0
    });
    expect(bound).toEqual({ ...target, portalPipewireSerial: '902' });
  });

  it('refuses a graph query that completes after its portal grant is cancelled', async () => {
    const target = {
      kind: 'application' as const,
      processId: 10845,
      processStartTime: 'start-10845',
      portalGeneration: selection.generation,
      portalSourceType: 2 as const,
      portalWindowClass: selection.windowClass,
      portalWindowHandle: selection.windowHandle,
      portalPipewireSerial: selection.pipewireSerial
    };
    const query = Promise.withResolvers<string>();
    const runner = vi.fn(() => query.promise);
    let active = true;
    const pending = bindPortalCaptureTarget(target, () => [selection], {
      runner,
      captureProcess: () => true,
      isActive: () => active
    });
    expect(runner).toHaveBeenCalledWith('pw-dump', ['-i', '0']);
    active = false;
    query.resolve(captureGraph('901'));
    expect(await pending).toBeNull();
  });

  it('refuses a video node from another process, class, or portal generation', async () => {
    const target = {
      kind: 'application' as const,
      processId: 10845,
      processStartTime: 'start-10845',
      portalGeneration: selection.generation,
      portalSourceType: 2 as const,
      portalWindowClass: selection.windowClass,
      portalWindowHandle: selection.windowHandle,
      portalPipewireSerial: selection.pipewireSerial
    };
    const foreign = await bindPortalCaptureTarget(target, () => [selection], {
      runner: async () => captureGraph('901', 999), captureProcess: () => false, isActive: () => true, timeoutMs: 0
    });
    const stale = await bindPortalCaptureTarget(target, () => [{ ...selection, generation: '00000000-0000-4000-8000-000000000000' }], {
      runner: async () => captureGraph('901'), captureProcess: () => true, isActive: () => true, timeoutMs: 0
    });
    expect(foreign).toBeNull();
    expect(stale).toBeNull();
  });

  it('never infers Wayland window ownership from an opaque source ID without Start metadata', async () => {
    const runner = vi.fn(async () => '');
    expect(await resolveLinuxAudioTarget({ id: 'screen:0:0', name: 'Screen 1' }, { wayland: false, runner }))
      .toEqual({ kind: 'screen' });
    expect(await resolveLinuxAudioTarget({ id: 'screen:opaque:token', name: 'Screen 1' }, { wayland: true, runner }))
      .toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('maps an X11 window to its PID with a process start-time identity', async () => {
    const runner = vi.fn(async () => '_NET_WM_PID(CARDINAL) = 10845\n');
    expect(await resolveLinuxAudioTarget({ id: 'window:123:0', name: 'Chrome' }, {
      wayland: false, runner, readIdentity: identity
    })).toEqual({ kind: 'application', processId: 10845, processStartTime: 'start-10845' });
    expect(runner).toHaveBeenCalledWith('xprop', ['-id', '123', '_NET_WM_PID']);
  });
});
