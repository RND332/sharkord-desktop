import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Config } from './config';
import { isOwnProcess, type TapCapture } from './tap';
import { amplitudeAt } from '../shared/pcm';
import { writeWav } from './wav';

/** Played inside the app window: this is the voice channel and must never reach viewers. */
const APP_TONE_HZ = 997;
/** Played by an unrelated process: this is "the rest of the PC" and must be captured. */
const PC_TONE_HZ = 1493;
const TONE_AMPLITUDE = 0.35;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const WINDOW_SECONDS = 0.5;
const TONE_SECONDS = 3;
const WARMUP_MS = 1200;
const TAIL_MS = 1200;

export type SelftestOptions = {
  config: Config;
  tap: TapCapture;
  window: BrowserWindow;
  log: (...parts: unknown[]) => void;
};

type Band = { app: number; pc: number };
type Report = {
  capture: Band[];
  control: Band[];
  injected: Band[];
  linked: number;
  pass: boolean;
  failures: string[];
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const getDefaultSink = (): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile('pactl', ['get-default-sink'], (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout.trim());
  });
  return promise;
};

const hasLegacyModules = (): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile('pactl', ['list', 'modules'], (error, stdout) => {
    resolve(!error && stdout.includes('sink_name=sharkord_capture'));
  });
  return promise;
};

const toMono = (chunk: Buffer): Float32Array => {
  const interleaved = new Float32Array(
    chunk.buffer,
    chunk.byteOffset,
    Math.floor(chunk.byteLength / 4)
  );
  const mono = new Float32Array(Math.floor(interleaved.length / CHANNELS));
  for (let i = 0; i < mono.length; i += 1) {
    let sum = 0;
    for (let c = 0; c < CHANNELS; c += 1) sum += interleaved[i * CHANNELS + c] ?? 0;
    mono[i] = sum / CHANNELS;
  }
  return mono;
};

const bandsFrom = (samples: Float32Array): Band[] => {
  const perWindow = Math.floor(SAMPLE_RATE * WINDOW_SECONDS);
  const bands: Band[] = [];
  for (let start = 0; start + perWindow <= samples.length; start += perWindow) {
    const window = samples.subarray(start, start + perWindow);
    bands.push({
      app: amplitudeAt(window, APP_TONE_HZ, SAMPLE_RATE),
      pc: amplitudeAt(window, PC_TONE_HZ, SAMPLE_RATE)
    });
  }
  return bands;
};

/** Ignore the first and last window: the tones start and stop inside them. */
const settled = (bands: Band[], key: keyof Band): number =>
  bands.length <= 2 ? 0 : Math.max(...bands.slice(1, -1).map((band) => band[key]));

const concat = (parts: Float32Array[]): Float32Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const toneWav = async (path: string, freq: number, seconds: number): Promise<void> => {
  const frames = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Float32Array(frames * CHANNELS);
  for (let i = 0; i < frames; i += 1) {
    const value = TONE_AMPLITUDE * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    samples[i * CHANNELS] = value;
    samples[i * CHANNELS + 1] = value;
  }
  await writeWav(path, samples, SAMPLE_RATE, CHANNELS);
};

/** Records a monitor the way any recorder would — read-only, nothing in the session changes. */
const recordMonitor = (device: string, onData: (chunk: Buffer) => void): ChildProcess => {
  const child = spawn('parec', [
    '-d',
    device,
    '--format=float32le',
    '--rate=48000',
    '--channels=2',
    '--latency-msec=20'
  ]);
  child.stdout.on('data', onData);
  return child;
};

