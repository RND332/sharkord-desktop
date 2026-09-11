import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { Capture } from './capture';
import type { Config } from './config';
import type { RoutingManager } from './routing';
import { getDefaultSink, realRunner } from './pipewire';
import { amplitudeAt } from '../shared/pcm';
import { writeWav } from './wav';

/** Played inside the app window: this is the voice channel and must never reach viewers. */
const APP_TONE_HZ = 997;
/** Played by an unrelated process into the capture sink: this is "the rest of the PC". */
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
  routing: RoutingManager;
  capture: Capture;
  window: BrowserWindow;
  hardwareSink: string;
  log: (...parts: unknown[]) => void;
};

type Band = { app: number; pc: number };
type Report = {
  capture: Band[];
  hardware: Band[];
  injected: Band[];
  pass: boolean;
  failures: string[];
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
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
  bands.length <= 2
    ? 0
    : Math.max(...bands.slice(1, -1).map((band) => band[key]));

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
    await bridge.acquireCapture();
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = generator.writable.getWriter();
    let stamp = 0;
    let pending = 0;
    bridge.onPcm((chunk) => {
      const frames = Math.floor(chunk.byteLength / (4 * CH));
      if (!frames) return;
      const data = new Float32Array(chunk.buffer, chunk.byteOffset, frames * CH).slice();
      if (pending < 12) {
        pending++;
        writer.write(new AudioData({
          format: 'f32',
          sampleRate: SR,
          numberOfFrames: frames,
          numberOfChannels: CH,
          timestamp: stamp,
          data
        })).catch(() => {}).finally(() => pending--);
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
      frame.copyTo(interleaved, { planeIndex: 0 });
      frame.close();
      for (let i = 0; i < interleaved.length; i += CH) {
        mono.push((interleaved[i] + interleaved[i + 1]) / 2);
      }
      while (mono.length >= perWindow) {
        const window = Float32Array.from(mono.splice(0, perWindow));
        windows.push({ app: amp(window, APP), pc: amp(window, PC) });
      }
    }
    return windows;
  })();
})();
`;

export const runSelftest = async (options: SelftestOptions): Promise<{ pass: boolean; report: Report }> => {
  const { config, routing, capture, window, hardwareSink, log } = options;
  const failures: string[] = [];
  const captureSamples: Float32Array[] = [];
  const hardwareSamples: Float32Array[] = [];

  const defaultSink = await getDefaultSink(realRunner);
  if (defaultSink !== config.sinkName) {
    failures.push(`default sink is ${defaultSink}, expected ${config.sinkName}`);
  }
  if (!routing.state.active) failures.push('routing manager is not active');

  const offCapture = capture.onData((chunk) => captureSamples.push(toMono(chunk)));
  const stereo = new Capture({
    sinkName: hardwareSink,
    log: () => {}
  });
  const offHardware = stereo.onData((chunk) => hardwareSamples.push(toMono(chunk)));

  const tonePath = join(tmpdir(), 'sharkord-desktop-selftest-tone.wav');
  await toneWav(tonePath, PC_TONE_HZ, TONE_SECONDS);

  capture.start();
  stereo.start();
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

  const pcTone: ChildProcess = spawn('paplay', [`--device=${config.sinkName}`, tonePath]);
  pcTone.on('error', (error) => failures.push(`paplay failed: ${error.message}`));

  await sleep(TONE_SECONDS * 1000 + TAIL_MS);

  pcTone.kill();
  capture.stop();
  stereo.stop();
  offCapture();
  offHardware();

  const injected = (await window.webContents.executeJavaScript(
    'window.__selftestPromise',
    true
  )) as Band[];

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

  const captureBands = bandsFrom(concat(captureSamples));
  const hardwareBands = bandsFrom(concat(hardwareSamples));

  const capturePc = settled(captureBands, 'pc');
  const captureApp = settled(captureBands, 'app');
  const hardwareApp = settled(hardwareBands, 'app');
  const injectedPc = settled(injected, 'pc');
  const injectedApp = settled(injected, 'app');

  const MIN_TONE = 0.15;
  const MAX_LEAK = 0.02;

  if (capturePc < MIN_TONE) failures.push(`other apps' audio missing from the capture (${capturePc.toFixed(3)})`);
  if (captureApp > MAX_LEAK) failures.push(`app audio leaked into the capture (${captureApp.toFixed(3)})`);
  if (hardwareApp < MIN_TONE) failures.push(`app audio was not audible at all (${hardwareApp.toFixed(3)})`);
  if (injectedPc < MIN_TONE) failures.push(`injected track is silent (${injectedPc.toFixed(3)})`);
  if (injectedApp > MAX_LEAK) failures.push(`injected track carries app audio (${injectedApp.toFixed(3)})`);

  const pass = failures.length === 0;
  log(
    `selftest ${pass ? 'PASS' : 'FAIL'} ` +
      `capture[pc=${capturePc.toFixed(3)} app=${captureApp.toFixed(3)}] ` +
      `hardware[app=${hardwareApp.toFixed(3)}] ` +
      `injected[pc=${injectedPc.toFixed(3)} app=${injectedApp.toFixed(3)}] appTone=${JSON.stringify(appTone)}` +
      (pass ? '' : ` failures=${failures.join('; ')}`)
  );

  return {
    pass,
    report: { capture: captureBands, hardware: hardwareBands, injected, pass, failures }
  };
};
