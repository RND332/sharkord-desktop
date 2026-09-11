import { homedir } from 'node:os';
import { join } from 'node:path';

export type CaptureMode = 'capture' | 'passthrough';

/**
 * Recording other applications' streams is a PipeWire arrangement; on Windows and macOS the client
 * keeps whatever audio the platform and the browser hand it.
 */
export const resolveMode = (platform: NodeJS.Platform): CaptureMode =>
  platform === 'linux' ? 'capture' : 'passthrough';

export type Config = {
  /** Web client to load, or null when the user has not chosen a server yet. */
  url: string | null;
  /** Whether this build records audio itself (Linux/PipeWire) or leaves it to the platform. */
  mode: CaptureMode;
  /** Name of the recording node every other application is linked into. */
  tapName: string;
  /** Dump the recorded PCM to this path (verification/debugging). */
  debugPcm: string | null;
  /** Where the first design kept its virtual-sink state; only used for cleanup. */
  legacyStatePath: string;
  /** Run the tone-exclusion self test instead of the normal UI. */
  selftest: boolean;
  /** Tear down leftovers from an older version and exit. */
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
  url: argValue(argv, 'url') ?? env.SHARKORD_URL ?? null,
  mode: resolveMode(platform),
  tapName: env.SHARKORD_TAP_NAME ?? 'sharkord_capture',
  debugPcm: env.SHARKORD_DEBUG_PCM ?? null,
  legacyStatePath: join(env.XDG_RUNTIME_DIR ?? homedir(), 'sharkord-desktop.json'),
  selftest: argv.includes('--selftest'),
  cleanup: argv.includes('--cleanup')
});