const pageSetup = (measureMs: number): string => `
(() => {
  const SR = ${SAMPLE_RATE};
  const CH = ${CHANNELS};
  const APP = ${APP_TONE_HZ};
  const PC = ${PC_TONE_HZ};
  const amp = (samples, freq) => {
    const k = 2 * Math.cos(2 * Math.PI * freq / SR);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const s0 = samples[i] + k * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / samples.length * 2;
  };
  window.__selftestPromise = (async () => {
    const bridge = window.sharkordDesktop;
    const stats = { pcmCallbacks: 0, writes: 0, writeError: null, maxInputPc: 0, maxInputApp: 0, framesRead: 0, maxFrameAbs: 0 };
    await bridge.acquireCapture();
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    let stamp = 0;
    let pending = 0;
    bridge.onPcm((chunk) => {
      stats.pcmCallbacks++;
      const frames = Math.floor(chunk.byteLength / (4 * CH));
      if (!frames) return;
      const data = new Float32Array(chunk.buffer, chunk.byteOffset, frames * CH).slice();
      const left = new Float32Array(frames);
      for (let i = 0, j = 0; i < data.length; i += CH, j++) left[j] = data[i];
      stats.maxInputPc = Math.max(stats.maxInputPc, amp(left, PC));
      stats.maxInputApp = Math.max(stats.maxInputApp, amp(left, APP));
      if (pending < 12) {
        pending++;
        stats.writes++;
        writer.write(new AudioData({
          format: 'f32',
          sampleRate: SR,
          numberOfFrames: frames,
          numberOfChannels: CH,
          timestamp: stamp,
          data
        })).then(() => {}).catch((error) => { stats.writeError = String(error); }).finally(() => pending--);
      }
      stamp += Math.round(frames / SR * 1e6);
    });

    const reader = new MediaStreamTrackProcessor({ track: generator }).readable.getReader();
    const perWindow = SR * ${WINDOW_SECONDS};
    const windows = [];
    let mono = [];
    const started = performance.now();
    while (performance.now() - started < ${measureMs}) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const interleaved = new Float32Array(frame.numberOfFrames * frame.numberOfChannels);
      // Interleaved copy of every channel; a planar frame copied plane-by-plane would break the rate.
      frame.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
      frame.close();
      stats.framesRead++;
      for (let i = 0; i < interleaved.length; i++) {
        const value = Math.abs(interleaved[i]);
        if (value > stats.maxFrameAbs) stats.maxFrameAbs = value;
      }
      for (let i = 0; i < interleaved.length; i += CH) {
        mono.push(interleaved[i]);
      }
      while (mono.length >= perWindow) {
        const window = Float32Array.from(mono.splice(0, perWindow));
        windows.push({ app: amp(window, APP), pc: amp(window, PC) });
      }
    }
    return { windows, stats };
  })();
})();
`;

