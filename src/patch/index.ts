import { frameInterleavedF32 } from '../shared/pcm';

/** Capture format of the PCM the desktop client injects. */
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
    appInfo?(): Promise<{ version: string; platform: string }>;
    reportCaptureMode?(info: {
      mode: string;
      ownAudioSupported?: boolean;
      ownAudioApplied?: boolean;
    }): Promise<boolean>;
    acquireCapture(): Promise<void>;
    releaseCapture(): Promise<void>;
    onPcm(cb: (chunk: Uint8Array) => void): () => void;
  };
  log?: (...args: unknown[]) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

/**
 * Replaces `getDisplayMedia` so that a screen share carries PC audio:
 * video comes from the real picker, audio is the PCM captured from the
 * virtual sink (every app except this client).
 */
export const installGetDisplayMediaPatch = (env: PatchEnvironment): void => {
  const log = env.log ?? ((...args: unknown[]) => console.warn('[sharkord-desktop]', ...args));
  const setIntervalFn = env.setIntervalFn ?? setInterval;
  const clearIntervalFn = env.clearIntervalFn ?? clearInterval;
  const mediaDevices = env.mediaDevices;
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);

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

  // Windows and macOS hand the capture to Chromium; the only thing left to fix is asking it to
  // leave our own playback out of the system audio, so viewers do not hear themselves.
  const usesPlatformCapture = env.bridge.platform === 'win32' || env.bridge.platform === 'darwin';
  if (usesPlatformCapture) {
    mediaDevices.getDisplayMedia = async (
      constraints: MediaStreamConstraints = {}
    ): Promise<MediaStream> => {
      if (!constraints.audio) return originalGetDisplayMedia(constraints);
      const audio = typeof constraints.audio === 'object' ? constraints.audio : {};
      // restrictOwnAudio is a Chromium-only display-capture constraint, absent from the DOM types.
      const audioWithRestriction = { ...audio, restrictOwnAudio: true } as MediaTrackConstraints;
      const stream = await originalGetDisplayMedia({ ...constraints, audio: audioWithRestriction });

      // Ask the browser whether the exclusion is even a thing here, and whether it took effect:
      // Chromium gates it on the OS (Windows 11) and silently ignores it elsewhere.
      const supported =
        (env.mediaDevices as { getSupportedConstraints?(): Record<string, unknown> }).getSupportedConstraints?.()
          ?.restrictOwnAudio === true;
      const applied =
        (stream.getAudioTracks()[0]?.getSettings?.() as Record<string, unknown> | undefined)?.restrictOwnAudio === true;
      void env.bridge.reportCaptureMode?.({ mode: 'system-audio', ownAudioSupported: supported, ownAudioApplied: applied });
      return stream;
    };
    return;
  }

  mediaDevices.getDisplayMedia = async (
    constraints: MediaStreamConstraints = {}
  ): Promise<MediaStream> => {
    const videoStream = await originalGetDisplayMedia({
      video: constraints.video,
      audio: false
    });

    if (!constraints.audio) return videoStream;

    let injected: { track: AudioTrackLike; release(): void };
    try {
      injected = await createCapturedTrack();
      void env.bridge.reportCaptureMode?.({ mode: 'pipewire-pcm' });
    } catch (error) {
      log('system audio capture unavailable, sharing video only', error);
      return videoStream;
    }

    const stream = new env.MediaStream([
      ...videoStream.getVideoTracks(),
      injected.track as unknown as MediaStreamTrack
    ]);

    const videoTrack = videoStream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.addEventListener === 'function') {
      videoTrack.addEventListener('ended', () => {
        injected.track.stop();
      });
    }

    return stream;
  };
};
