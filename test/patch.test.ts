import { describe, expect, it, vi } from 'vitest';
import {
  installGetDisplayMediaPatch,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
  type AudioTrackLike,
  type PatchEnvironment
} from '../src/patch';
import { isToneHeard } from '../src/patch/echo-test';

type FakeTrack = {
  kind: string;
  readyState: string;
  listeners: Record<string, Array<() => void>>;
  stopped: boolean;
  contentHint: string;
  stop(): void;
  addEventListener(type: string, cb: () => void): void;
  emit(type: string): void;
};

const makeTrack = (kind: string): FakeTrack => ({
  kind,
  readyState: 'live',
  listeners: {},
  stopped: false,
  contentHint: '',
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
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t): t is FakeTrack => (t as FakeTrack).kind === 'audio');
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

const makeAudioData = (writes: WriteRecord[], onClose: () => void) =>
  class {
    constructor(init: WriteRecord) {
      writes.push(init);
    }
    close(): void {
      onClose();
    }
  };

type SetupOptions = {
  resolveWrite?: () => Promise<void>;
  captureSource?: string;
  probe?: (track: MediaStreamTrack) => Promise<boolean | null>;
  forceSystemAudio?: boolean;
  platform?: string;
  generators?: boolean;
  failWriter?: boolean;
  failGenerator?: boolean;
};

