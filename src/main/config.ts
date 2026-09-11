import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
  /** Web client to load. */
  url: string;
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
  env: NodeJS.ProcessEnv = process.env
): Config => ({
  url: argValue(argv, 'url') ?? env.SHARKORD_URL ?? 'https://sharkord.example.com',
  sinkName: env.SHARKORD_SINK_NAME ?? 'sharkord_capture',
  hwSink: env.SHARKORD_HW_SINK ?? null,
  debugPcm: env.SHARKORD_DEBUG_PCM ?? null,
  statePath: join(env.XDG_RUNTIME_DIR ?? homedir(), 'sharkord-desktop.json'),
  selftest: argv.includes('--selftest'),
  cleanup: argv.includes('--cleanup')
});
