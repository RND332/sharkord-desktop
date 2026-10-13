// Run explicitly with Bun; uses only fixture nodes, never changes session routing.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TapCapture, defaultRunner, parseGraph, readProcessIdentity } from '../src/main/tap';
import { writeWav } from '../src/main/wav';

const scratch = process.env.TMPDIR;
if (!scratch) throw new Error('Set TMPDIR to a scratch directory');
const dir = await mkdtemp(join(scratch, 'sharkord-window-audio-'));
const tapName = `sharkord_isolation_smoke_${process.pid}`;
const children: ReturnType<typeof spawn>[] = [];
const chunks: Buffer[] = [];
const tap = new TapCapture({
  tapName, pollMs: 100, ownsProcess: () => false,
  runner: async (bin, args) => {
    const output = await defaultRunner(bin, args);
    if (bin !== 'pw-dump') return output;
    // Also constrain the deliberately leaky baseline to our fixtures only.
    return JSON.stringify(JSON.parse(output).filter((entry: any) => {
      const props = entry.info?.props ?? {};
      return props['media.class'] !== 'Stream/Output/Audio' ||
        String(props['node.name']).startsWith(`${tapName}_`);
    }));
  }
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tone = (hz: number) => Float32Array.from({ length: 48000 * 8 * 2 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * Math.floor(i / 2) / 48000));
const amplitude = (samples: Float32Array, hz: number) => {
  let real = 0, imaginary = 0;
  const length = Math.min(48000, Math.floor(samples.length / 2));
  const offset = Math.max(0, Math.floor(samples.length / 2) - length);
  for (let i = 0; i < length; i++) {
    const sample = samples[(offset + i) * 2]!;
    const phase = 2 * Math.PI * hz * i / 48000;
    real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / length;
};
try {
  for (const [name, hz] of [['selected', 440], ['unrelated', 880]] as const) {
    const file = join(dir, `${name}.wav`);
    await writeWav(file, tone(hz), 48000, 2);
    // No autoconnect: these test tones are not played into the user's speakers.
    children.push(spawn('pw-play', ['-P', 'node.autoconnect=false', '-P', `node.name=${tapName}_${name}`, file], { stdio: 'ignore' }));
  }
  const selectedPid = children[0]!.pid;
  if (!selectedPid) throw new Error('fixture failed to spawn');
  await delay(300);
  tap.onData((chunk) => chunks.push(chunk));
  const screen = process.argv.includes('--screen');
  const identity = process.argv.includes('--baseline') || screen ? null : readProcessIdentity(selectedPid);
  if (!screen && !process.argv.includes('--baseline') && !identity) throw new Error('fixture process identity unavailable');
  tap.start(screen || process.argv.includes('--baseline')
    ? { kind: 'screen' }
    : { kind: 'application', processId: selectedPid, processStartTime: identity!.startTime });
  await delay(2500);
  await tap.reconcile();
  const linkedPids = tap.tappedProcessIds;
  tap.stop();
  await delay(200);
  const bytes = Buffer.concat(chunks);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  const selected = amplitude(samples, 440), unrelated = amplitude(samples, 880);
  const graph = parseGraph(await defaultRunner('pw-dump', ['-i', '0']), tapName);
  console.log(JSON.stringify({ frames: samples.length / 2, selected440: selected, unrelated880: unrelated, linkedPids, tapRemoved: graph.tapNodeId === null }));
  const isolated = unrelated < selected / 100 && linkedPids.length === 1 && linkedPids[0] === selectedPid;
  const wholeScreen = unrelated > 0.02 && linkedPids.length === 2 && linkedPids.includes(children[1]!.pid!);
  if (!(selected > 0.02 && (screen ? wholeScreen : isolated) && graph.tapNodeId === null)) {
    throw new Error('selected tone missing, unrelated audio leaked, or cleanup failed');
  }
} finally {
  tap.stop();
  for (const child of children) child.kill();
  await delay(100);
  await rm(dir, { recursive: true, force: true });
}