const setup = (options: SetupOptions = {}) => {
  const writes: WriteRecord[] = [];
  const pcmCallbacks: Array<(chunk: Uint8Array) => void> = [];
  const captureEndedCallbacks: Array<() => void> = [];
  let closedData = 0;
  const videoTrack = makeTrack('video');
  const audioTrack = makeTrack('audio');
  const originalStream = new FakeMediaStream([videoTrack, audioTrack]) as unknown as MediaStream;
  const generatedTracks: Array<FakeTrack & { writable: { getWriter(): { write(d: unknown): Promise<void> } } }> = [];
  let intervalCallback: (() => void) | null = null;

  const acquireCapture = vi.fn(async () => {});
  const releaseCapture = vi.fn(async () => {});
  const reportCaptureMode = vi.fn(async () => true);
  const probe = vi.fn(options.probe ?? (async () => null));

  class FakeGenerator {
    readyState = 'live';
    writable: { getWriter(): { write(d: unknown): Promise<void> } };
    constructor() {
      if (options.failGenerator) throw new Error('generator allocation failed');
      (this as unknown as { kind: string }).kind = 'audio';
      this.writable = {
        getWriter: () => {
          if (options.failWriter) throw new Error('writer unavailable');
          return {
            write: () => (options.resolveWrite ? options.resolveWrite() : Promise.resolve())
          };
        }
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
    MediaStreamTrackGenerator: (options.generators === false
      ? undefined
      : FakeGenerator) as unknown as PatchEnvironment['MediaStreamTrackGenerator'],
    AudioData: (options.generators === false
      ? undefined
      : makeAudioData(writes, () => {
          closedData += 1;
        })) as unknown as PatchEnvironment['AudioData'],
    probeOwnAudio: probe,
    bridge: {
      platform: options.platform ?? 'win32',
      captureSource: options.captureSource ?? 'windows',
      forceSystemAudio: options.forceSystemAudio,
      reportCaptureMode,
      acquireCapture,
      releaseCapture,
      onPcm: (cb) => {
        pcmCallbacks.push(cb);
        return () => {
          const index = pcmCallbacks.indexOf(cb);
          if (index >= 0) pcmCallbacks.splice(index, 1);
        };
      },
      onCaptureEnded: (cb) => {
        captureEndedCallbacks.push(cb);
        return () => {
          const index = captureEndedCallbacks.indexOf(cb);
          if (index >= 0) captureEndedCallbacks.splice(index, 1);
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
    audioTrack,
    acquireCapture,
    releaseCapture,
    reportCaptureMode,
    probe,
    generatedTracks,
    pushPcm: (chunk: Uint8Array) => pcmCallbacks.forEach((cb) => cb(chunk)),
    tick: () => intervalCallback?.(),
    pcmHandlerCount: () => pcmCallbacks.length,
    emitCaptureEnded: () => captureEndedCallbacks.slice().forEach((cb) => cb()),
    endedHandlerCount: () => captureEndedCallbacks.length,
    audioDataClosed: () => closedData
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

describe('echo verdict from the probe', () => {
  it('needs a clear tone, not a hopeful noise floor', () => {
    expect(isToneHeard(-40, -70)).toBe(true); // tone sits 30 dB above the idle band
    expect(isToneHeard(-66, -70)).toBe(false); // 4 dB: the speakers likely never reproduced it
    expect(isToneHeard(-95, -110)).toBe(null); // nothing measurable: no verdict either way
    expect(isToneHeard(Number.NEGATIVE_INFINITY, -70)).toBe(null);
  });
});

describe('display-media patch: a video-only request changes nothing', () => {
  it('passes the constraints through untouched', async () => {
    const env = setup();
    const stream = await env.mediaDevices.getDisplayMedia({ video: true });

    expect(stream).toBe(env.originalStream);
    expect(env.getDisplayMedia).toHaveBeenCalledWith({ video: true });
    expect(env.acquireCapture).not.toHaveBeenCalled();
    expect(env.reportCaptureMode).not.toHaveBeenCalled();
  });

  it('keeps the settings-selected frame-rate target and marks the track for motion', async () => {
    const env = setup();
    const constraints = {
      video: { frameRate: { max: 47 }, width: { ideal: 1920 } },
      audio: false
    };
    const stream = await env.mediaDevices.getDisplayMedia(constraints);

    expect(stream).toBe(env.originalStream);
    expect(env.getDisplayMedia).toHaveBeenCalledWith(constraints);
    expect(env.videoTrack.contentHint).toBe('motion');
  });
});

describe('display-media patch: our own capture', () => {
  it('replaces the browser audio with the captured track', async () => {
    const env = setup();
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.acquireCapture).toHaveBeenCalledTimes(1);
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(stream.getVideoTracks()[0]).toBe(env.videoTrack);
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(env.generatedTracks).toHaveLength(1);
    // the browser's own system-audio track must not survive into the share
    expect(env.audioTrack.stopped).toBe(true);
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'captured-pcm' });
    expect(env.probe).not.toHaveBeenCalled();
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

  it('never sends browser loopback when Windows isolation fails', async () => {
    const env = setup({ probe: async () => false, forceSystemAudio: true });
    env.acquireCapture.mockRejectedValueOnce(new Error('native capture unavailable'));

    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.audioTrack.stopped).toBe(true);
    expect(stream.getAudioTracks()).toEqual([]);
    expect(stream.getVideoTracks()).toEqual([env.videoTrack]);
    expect(env.generatedTracks.every((track) => track.readyState === 'ended')).toBe(true);
  });

  it('never sends browser loopback when the Windows helper is missing', async () => {
    const env = setup({ captureSource: 'none', probe: async () => false, forceSystemAudio: true });

    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.audioTrack.stopped).toBe(true);
    expect(stream.getAudioTracks()).toEqual([]);
    expect(stream.getVideoTracks()).toEqual([env.videoTrack]);
  });
});

describe('display-media patch: Windows audio ownership', () => {
  it('refuses a second audio share while one is still open', async () => {
    const env = setup();
    const first = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;
    expect(first.getAudioTracks()).toHaveLength(1);

    await expect(env.mediaDevices.getDisplayMedia({ video: true, audio: true })).rejects.toThrow();
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(env.acquireCapture).toHaveBeenCalledTimes(1);
  });

  it('hands the next share the capture as soon as the injected track stops', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    env.generatedTracks[0]!.stop();

    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
    expect(env.pcmHandlerCount()).toBe(0);
    await flush();

    const next = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;
    expect(next.getAudioTracks()).toHaveLength(1);
    expect(env.acquireCapture).toHaveBeenCalledTimes(2);
  });

  it('waits for the previous release before opening the next audio picker', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    env.generatedTracks[0]!.stop();

    // The release is still in flight: a request issued now must not start a picker before it lands.
    const next = env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(2);
    expect((await next).getAudioTracks()).toHaveLength(1);
  });

  it('releases the capture when the shared video is stopped without an ended event', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    env.videoTrack.stop();
    env.tick();
    await flush();

    expect(env.generatedTracks[0]!.readyState).toBe('ended');
    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
  });

  it('tears the injected audio down when the native capture ends on its own', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    env.emitCaptureEnded();
    await flush();

    expect(env.generatedTracks[0]!.readyState).toBe('ended');
    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
    expect(env.endedHandlerCount()).toBe(0);

    const next = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;
    expect(next.getAudioTracks()).toHaveLength(1);
  });

  it('closes each AudioData once the writer took it', async () => {
    const env = setup();
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    env.pushPcm(interleaved(480, 0.25));
    await flush();

    expect(env.writes).toHaveLength(1);
    expect(env.audioDataClosed()).toBe(1);
  });

  it('gives the capture back when setting up the injected track fails', async () => {
    const env = setup({ failWriter: true });
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.acquireCapture).toHaveBeenCalledTimes(1);
    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
    expect(env.pcmHandlerCount()).toBe(0);
    expect(env.audioTrack.stopped).toBe(true);
    expect(stream.getAudioTracks()).toEqual([]);
    expect(stream.getVideoTracks()).toEqual([env.videoTrack]);
  });

  it('lets the next share through after a failed capture, and never probes', async () => {
    const env = setup({ probe: async () => false, forceSystemAudio: true });
    env.acquireCapture.mockRejectedValueOnce(new Error('helper is missing'));

    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });
    expect(env.probe).not.toHaveBeenCalled();

    const next = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;
    expect(next.getAudioTracks()).toHaveLength(1);
    expect(env.acquireCapture).toHaveBeenCalledTimes(2);
  });

  it('keeps failing closed when the capture constructors are missing', async () => {
    const env = setup({ generators: false, forceSystemAudio: true, probe: async () => false });
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.acquireCapture).not.toHaveBeenCalled();
    expect(env.probe).not.toHaveBeenCalled();
    expect(env.audioTrack.stopped).toBe(true);
    expect(stream.getAudioTracks()).toEqual([]);
    expect(stream.getVideoTracks()).toEqual([env.videoTrack]);
  });
});

