import { homedir } from 'node:os';
import { join } from 'node:path';

export type CaptureMode = 'capture' | 'passthrough';

/**
 * Capturing "everything except this app" is a PipeWire arrangement; on Windows and macOS the
 * client keeps whatever audio the platform and the browser hand it.
 */
export const resolveMode = (platform: NodeJS.Platform): CaptureMode =>
  platform === 'linux' ? 'capture' : 'passthrough';

export type Config = {
  /** Web client to load. */
  url: string;
  /** Whether this build captures audio itself (Linux/PipeWire) or leaves it to the platform. */
  mode: CaptureMode;
  /** Name of the null sink every non-Sharkord stream is routed into. */
  sinkName: string;
  /** Force a specific output device; by default whatever is default when the app starts. */
  hwSink: string | null;
  /** Dump the captured PCM to this path (verification/debugging). */
  debugPcm: string | null;
  /** Where routing state survives a crash. */
  statePath: string;
  /** Run the tone-exclusion self test instead of the normal UI. */
  selftest: boolean;
  /** Tear down leftovers from a previous run and exit. */
  cleanup: boolean;
};

const argValue = (argv: string[], name: string): string | null => {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith('--') ? argv[idx + 1]! : null;
};

export const loadConfig = (
  argv: string[] = process.argv.slice(1),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Config => ({
  url: argValue(argv, 'url') ?? env.SHARKORD_URL ?? 'https://sharkord.example.com',
  mode: resolveMode(platform),
  sinkName: env.SHARKORD_SINK_NAME ?? 'sharkord_capture',
  hwSink: env.SHARKORD_HW_SINK ?? null,
  debugPcm: env.SHARKORD_DEBUG_PCM ?? null,
  statePath:
    env.SHARKORD_STATE_PATH ?? join(env.XDG_RUNTIME_DIR ?? homedir(), 'sharkord-desktop.json'),
  selftest: argv.includes('--selftest'),
  cleanup: argv.includes('--cleanup')
});
