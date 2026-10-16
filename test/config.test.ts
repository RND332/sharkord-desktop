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

  it('reads the tap name, debug path and legacy state path from the environment', () => {
    const config = loadConfig([], {
      SHARKORD_TAP_NAME: 'probe_tap',
      SHARKORD_DEBUG_PCM: '/tmp/capture.wav',
      XDG_RUNTIME_DIR: '/run/user/1234'
    });

    expect(config).toMatchObject({
      tapName: 'probe_tap',
      debugPcm: '/tmp/capture.wav',
      legacyStatePath: '/run/user/1234/sharkord-desktop.json',
      mode: 'capture'
    });
  });

  it('reports client errors only when a sentry dsn is configured', () => {
    expect(loadConfig([], {}).sentryDsn).toBeNull();
    expect(
      loadConfig([], { SHARKORD_SENTRY_DSN: 'https://key@errors.example.com/3' })
        .sentryDsn
    ).toBe('https://key@errors.example.com/3');
  });

  it('recognises the maintenance flags', () => {
    expect(loadConfig(['--selftest'], {}).selftest).toBe(true);
    expect(loadConfig(['--cleanup'], {}).cleanup).toBe(true);
    expect(loadConfig([], {}).selftest).toBe(false);
  });

  it('records the whole client console only when verbose logs are asked for', () => {
    expect(loadConfig(['--verbose-logs'], {}).verboseLogs).toBe(true);
    expect(loadConfig([], {}).verboseLogs).toBe(false);
  });

  it('leaves capture to the platform off Linux', () => {
    expect(loadConfig([], {}, 'darwin').mode).toBe('passthrough');
    expect(loadConfig([], {}, 'win32').mode).toBe('passthrough');
  });
});
