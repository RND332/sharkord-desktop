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

export type AudioDataLike = unknown;

export type EchoTest = 'clean' | 'captured' | 'unknown';

export type CaptureMode =
  | 'captured-pcm'
  | 'system-audio'
  | 'system-audio-echo'
  | 'system-audio-unavailable'
  | 'video-only';

export type PatchEnvironment = {
  mediaDevices: {
    getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  };
  MediaStream: new (tracks?: MediaStreamTrack[]) => MediaStream;
  MediaStreamTrackGenerator: new (init: { kind: 'audio' }) => AudioTrackLike & {
    writable: { getWriter(): { write(data: AudioDataLike): Promise<void> } };
  };
  AudioData: new (init: {
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
  };
  /** Measures whether the capture can hear this app; overridable for tests. */
  probeOwnAudio?: (track: MediaStreamTrack) => Promise<boolean | null>;
  log?: (...args: unknown[]) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

/**
 * Replaces `getDisplayMedia` so a screen share carries PC audio without ever carrying the voice
 * channel back to the people in it:
 *
 * 1. our own capture — PipeWire on Linux, a WASAPI process loopback in exclude mode on Windows —
 *    is injected as an audio track and is echo-free by construction;
 * 2. otherwise the browser's own system-audio capture is measured: a quiet tone is played through
 *    the device the app's voice plays on, and if the capture hears it, the audio is dropped;
 * 3. anything undecidable is treated as echoing, so a share stays video-only rather than sending
 *    the channel back to its own participants.
 */
export const installGetDisplayMediaPatch = (env: PatchEnvironment): void => {
  const log = env.log ?? ((...args: unknown[]) => console.warn('[sharkord-desktop]', ...args));
  const setIntervalFn = env.setIntervalFn ?? setInterval;
  const clearIntervalFn = env.clearIntervalFn ?? clearInterval;
  const mediaDevices = env.mediaDevices;
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  const probe = env.probeOwnAudio ?? ((track: MediaStreamTrack) => probeOwnAudio(track, { log }));

  const createCapturedTrack = async (): Promise<{ track: AudioTrackLike; release(): void }> => {
    const generator = new env.MediaStreamTrackGenerator({ kind: 'audio' });
    await env.bridge.acquireCapture();
    const writer = generator.writable.getWriter();

    let carry: Uint8Array = new Uint8Array(0);
    let timestampUs = 0;
    let pending = 0;
    let released = false;

    const unsubscribe = env.bridge.onPcm((chunk) => {
      const framed = frameInterleavedF32(carry, chunk, PCM_CHANNELS);
      carry = framed.carry;
      for (const frame of framed.frames) {
        const frames = frame.length / PCM_CHANNELS;
        const durationUs = Math.round((frames / PCM_SAMPLE_RATE) * 1e6);
        if (pending < MAX_PENDING_FRAMES) {
          pending += 1;
          writer
            .write(
              new env.AudioData({
                format: 'f32',
                sampleRate: PCM_SAMPLE_RATE,
                numberOfFrames: frames,
                numberOfChannels: PCM_CHANNELS,
                timestamp: timestampUs,
                data: frame
              })
            )
            .catch(() => {})
            .finally(() => {
              pending -= 1;
            });
        }
        // Advance even when dropping, so audio stays in step with the video clock.
        timestampUs += durationUs;
      }
    });

    const release = (): void => {
      if (released) return;
      released = true;
      clearIntervalFn(timer);
      unsubscribe();
      void env.bridge.releaseCapture().catch(() => {});
    };

    const timer = setIntervalFn(() => {
      if (generator.readyState === 'ended') release();
    }, 500);

    return { track: generator, release };
  };

  /** Adds our own captured audio in place of whatever the browser captured; null when unavailable. */
  const withCapturedAudio = async (stream: MediaStream): Promise<MediaStream | null> => {
    if (env.bridge.captureSource === 'none') return null;

    let injected: { track: AudioTrackLike; release(): void };
    try {
      injected = await createCapturedTrack();
    } catch (error) {
      log('no system audio capture available, falling back to the browser\'s own', error);
      return null;
    }

    // Whatever the browser handed us is not part of the share: this capture is the whole story.
    for (const track of stream.getAudioTracks()) track.stop();

    void env.bridge.reportCaptureMode?.({ mode: 'captured-pcm' });
    const merged = new env.MediaStream([
      ...stream.getVideoTracks(),
      injected.track as unknown as MediaStreamTrack
    ]);

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.addEventListener === 'function') {
      videoTrack.addEventListener('ended', () => {
        injected.track.stop();
      });
    }
    return merged;
  };

  mediaDevices.getDisplayMedia = async (
    constraints: MediaStreamConstraints = {}
  ): Promise<MediaStream> => {
    const wantsAudio = Boolean(constraints.audio);
    const stream = await originalGetDisplayMedia(wantsAudio ? { ...constraints, audio: true } : constraints);
    if (!wantsAudio) return stream;

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
