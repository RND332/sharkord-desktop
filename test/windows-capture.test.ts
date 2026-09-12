import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsCapture, type ChildProcessLike } from '../src/main/windows-capture';

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): void {
    this.killed = true;
  }
}

const setup = (options: { backoffMs?: number[]; maxRestarts?: number } = {}) => {
  const children: FakeChild[] = [];
  const spawner = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const logs: string[] = [];
  const capture = new WindowsCapture({
    excludePid: 4242,
    path: 'C:/app/native/win-audio-capture.exe',
    spawner,
    log: (message) => logs.push(message),
    backoffMs: options.backoffMs ?? [1],
    maxRestarts: options.maxRestarts ?? 2
  });
  return { capture, spawner, children, logs };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('WindowsCapture', () => {
  it('runs the helper against our own process and streams its PCM', () => {
    const { capture, spawner, children } = setup();
    const heard: Buffer[] = [];
    capture.onData((chunk) => heard.push(chunk));

    capture.start();

    expect(spawner).toHaveBeenCalledWith('C:/app/native/win-audio-capture.exe', [
      '--exclude-pid',
      '4242',
      '--rate',
      '48000',
      '--channels',
      '2'
    ]);
    children[0]!.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
    expect(heard).toEqual([Buffer.from([1, 2, 3, 4])]);
    expect(capture.running).toBe(true);
  });

  it('restarts until the helper stays up', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [250] });
    capture.start();

    children[0]!.emit('exit', 2); // e.g. the OS refused exclude mode at startup
    expect(spawner).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(spawner).toHaveBeenCalledTimes(2);
    expect(capture.running).toBe(true);
    capture.stop();
  });

  it('gives up after the restart budget and says so', async () => {
    vi.useFakeTimers();
    const { capture, children, logs } = setup({ backoffMs: [1], maxRestarts: 2 });
    capture.start();

    for (let i = 0; i < 3; i += 1) {
      children.at(-1)!.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(children).toHaveLength(3); // first run + two restarts
    expect(logs.some((line) => line.includes('gave up'))).toBe(true);
    capture.stop();
  });

  it('stops for good when told to, without restarting', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [1] });
    capture.start();
    capture.stop();

    children[0]!.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(50);

    expect(children[0]!.killed).toBe(true);
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(capture.running).toBe(false);
  });

  it('does not retry when the helper cannot even start', () => {
    const { capture, spawner, children, logs } = setup();
    capture.start();
    children[0]!.emit('error', new Error('ENOENT'));

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes('ENOENT'))).toBe(true);
    expect(capture.running).toBe(false);
  });
});
