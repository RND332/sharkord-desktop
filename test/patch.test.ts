import { describe, expect, it, vi } from 'vitest';
import {
  installGetDisplayMediaPatch,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
  type AudioTrackLike,
  type PatchEnvironment
} from '../src/patch';

type FakeTrack = {
  kind: string;
  readyState: string;
  listeners: Record<string, Array<() => void>>;
  stopped: boolean;
  stop(): void;
  addEventListener(type: string, cb: () => void): void;
  emit(type: string): void;
};

const makeTrack = (kind: string): FakeTrack => ({
  kind,
  readyState: 'live',
  listeners: {},
  stopped: false,
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  },
  addEventListener(type, cb) {
    (this.listeners[type] ??= []).push(cb);
  },
  emit(type) {
    for (const cb of this.listeners[type] ?? []) cb();
  }
});

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getTracks(): unknown[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t): t is FakeTrack => (t as FakeTrack).kind === 'video');
  }
  getAudioTracks(): unknown[] {
    return this.tracks.filter((t) => (t as FakeTrack).kind === 'audio');
  }
}

type WriteRecord = {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
};

const makeAudioData = (writes: WriteRecord[]) =>
  class {
    constructor(init: WriteRecord) {
      writes.push(init);
    }
  };

const setup = (options: { resolveWrite?: () => Promise<void> } = {}) => {
  const writes: WriteRecord[] = [];
  const pcmCallbacks: Array<(chunk: Uint8Array) => void> = [];
  const videoTrack = makeTrack('video');
  const originalStream = new FakeMediaStream([videoTrack]) as unknown as MediaStream;
  const generatedTracks: Array<FakeTrack & { writable: { getWriter(): { write(d: unknown): Promise<void> } } }> = [];
  let intervalCallback: (() => void) | null = null;

  const acquireCapture = vi.fn(async () => {});
  const releaseCapture = vi.fn(async () => {});

  class FakeGenerator {
    readyState = 'live';
    writable: { getWriter(): { write(d: unknown): Promise<void> } };
    constructor() {
      (this as unknown as { kind: string }).kind = 'audio';
      this.writable = {
        getWriter: () => ({
          write: () =>
            options.resolveWrite ? options.resolveWrite() : Promise.resolve()
        })
      };
      generatedTracks.push(this as unknown as (typeof generatedTracks)[number]);
    }
    stop(): void {
      this.readyState = 'ended';
    }
    addEventListener(): void {}
  }

  const getDisplayMedia = vi.fn(async () => originalStream);

  const env: PatchEnvironment = {
    mediaDevices: { getDisplayMedia } as unknown as PatchEnvironment['mediaDevices'],
    MediaStream: FakeMediaStream as unknown as PatchEnvironment['MediaStream'],
    MediaStreamTrackGenerator: FakeGenerator as unknown as PatchEnvironment['MediaStreamTrackGenerator'],
    AudioData: makeAudioData(writes) as unknown as PatchEnvironment['AudioData'],
    bridge: {
      platform: 'linux',
      acquireCapture,
      releaseCapture,
      onPcm: (cb) => {
        pcmCallbacks.push(cb);
        return () => {
          const index = pcmCallbacks.indexOf(cb);
          if (index >= 0) pcmCallbacks.splice(index, 1);
        };
      }
    },
    log: () => {},
    setIntervalFn: ((cb: () => void) => {
      intervalCallback = cb;
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval
  };

  installGetDisplayMediaPatch(env);

  return {
    writes,
    mediaDevices: env.mediaDevices,
    getDisplayMedia,
    originalStream,
    videoTrack,
    acquireCapture,
    releaseCapture,
    generatedTracks,
    pushPcm: (chunk: Uint8Array) => pcmCallbacks.forEach((cb) => cb(chunk)),
    tick: () => intervalCallback?.(),
    pcmHandlerCount: () => pcmCallbacks.length
  };
};

const interleaved = (frames: number, value: number): Uint8Array => {
  const samples = new Float32Array(frames * PCM_CHANNELS);
  for (let i = 0; i < samples.length; i += 1) samples[i] = value;
  return new Uint8Array(samples.buffer);
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe('getDisplayMedia patch fail-safe', () => {
  it('records audio itself when the platform is unknown', async () => {
    const writes: WriteRecord[] = [];
    const pcmCallbacks: Array<(chunk: Uint8Array) => void> = [];
    const original = new FakeMediaStream([makeTrack('video')]) as unknown as MediaStream;
    const env: PatchEnvironment = {
      mediaDevices: { getDisplayMedia: vi.fn(async () => original) } as unknown as PatchEnvironment['mediaDevices'],
      MediaStream: FakeMediaStream as unknown as PatchEnvironment['MediaStream'],
      MediaStreamTrackGenerator: class {
        kind = 'audio';
        readyState = 'live';
        writable = { getWriter: () => ({ write: () => Promise.resolve() }) };
        stop(): void {}
        addEventListener(): void {}
      } as unknown as PatchEnvironment['MediaStreamTrackGenerator'],
      AudioData: makeAudioData(writes) as unknown as PatchEnvironment['AudioData'],
      bridge: {
        // undefined on purpose: an older preload, a stripped bridge, anything unexpected
        acquireCapture: vi.fn(async () => {}),
        releaseCapture: vi.fn(async () => {}),
        onPcm: (cb) => {
          pcmCallbacks.push(cb);
          return () => {};
        }
      },
      log: () => {},
      setIntervalFn: (() => 0) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as unknown as typeof clearInterval
    };

    installGetDisplayMediaPatch(env);
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    // The PipeWire path must win: an unknown platform is not a reason to go silent.
    expect(env.bridge.acquireCapture).toHaveBeenCalledTimes(1);
    expect(stream.getAudioTracks()).toHaveLength(1);
  });
});

describe('getDisplayMedia patch on non-PipeWire platforms', () => {
  const windowsSetup = () => {
    const calls: MediaStreamConstraints[] = [];
    const original = new FakeMediaStream([makeTrack('video')]) as unknown as MediaStream;
    const getDisplayMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
      calls.push(constraints ?? {});
      return original;
    });
    const env: PatchEnvironment = {
      mediaDevices: { getDisplayMedia } as unknown as PatchEnvironment['mediaDevices'],
      MediaStream: FakeMediaStream as unknown as PatchEnvironment['MediaStream'],
      MediaStreamTrackGenerator: (() => {}) as unknown as PatchEnvironment['MediaStreamTrackGenerator'],
      AudioData: (() => {}) as unknown as PatchEnvironment['AudioData'],
      bridge: {
        platform: 'win32',
        acquireCapture: vi.fn(async () => {}),
        releaseCapture: vi.fn(async () => {}),
        onPcm: () => () => {}
      },
      log: () => {}
    };
    installGetDisplayMediaPatch(env);
    return { env, calls, original, getDisplayMedia };
  };

  it('leaves a video-only request untouched', async () => {
    const { env, calls, original } = windowsSetup();
    const stream = await env.mediaDevices.getDisplayMedia({ video: true });

    expect(stream).toBe(original);
    expect(calls).toEqual([{ video: true }]);
  });

  it('asks Chromium to keep this app out of the captured system audio', async () => {
    const { env, calls } = windowsSetup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.video).toBe(true);
    expect(calls[0]?.audio).toMatchObject({ echoCancellation: false, restrictOwnAudio: true });
  });

  it('never touches the capture bridge there', async () => {
    const { env } = windowsSetup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.bridge.acquireCapture).not.toHaveBeenCalled();
  });
});

