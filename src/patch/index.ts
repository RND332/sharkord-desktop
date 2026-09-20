import { frameInterleavedF32 } from '../shared/pcm';
import { probeOwnAudio } from './echo-test';

/** Capture format of the PCM we inject (the Linux tap and the Windows helper both produce this). */
export const PCM_SAMPLE_RATE = 48000;
export const PCM_CHANNELS = 2;

/** Frames allowed in flight towards the encoder before we start dropping (keeps the timeline honest). */
const MAX_PENDING_FRAMES = 12;

export type AudioTrackLike = {
  readyState: string;
  stop(): void;
  addEventListener(type: string, cb: () => void): void;
};

export type AudioDataLike = { close?(): void };

export type IntervalHandle = number | NodeJS.Timeout;

export type EchoTest = 'clean' | 'captured' | 'unknown';

export type CaptureMode =
  | 'captured-pcm'
  | 'system-audio'
  | 'system-audio-echo'
  | 'system-audio-unavailable';

export type PatchEnvironment = {
  mediaDevices: {
    getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  };
  MediaStream: new (tracks?: MediaStreamTrack[]) => MediaStream;
  MediaStreamTrackGenerator?: new (init: { kind: 'audio' }) => AudioTrackLike & {
    writable: { getWriter(): { write(data: AudioDataLike): Promise<void> } };
  };
  AudioData?: new (init: {
    format: 'f32';
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    timestamp: number;
    data: Float32Array;
  }) => AudioDataLike;
  bridge: {
    platform?: string;
    /** 'pipewire' | 'windows' | 'none' — where the app's own capture comes from, if anywhere. */
    captureSource?: string;
    /** True when the user asked for system audio even where it cannot exclude our playback. */
    forceSystemAudio?: boolean;
    appInfo?(): Promise<{ version: string; platform: string }>;
    reportCaptureMode?(info: {
      mode: CaptureMode;
      echoTest?: EchoTest;
      ownAudioSupported?: boolean;
      ownAudioApplied?: boolean;
    }): Promise<boolean>;
    acquireCapture(): Promise<void>;
    releaseCapture(): Promise<void>;
    onPcm(cb: (chunk: Uint8Array) => void): () => void;
    onCaptureEnded?(cb: () => void): () => void;
  };
  /** Measures whether the capture can hear this app; overridable for tests. */
  probeOwnAudio?: (track: MediaStreamTrack) => Promise<boolean | null>;
  log?: (...args: unknown[]) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export const installGetDisplayMediaPatch = (env: PatchEnvironment): void => {
  const log = env.log ?? ((...args: unknown[]) => console.warn('[sharkord-desktop]', ...args));
  const setIntervalFn = env.setIntervalFn ?? setInterval;
  const clearIntervalFn = env.clearIntervalFn ?? clearInterval;
  const mediaDevices = env.mediaDevices;
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  const probe = env.probeOwnAudio ?? ((track: MediaStreamTrack) => probeOwnAudio(track, { log }));
  const windows = env.bridge.platform === 'win32';
  let windowsShareOpen = false;
  let windowsShareRelease: Promise<void> = Promise.resolve();

  const releaseNativeCapture = (): Promise<void> => {
    const released = env.bridge.releaseCapture().catch(() => {});
    if (!windows) return released;
    windowsShareRelease = released.then(() => {
      windowsShareOpen = false;
    });
    return windowsShareRelease;
  };

  /** Preserve the settings-selected frame rate while telling the encoder that smooth motion matters. */
  const favorMotion = (stream: MediaStream): void => {
    for (const track of stream.getVideoTracks()) {
      const video = track as MediaStreamTrack & { contentHint?: string };
      if (!('contentHint' in video)) continue;
      try {
        video.contentHint = 'motion';
      } catch {
        // An optional encoder hint must never make a share fail.
      }
    }
  };

  const createCapturedTrack = async (
    video: MediaStreamTrack | undefined
  ): Promise<{ track: AudioTrackLike; release(): void }> => {
    const Generator = env.MediaStreamTrackGenerator;
    const AudioDataCtor = env.AudioData;
    if (!Generator || !AudioDataCtor) throw new Error('MediaStreamTrackGenerator/AudioData unavailable');

    let released = false;
    let acquired = false;
    let ended = false;
    let timer: IntervalHandle | null = null;
    let stopTrack = (): void => {};
    let unsubscribePcm = (): void => {};
    let unsubscribeEnded = (): void => {};

    const release = (): void => {
      if (released) return;
      released = true;
      if (timer !== null) clearIntervalFn(timer);
      unsubscribePcm();
      unsubscribeEnded();
      stopTrack();
      void releaseNativeCapture();
    };

    unsubscribeEnded =
      env.bridge.onCaptureEnded?.(() => {
        ended = true;
        if (acquired) release();
      }) ?? (() => {});

    try {
      await env.bridge.acquireCapture();
      acquired = true;
      if (ended) throw new Error('capture ended while it was being acquired');

      const generator = new Generator({ kind: 'audio' });
      stopTrack = generator.stop.bind(generator);
      // stop() fires no `ended` event, so release from here too.
      generator.stop = (): void => {
        stopTrack();
        release();
      };

      let carry: Uint8Array = new Uint8Array(0);
      let timestampUs = 0;
      let pending = 0;
      const writer = generator.writable.getWriter();
      unsubscribePcm = env.bridge.onPcm((chunk) => {
        const framed = frameInterleavedF32(carry, chunk, PCM_CHANNELS);
        carry = framed.carry;
        for (const frame of framed.frames) {
          const frames = frame.length / PCM_CHANNELS;
          const durationUs = Math.round((frames / PCM_SAMPLE_RATE) * 1e6);
          if (pending < MAX_PENDING_FRAMES) {
            pending += 1;
            const data = new AudioDataCtor({
              format: 'f32',
              sampleRate: PCM_SAMPLE_RATE,
              numberOfFrames: frames,
              numberOfChannels: PCM_CHANNELS,
              timestamp: timestampUs,
              data: frame
            });
            writer
              .write(data)
              .catch(() => release())
              .finally(() => {
                pending -= 1;
                data.close?.();
              });
          }
          // Advance even when dropping, so audio stays in step with the video clock.
          timestampUs += durationUs;
        }
      });

      timer = setIntervalFn(() => {
        if (generator.readyState === 'ended' || video?.readyState === 'ended') release();
      }, 500);

      return { track: generator, release };
    } catch (error) {
      release();
      throw error;
    }
  };

  /** Adds our own captured audio in place of whatever the browser captured; null when unavailable. */
  const withCapturedAudio = async (stream: MediaStream): Promise<MediaStream | null> => {
    if (env.bridge.captureSource === 'none') return null;

    const video = stream.getVideoTracks()[0];
    let injected: { track: AudioTrackLike; release(): void };
    try {
      injected = await createCapturedTrack(video);
    } catch (error) {
      log('no system audio capture available', error);
      return null;
    }

    for (const track of stream.getAudioTracks()) track.stop();
    void env.bridge.reportCaptureMode?.({ mode: 'captured-pcm' });
    try {
      const merged = new env.MediaStream([
        ...stream.getVideoTracks(),
        injected.track as unknown as MediaStreamTrack
      ]);
      if (video && typeof video.addEventListener === 'function') {
        video.addEventListener('ended', () => injected.track.stop());
      }
      return merged;
    } catch (error) {
      injected.release();
      log('could not build the shared stream', error);
      return null;
    }
  };

  mediaDevices.getDisplayMedia = async (
    constraints: MediaStreamConstraints = {}
  ): Promise<MediaStream> => {
    const wantsAudio = Boolean(constraints.audio);
    if (!wantsAudio) {
      const stream = await originalGetDisplayMedia(constraints);
      favorMotion(stream);
      return stream;
    }
    if (windows) {
      await windowsShareRelease;
      if (windowsShareOpen) throw new Error('a Windows audio share is already open');
      windowsShareOpen = true;
    }

    let stream: MediaStream;
    try {
      stream = await originalGetDisplayMedia({ ...constraints, audio: true });
      favorMotion(stream);
    } catch (error) {
      windowsShareOpen = false;
      throw error;
    }

    if (windows) {
      const withOurs = await withCapturedAudio(stream);
      if (withOurs) return withOurs;
      for (const track of stream.getAudioTracks()) track.stop();
      void env.bridge.reportCaptureMode?.({ mode: 'system-audio-unavailable' });
      windowsShareOpen = false;
      return new env.MediaStream(stream.getVideoTracks());
    }

    const withOurs = await withCapturedAudio(stream);
    if (withOurs) return withOurs;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      void env.bridge.reportCaptureMode?.({ mode: 'system-audio-unavailable' });
      return stream;
    }

    const heard = await probe(audioTracks[0] as unknown as MediaStreamTrack);
    const forced = env.bridge.forceSystemAudio === true;
    if (heard === false || (heard === null && forced)) {
      // Only an explicit opt-in lets audio through when the probe could not clear it; a capture we
      // measured our own playback in is never shared.
      if (heard === null) log('including system audio although the echo probe was inconclusive (SHARKORD_WINDOWS_AUDIO=on)');
      void env.bridge.reportCaptureMode?.({ mode: 'system-audio', echoTest: heard === false ? 'clean' : 'unknown' });
      return stream;
    }

    const mode: CaptureMode = heard === true ? 'system-audio-echo' : 'system-audio-unavailable';
    log(`dropping system audio (${heard === true ? 'it carries our own playback' : 'our own playback could not be ruled out'})`);
    for (const track of audioTracks) track.stop();
    void env.bridge.reportCaptureMode?.({ mode, echoTest: heard === true ? 'captured' : 'unknown' });
    return stream;
  };

  // The main process checks this to know the patch really landed, rather than reading source text.
  Object.defineProperty(mediaDevices.getDisplayMedia, '__sharkordDesktop', { value: true });
};