export const runSelftest = async (options: SelftestOptions): Promise<{ pass: boolean; report: Report }> => {
  const { config, tap, window, log } = options;
  const failures: string[] = [];

  if (config.mode !== 'capture') {
    log('selftest needs Linux/PipeWire');
    return { pass: false, report: { capture: [], control: [], injected: [], linked: 0, pass: false, failures: ['unsupported platform'] } };
  }

  // Nothing about the session's audio routing may have changed.
  const defaultSink = await getDefaultSink();
  if (defaultSink === config.tapName) failures.push('the capture node became the default sink');
  if (await hasLegacyModules()) failures.push('legacy virtual-sink modules are still loaded');

  const captureSamples: Float32Array[] = [];
  const controlSamples: Float32Array[] = [];
  tap.onData((chunk) => captureSamples.push(toMono(chunk)));
  tap.start();
  const control = recordMonitor(`${defaultSink}.monitor`, (chunk) => controlSamples.push(toMono(chunk)));

  const tonePath = join(tmpdir(), 'sharkord-desktop-selftest-tone.wav');
  await toneWav(tonePath, PC_TONE_HZ, TONE_SECONDS);

  await sleep(WARMUP_MS);
  await window.webContents.executeJavaScript(pageSetup(TONE_SECONDS * 1000 + 800), true);
  const appTone = await window.webContents.executeJavaScript(
    `(async () => {
      const ctx = new AudioContext({ sampleRate: ${SAMPLE_RATE} });
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = ${APP_TONE_HZ};
      gain.gain.value = ${TONE_AMPLITUDE};
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); void ctx.close(); }, ${TONE_SECONDS * 1000});
      return { state: ctx.state };
    })()`,
    true
  );

  // An ordinary application, playing to the user's own device. It must not be a child of this
  // process, or the tap would (correctly) treat it as our own playback — hence setsid.
  const pcTone = spawn('setsid', ['paplay', tonePath], { detached: true, stdio: 'ignore' });
  pcTone.on('error', (error) => failures.push(`paplay failed: ${error.message}`));

  await sleep(TONE_SECONDS * 1000 + TAIL_MS);

  pcTone.kill();
  control.kill();
  // Snapshot before stopping: `stop()` clears the link bookkeeping.
  const tappedPids = tap.tappedProcessIds;
  tap.stop();

  const pageResult = (await window.webContents.executeJavaScript(
    'window.__selftestPromise',
    true
  )) as { windows: Band[]; stats: Record<string, unknown> };
  const injected = pageResult.windows;

  const captureBands = bandsFrom(concat(captureSamples));
  const controlBands = bandsFrom(concat(controlSamples));

  const capturePc = settled(captureBands, 'pc');
  const captureApp = settled(captureBands, 'app');
  const controlApp = settled(controlBands, 'app');
  const injectedPc = settled(injected, 'pc');
  const injectedApp = settled(injected, 'app');

  const MIN_TONE = 0.15;
  const MAX_LEAK = 0.02;

  // The guarantee viewers depend on: no stream from this app's own process tree is ever linked.
  const ownPids = tappedPids.filter((pid) => isOwnProcess(pid));
  if (ownPids.length > 0) {
    failures.push(`the tap linked this app's own audio (pids: ${ownPids.join(', ')})`);
  }
  if (tappedPids.length === 0) {
    failures.push('the tap linked no application at all');
  }

  // Another instance of this app on the same machine is a separate application, so its audio is
  // legitimately captured — that makes the tone-based leak check meaningless while it runs.
  const otherInstances = tappedPids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('sharkord');
    } catch {
      return false;
    }
  });
  if (otherInstances.length > 0) {
    log(
      `note: another Sharkord instance (pids: ${otherInstances.join(', ')}) is playing audio; ` +
        'its playback is captured on purpose and the tone-based leak check is skipped'
    );
  }

  if (capturePc < MIN_TONE) failures.push(`another app's audio missing from the capture (${capturePc.toFixed(3)})`);
  if (otherInstances.length === 0 && captureApp > MAX_LEAK) {
    failures.push(`the client's own audio leaked into the capture (${captureApp.toFixed(3)})`);
  }
  if (controlApp < MIN_TONE) failures.push(`the app tone was not audible at all (${controlApp.toFixed(3)})`);
  if (injectedPc < MIN_TONE) failures.push(`injected track is silent (${injectedPc.toFixed(3)})`);
  if (otherInstances.length === 0 && injectedApp > MAX_LEAK) {
    failures.push(`injected track carries the client's own audio (${injectedApp.toFixed(3)})`);
  }

  const pass = failures.length === 0;
  if (!pass) {
    log('capture series', JSON.stringify(captureBands.map((b) => [Number(b.pc.toFixed(3)), Number(b.app.toFixed(3))])));
    log('injected series', JSON.stringify(injected.map((b) => [Number(b.pc.toFixed(3)), Number(b.app.toFixed(3))])));
    log('page stats', JSON.stringify(pageResult.stats));
  }
  log(
    `selftest ${pass ? 'PASS' : 'FAIL'} ` +
      `capture[pc=${capturePc.toFixed(3)} app=${captureApp.toFixed(3)}] ` +
      `tapped[${tappedPids.length} pid(s), own=${ownPids.length}] ` +
      `control[app=${controlApp.toFixed(3)}] ` +
      `injected[pc=${injectedPc.toFixed(3)} app=${injectedApp.toFixed(3)}] ` +
      `defaultSink=${defaultSink} appTone=${JSON.stringify(appTone)}` +
      (pass ? '' : ` failures=${failures.join('; ')}`)
  );

  return {
    pass,
    report: {
      capture: captureBands,
      control: controlBands,
      injected,
      linked: tap.linkedCount,
      pass,
      failures
    }
  };
};