describe('display-media patch: no capture of our own', () => {
  const noCapture = { captureSource: 'none' as const, platform: 'darwin' as const };

  it('keeps system audio only when the probe cleared it', async () => {
    const env = setup({ ...noCapture, probe: async () => false });
    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.acquireCapture).not.toHaveBeenCalled();
    expect(env.probe).toHaveBeenCalledTimes(1);
    expect(stream).toBe(env.originalStream);
    expect(env.audioTrack.stopped).toBe(false);
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio', echoTest: 'clean' });
  });

  it('drops audio the probe heard this app in', async () => {
    const env = setup({ ...noCapture, probe: async () => true });
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.audioTrack.stopped).toBe(true);
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(stream.getAudioTracks()).toHaveLength(1); // stopped, so nothing is sent
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio-echo', echoTest: 'captured' });
  });

  it('treats an inconclusive probe as echoing', async () => {
    const env = setup({ ...noCapture, probe: async () => null });
    await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.audioTrack.stopped).toBe(true);
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio-unavailable', echoTest: 'unknown' });
  });

  it('lets an explicit opt-in share unproven audio, but never audio it heard us in', async () => {
    const forced = setup({ ...noCapture, probe: async () => null, forceSystemAudio: true });
    await forced.mediaDevices.getDisplayMedia({ video: true, audio: true });
    expect(forced.audioTrack.stopped).toBe(false);
    expect(forced.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio', echoTest: 'unknown' });

    const heard = setup({ ...noCapture, probe: async () => true, forceSystemAudio: true });
    await heard.mediaDevices.getDisplayMedia({ video: true, audio: true });
    expect(heard.audioTrack.stopped).toBe(true);
  });

  it('reports when the browser offered no system audio at all', async () => {
    const env = setup(noCapture);
    env.getDisplayMedia.mockResolvedValueOnce(
      new FakeMediaStream([makeTrack('video')]) as unknown as MediaStream
    );

    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(env.probe).not.toHaveBeenCalled();
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio-unavailable' });
    expect((stream as unknown as FakeMediaStream).getVideoTracks()).toHaveLength(1);
  });
});

describe('display-media patch fallbacks', () => {
  it('tries the capture even when the bridge never said it has one', async () => {
    const env = setup({ captureSource: 'unknown' });
    const stream = (await env.mediaDevices.getDisplayMedia({ video: true, audio: true })) as unknown as FakeMediaStream;

    expect(env.acquireCapture).toHaveBeenCalledTimes(1);
    expect(stream.getAudioTracks()).toHaveLength(1);
  });

  it('falls back to the probe when the capture cannot start', async () => {
    const env = setup({ platform: 'linux', captureSource: 'pipewire', probe: async () => false });
    env.acquireCapture.mockRejectedValueOnce(new Error('helper is missing'));

    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(stream).toBe(env.originalStream);
    expect(env.pcmHandlerCount()).toBe(0);
    expect(env.reportCaptureMode).toHaveBeenCalledWith({ mode: 'system-audio', echoTest: 'clean' });
  });

  it('marks the patched function so the main process can verify it landed', async () => {
    const env = setup();
    expect(
      (env.mediaDevices.getDisplayMedia as unknown as { __sharkordDesktop?: boolean }).__sharkordDesktop
    ).toBe(true);
  });
});

describe('Windows capture setup failures', () => {
  it('releases an acquired helper when the generator constructor throws', async () => {
    const env = setup({ failGenerator: true });
    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(stream.getAudioTracks()).toEqual([]);
    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
  });

  it('does not return a live track when capture ends during acquisition', async () => {
    const env = setup();
    env.acquireCapture.mockImplementationOnce(async () => env.emitCaptureEnded());
    const stream = await env.mediaDevices.getDisplayMedia({ video: true, audio: true });

    expect(stream.getAudioTracks()).toEqual([]);
    expect(env.releaseCapture).toHaveBeenCalledTimes(1);
  });
});
