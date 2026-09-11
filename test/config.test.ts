import { describe, expect, it } from 'vitest';
import { loadConfig, resolveMode } from '../src/main/config';

describe('resolveMode', () => {
  it('captures audio itself only where PipeWire provides the routing', () => {
    expect(resolveMode('linux')).toBe('capture');
    expect(resolveMode('win32')).toBe('passthrough');
    expect(resolveMode('darwin')).toBe('passthrough');
  });
});

describe('loadConfig', () => {
  it('prefers the CLI flag over the environment, and asks when neither is set', () => {
    expect(loadConfig(['--url=https://cli.test'], {}).url).toBe('https://cli.test');
    expect(loadConfig([], { SHARKORD_URL: 'https://env.test' }).url).toBe('https://env.test');
    expect(loadConfig([], {}).url).toBeNull();
  });

  it('reads sink name, device override and state path from the environment', () => {
    const config = loadConfig([], {
      SHARKORD_SINK_NAME: 'probe_sink',
      SHARKORD_HW_SINK: 'alsa_output.hw',
      SHARKORD_DEBUG_PCM: '/tmp/capture.wav',
      XDG_RUNTIME_DIR: '/run/user/1234'
    });

    expect(config).toMatchObject({
      sinkName: 'probe_sink',
      hwSink: 'alsa_output.hw',
      debugPcm: '/tmp/capture.wav',
      statePath: '/run/user/1234/sharkord-desktop.json',
      mode: 'capture'
    });
  });

  it('honours an explicit state path', () => {
    expect(loadConfig([], { SHARKORD_STATE_PATH: '/tmp/custom.json' }).statePath).toBe('/tmp/custom.json');
  });

  it('recognises the maintenance flags', () => {
    expect(loadConfig(['--selftest'], {}).selftest).toBe(true);
    expect(loadConfig(['--cleanup'], {}).cleanup).toBe(true);
    expect(loadConfig([], {}).selftest).toBe(false);
  });

  it('leaves capture to the platform off Linux', () => {
    expect(loadConfig([], {}, 'darwin').mode).toBe('passthrough');
    expect(loadConfig([], {}, 'win32').mode).toBe('passthrough');
  });
});
