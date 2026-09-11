import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capture, type ChildProcessLike, type Spawner } from '../src/main/capture';

type FakeChild = ChildProcessLike & {
  emitData(chunk: Buffer): void;
  emitExit(code: number | null): void;
  killed: boolean;
  args: string[];
};

const makeSpawner = () => {
  const children: FakeChild[] = [];
  const spawner: Spawner = (bin, args) => {
    const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    const child: FakeChild = {
      killed: false,
      args,
      stdout: { on: (_event, cb) => stdoutHandlers.push(cb) },
      stderr: { on: () => {} },
      on: (_event, cb) => exitHandlers.push(cb),
      kill: () => {
        child.killed = true;
      },
      emitData: (chunk) => stdoutHandlers.forEach((cb) => cb(chunk)),
      emitExit: (code) => exitHandlers.forEach((cb) => cb(code))
    };
    expect(bin).toBe('parec');
    children.push(child);
    return child;
  };
  return { spawner, children };
};

describe('Capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the capture sink monitor as stereo float32', () => {
    const { spawner, children } = makeSpawner();
    const capture = new Capture({ spawner, sinkName: 'sharkord_capture' });

    capture.start();

    expect(children).toHaveLength(1);
    expect(children[0]!.args).toEqual([
      '-d',
      'sharkord_capture.monitor',
      '--format=float32le',
      '--rate=48000',
      '--channels=2',
      '--latency-msec=20'
    ]);
  });

  it('fans chunks out to every subscriber and stops on unsubscribe', () => {
    const { spawner, children } = makeSpawner();
    const capture = new Capture({ spawner });
    const first = vi.fn();
    const second = vi.fn();
    const off = capture.onData(second);

    capture.onData(first);
    capture.start();
    children[0]!.emitData(Buffer.from([1, 2, 3]));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    off();
    children[0]!.emitData(Buffer.from([4, 5, 6]));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('restarts an exited reader with backoff', () => {
    const { spawner, children } = makeSpawner();
    const capture = new Capture({ spawner, backoffMs: [100, 200], maxRestarts: 2 });

    capture.start();
    children[0]!.emitExit(1);
    expect(capture.running).toBe(false);

    vi.advanceTimersByTime(100);
    expect(children).toHaveLength(2);

    children[1]!.emitExit(1);
    vi.advanceTimersByTime(200);
    expect(children).toHaveLength(3);

    children[2]!.emitExit(1);
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(3);
    expect(capture.restartCount).toBe(2);
  });

  it('stays down after stop and kills the reader', () => {
    const { spawner, children } = makeSpawner();
    const capture = new Capture({ spawner });

    capture.start();
    capture.stop();

    expect(children[0]!.killed).toBe(true);
    expect(capture.running).toBe(false);

    children[0]!.emitExit(null);
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(1);
  });

  it('is idempotent on start', () => {
    const { spawner, children } = makeSpawner();
    const capture = new Capture({ spawner });

    capture.start();
    capture.start();
    expect(children).toHaveLength(1);
  });
});