describe('getDisplayMedia patch', () => {
  it('leaves a video-only request untouched', async () => {
    const env = setup();
    const constraints = { video: true };
    const stream = await env.mediaDevices.getDisplayMedia(constraints);

    expect(stream).toBe(env.originalStream);
    expect(env.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(env.acquireCapture).not.toHaveBeenCalled();
  });

  it('adds the captured audio track when audio was requested', async () => {
    const env = setup();
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.acquireCapture).toHaveBeenCalledTimes(1);
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(stream.getVideoTracks()[0]).toBe(env.videoTrack);
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(env.generatedTracks).toHaveLength(1);
  });

  it('falls back to video only when the capture cannot start', async () => {
    const env = setup();
    env.acquireCapture.mockRejectedValueOnce(new Error('parec is dead'));
    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(stream).toBe(env.originalStream);
    expect(env.pcmHandlerCount()).toBe(0);
  });

  it('writes captured PCM as f32 AudioData with a monotonic timestamp', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const frames = 480;
    env.pushPcm(interleaved(frames, 0.25));
    await flush();

    expect(env.writes).toHaveLength(1);
    const write = env.writes[0]!;
    expect(write.format).toBe('f32');
    expect(write.sampleRate).toBe(PCM_SAMPLE_RATE);
    expect(write.numberOfChannels).toBe(PCM_CHANNELS);
    expect(write.numberOfFrames).toBe(frames);
    expect(write.timestamp).toBe(0);
    expect(write.data).toHaveLength(frames * PCM_CHANNELS);
    expect(write.data[0]).toBeCloseTo(0.25, 6);

    env.pushPcm(interleaved(frames, 0.25));
    await flush();
    expect(env.writes).toHaveLength(2);
    expect(env.writes[1]!.timestamp).toBe(Math.round((frames / PCM_SAMPLE_RATE) * 1e6));
  });

  it('drops audio instead of queueing without bound, keeping the timeline', async () => {
    const pendingWrites: Array<{ resolve: () => void }> = [];
    const env = setup({
      resolveWrite: () => {
        const deferred = Promise.withResolvers<void>();
        pendingWrites.push({ resolve: deferred.resolve });
        return deferred.promise;
      }
    });
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    for (let i = 0; i < 30; i += 1) env.pushPcm(interleaved(480, 0.25));
    await flush();

    // The writer never resolved, so only the bounded window of frames was queued.
    expect(env.writes).toHaveLength(12);
    expect(env.writes.map((write) => write.timestamp)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => index * 10_000)
    );

    // Drain the queue, then confirm the clock advanced across the dropped frames.
    for (const write of pendingWrites) write.resolve();
    await flush();
    env.pushPcm(interleaved(480, 0.25));
    await flush();

    expect(env.writes.at(-1)?.timestamp).toBe(300_000);
  });

  it('releases the capture once the injected track ends', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const track = env.generatedTracks[0] as unknown as AudioTrackLike;
    track.stop();

    env.tick();
    await flush();

    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
    expect(env.pcmHandlerCount()).toBe(0);
  });

  it('stops the injected track when the shared video ends', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    env.videoTrack.emit('ended');

    expect(env.generatedTracks[0]!.readyState).toBe('ended');
  });
});
