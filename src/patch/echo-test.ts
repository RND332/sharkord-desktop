/**
 * Decides whether a live capture can hear this app's own playback.
 *
 * The OS cannot always tell us: Chromium's `restrictOwnAudio` is silently ignored below Windows 11,
 * and WASAPI's exclude mode needs build 20348. So instead of trusting a flag, we measure: play a
 * quiet tone through the very device the app's voice plays on, look for that frequency in the
 * capture. Voices in the capture mean voices on the stream, which is the one thing to never ship.
 */

/** High enough that most adults do not notice it, low enough for speakers and codecs to pass. */
export const ECHO_PROBE_HZ = 16000;
export const ECHO_PROBE_LEVEL = 0.06;
export const ECHO_TONE_MS = 550;
export const ECHO_GAP_MS = 400;
/** dB the tone must stand above the idle floor to count as audible to the capture. */
export const ECHO_THRESHOLD_DB = 8;
/** Anything quieter than this is noise, so the measurement is inconclusive rather than clean. */
export const ECHO_FLOOR_DB = -85;

export const isToneHeard = (
  tonedDb: number,
  idleDb: number,
  thresholdDb = ECHO_THRESHOLD_DB,
  floorDb = ECHO_FLOOR_DB
): boolean | null => {
  if (!Number.isFinite(tonedDb) || !Number.isFinite(idleDb)) return null;
  if (tonedDb < floorDb) return null; // the tone never made it into the capture: cannot tell
  return tonedDb - idleDb >= thresholdDb;
};

type AudioContextLike = {
  sampleRate: number;
  state: string;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createMediaStreamSource(stream: unknown): { connect(node: unknown): void };
  createAnalyser(): {
    fftSize: number;
    smoothingTimeConstant: number;
    frequencyBinCount: number;
    getFloatFrequencyData(bins: Float32Array): void;
  };
  createOscillator(): { type: string; frequency: { value: number }; start(): void; stop(): void; connect(n: unknown): void };
  createGain(): { gain: { value: number }; connect(n: unknown): void };
  createMediaStreamDestination(): { stream: unknown };
};

type AudioContextCtor = new (options?: { sampleRate?: number }) => AudioContextLike;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The device the app's own voice plays on, read from the element the client already configured. */
export const findAppPlaybackSink = (root: Pick<Document, 'querySelectorAll'> = document): string | undefined => {
  for (const element of Array.from(root.querySelectorAll('audio'))) {
    const audio = element as HTMLAudioElement & { sinkId?: string };
    if (audio.srcObject && typeof audio.sinkId === 'string' && audio.sinkId.length > 0) return audio.sinkId;
  }
  return undefined;
};

const peakInBand = async (
  analyser: ReturnType<AudioContextLike['createAnalyser']>,
  sampleRate: number,
  durationMs: number
): Promise<number> => {
  const bins = new Float32Array(analyser.frequencyBinCount);
  const centre = Math.round((ECHO_PROBE_HZ / (sampleRate / 2)) * bins.length);
  const low = Math.max(0, centre - 2);
  const high = Math.min(bins.length - 1, centre + 2);

  let peak = Number.NEGATIVE_INFINITY;
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    analyser.getFloatFrequencyData(bins);
    for (let i = low; i <= high; i += 1) peak = Math.max(peak, bins[i] ?? Number.NEGATIVE_INFINITY);
    await sleep(25);
  }
  return peak;
};

export type EchoProbeOptions = {
  createElement?: (tag: 'audio') => HTMLAudioElement;
  root?: Pick<Document, 'querySelectorAll'>;
  log?: (...args: unknown[]) => void;
};

/**
 * True when this app's playback is audible in `track`'s capture, null when undecidable. Callers
 * treat anything but `false` as "do not send the voice channel to viewers".
 */
export const probeOwnAudio = async (
  track: MediaStreamTrack,
  options: EchoProbeOptions = {}
): Promise<boolean | null> => {
  const log = options.log ?? ((...args: unknown[]) => console.warn('[sharkord-desktop]', ...args));
  const createElement = options.createElement ?? ((tag: 'audio') => document.createElement(tag));
  const root = options.root ?? document;
  const AudioContextClass = (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor })
    .AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!AudioContextClass) return null;

  let capture: AudioContextLike | null = null;
  let tone: AudioContextLike | null = null;
  let element: HTMLAudioElement | null = null;

  try {
    capture = new AudioContextClass({ sampleRate: 48000 });
    await capture.resume?.();
    if (capture.state === 'suspended') return null;

    const analyser = capture.createAnalyser();
    analyser.fftSize = 8192; // ~6 Hz bins at 48 kHz: the probe tone lands in a single band
    analyser.smoothingTimeConstant = 0;
    capture.createMediaStreamSource(new MediaStream([track])).connect(analyser);

    tone = new AudioContextClass({ sampleRate: 48000 });
    await tone.resume?.();
    const oscillator = tone.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = ECHO_PROBE_HZ;
    const gain = tone.createGain();
    gain.gain.value = ECHO_PROBE_LEVEL;
    const destination = tone.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);

    element = createElement('audio');
    element.srcObject = destination.stream as MediaStream;
    element.volume = 1;

    const sink = findAppPlaybackSink(root);
    if (sink) {
      try {
        await (element as HTMLAudioElement & { setSinkId?(id: string): Promise<void> }).setSinkId?.(sink);
      } catch {
        // the configured device is gone: fall through and measure the default, which is the truth
      }
    }

    await element.play();
    oscillator.start();

    const toned = await peakInBand(analyser, capture.sampleRate, ECHO_TONE_MS);
    oscillator.stop();
    const idle = await peakInBand(analyser, capture.sampleRate, ECHO_GAP_MS);

    const heard = isToneHeard(toned, idle);
    log(`own-audio probe: tone ${toned.toFixed(1)} dB, idle ${idle.toFixed(1)} dB, heard=${heard}`);
    return heard;
  } catch (error) {
    log('own-audio probe failed', error);
    return null;
  } finally {
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    void tone?.close?.();
    void capture?.close?.();
  }
};
