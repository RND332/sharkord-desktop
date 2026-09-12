import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERMANENT_EXIT_CODE,
  WINDOW_GONE_EXIT_CODE,
  WindowsCapture,
  type ChildProcessLike,
  windowsTargetForSource
} from '../src/main/windows-capture';

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
  const spawner = vi.fn((_bin: string, _args: string[]) => {
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

const banner = (child: FakeChild, pid = 4242): void => {
  child.stderr.emit('data', Buffer.from(`READY ${pid}\n`));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('windowsTargetForSource', () => {
  it('turns a screen source into a whole-desktop capture', () => {
    expect(windowsTargetForSource('screen:0:0')).toEqual({ kind: 'screen' });
    expect(windowsTargetForSource('screen:12:3')).toEqual({ kind: 'screen' });
  });

  it('carries the handle of a window source', () => {
    expect(windowsTargetForSource('window:98765:0')).toEqual({ kind: 'window', windowId: '98765' });
  });

  it('refuses sources it cannot trust rather than widening them', () => {
    const malformed = [
      '',
      'window',
      'window:',
      'window:0:0',
      'window:-1:0',
      'window:12abc:0',
      'window:007:0',
      'window:98765',
      'screen:0',
      'screen:0:0:0',
      'camera:1:0',
      'desktop:1:0'
    ];
    for (const id of malformed) {
      expect(() => windowsTargetForSource(id), id).toThrow();
    }
  });
});

describe('WindowsCapture', () => {
  it('captures the screen by excluding our own process and streams its PCM', () => {
    const { capture, spawner, children } = setup();
    const heard: Buffer[] = [];
    const unsubscribe = capture.onData((chunk) => heard.push(chunk));

    capture.start({ kind: 'screen' });

    expect(spawner).toHaveBeenCalledWith('C:/app/native/win-audio-capture.exe', [
      '--exclude-pid',
      '4242',
      '--rate',
      '48000',
      '--channels',
      '2'
    ]);
    const chunk = Buffer.from([1, 2, 3, 4]);
    children[0]!.stdout.emit('data', chunk);
    expect(heard).toEqual([chunk]);

    unsubscribe();
    children[0]!.stdout.emit('data', chunk);
    expect(heard).toEqual([chunk]);
    expect(capture.running).toBe(true);
    capture.stop();
  });

  it('captures a window by including its handle instead of excluding ourselves', () => {
    const { capture, spawner } = setup();
    capture.start({ kind: 'window', windowId: '98765' });

    expect(spawner).toHaveBeenCalledWith('C:/app/native/win-audio-capture.exe', [
      '--exclude-pid',
      '4242',
      '--include-window',
      '98765',
      '--rate',
      '48000',
      '--channels',
      '2'
    ]);
    capture.stop();
  });

  it('is ready on the banner of a silent app, not on audio or a partial line', async () => {
    const { capture, children } = setup();
    capture.start({ kind: 'screen' });

    let settled = false;
    const waiting = capture.waitUntilCapturing(5000).then(() => {
      settled = true;
    });

    children[0]!.stdout.emit('data', Buffer.from([0, 0, 0, 0]));
    await Promise.resolve();
    expect(settled).toBe(false);

    children[0]!.stderr.emit('data', Buffer.from('capturing\nREA'));
    children[0]!.stderr.emit('data', Buffer.from('DY 4242\r'));
    await Promise.resolve();
    expect(settled).toBe(false);

    children[0]!.stderr.emit('data', Buffer.from('\n'));
    await waiting;
    expect(settled).toBe(true);

    await expect(capture.waitUntilCapturing(5)).resolves.toBeUndefined();
    expect(capture.running).toBe(true);
    capture.stop();
  });

  it('keeps a window capture pointed at its window when the helper fails', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [1], maxRestarts: 5 });
    capture.start({ kind: 'window', windowId: '42' });

    children[0]!.emit('exit', 2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(spawner.mock.calls[0]![1]).toContain('--include-window');
    expect(capture.running).toBe(false);
  });

  it('never restarts a window capture and reports that its app is gone', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [1], maxRestarts: 5 });
    const stopped: Error[] = [];
    capture.onStopped((error) => stopped.push(error));
    capture.start({ kind: 'window', windowId: '1234' });
    banner(children[0]!);

    children[0]!.emit('exit', WINDOW_GONE_EXIT_CODE);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(spawner.mock.calls[0]![1]).toContain('--include-window');
    expect(capture.running).toBe(false);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBeInstanceOf(Error);
  });

  it('restarts a screen capture until the budget runs out', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [2], maxRestarts: 2 });
    capture.start({ kind: 'screen' });

    for (let i = 0; i < 3; i += 1) {
      children.at(-1)!.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(2);
    }

    expect(spawner).toHaveBeenCalledTimes(3);
    expect(capture.running).toBe(false);
    for (const call of spawner.mock.calls) expect(call[1]).not.toContain('--include-window');
  });

  it('gives up on a build that has no process loopback, and reports it to the waiting share', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [1] });
    capture.start({ kind: 'screen' });

    const waiting = capture.waitUntilCapturing(5000);
    const assertion = expect(waiting).rejects.toThrow(/exited/);
    children[0]!.emit('exit', PERMANENT_EXIT_CODE);
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(capture.running).toBe(false);
  });

  it('kills the helper and cleans up when the share is not acquired', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup();
    capture.start({ kind: 'screen' });

    const waiting = capture.waitUntilCapturing(7000);
    const assertion = expect(waiting).rejects.toThrow(/ready/);
    await vi.advanceTimersByTimeAsync(7000);

    await assertion;
    expect(children[0]!.killed).toBe(true);
    expect(capture.running).toBe(false);

    capture.start({ kind: 'window', windowId: '123' });
    expect(spawner).toHaveBeenCalledTimes(2);
    expect(spawner.mock.calls[1]![1]).toContain('--include-window');
    banner(children[1]!, 123);
    await expect(capture.waitUntilCapturing(5)).resolves.toBeUndefined();
    capture.stop();
  });

  it('rejects a pending readiness check on stop, without reporting an unexpected end', async () => {
    const { capture, children } = setup();
    const stopped: Error[] = [];
    capture.onStopped((error) => stopped.push(error));
    capture.start({ kind: 'screen' });

    const waiting = capture.waitUntilCapturing(5000);
    const assertion = expect(waiting).rejects.toThrow(/stopped/);
    capture.stop();
    await assertion;

    children[0]!.stderr.emit('data', Buffer.from('READY 4242\n'));
    children[0]!.emit('exit', 0);

    expect(stopped).toEqual([]);
    expect(capture.running).toBe(false);
  });

  it('ignores everything a helper sends after it was replaced', () => {
    const { capture, spawner, children } = setup();
    const heard: Buffer[] = [];
    capture.onData((chunk) => heard.push(chunk));
    capture.start({ kind: 'screen' });
    const [old] = children;

    capture.stop();
    old!.stdout.emit('data', Buffer.from([9, 9]));
    old!.stderr.emit('data', Buffer.from('READY 4242\n'));
    old!.emit('exit', 1);

    expect(heard).toEqual([]);
    expect(capture.running).toBe(false);
    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it('does not let the previous helper settle the readiness of a new capture', async () => {
    const { capture, children } = setup();
    capture.start({ kind: 'screen' });
    const [old] = children;

    capture.stop();
    capture.start({ kind: 'window', windowId: '31' });

    let settled = false;
    const waiting = capture.waitUntilCapturing(5000).then(() => {
      settled = true;
    });
    old!.stderr.emit('data', Buffer.from('READY 4242\n'));
    await Promise.resolve();
    expect(settled).toBe(false);

    banner(children[1]!);
    await waiting;
    expect(settled).toBe(true);
    capture.stop();
  });

  it('settles a superseded readiness check instead of leaking it across a restart', async () => {
    vi.useFakeTimers();
    const { capture, children } = setup({ backoffMs: [1000] });
    capture.start({ kind: 'screen' });

    const waiting = capture.waitUntilCapturing(60_000);
    const assertion = expect(waiting).rejects.toThrow(/restarted/);
    children[0]!.emit('exit', 1);
    capture.start({ kind: 'window', windowId: '8' });

    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
    expect(children[1]!.killed).toBe(false);
    capture.stop();
  });

  it('ignores a late exit from a helper that started a restart for the previous share', async () => {
    vi.useFakeTimers();
    const { capture, spawner, children } = setup({ backoffMs: [1] });
    capture.start({ kind: 'screen' });
    const [first] = children;

    first!.emit('exit', 1);
    capture.stop();
    capture.start({ kind: 'window', windowId: '99' });
    first!.emit('exit', 1);
    first!.stdout.emit('data', Buffer.from([7]));
    await vi.advanceTimersByTimeAsync(50);

    expect(spawner).toHaveBeenCalledTimes(2);
    expect(children[1]!.killed).toBe(false);
    expect(capture.running).toBe(true);
    capture.stop();
  });

  it('does not retry when the helper cannot even start', () => {
    const { capture, spawner, children } = setup();
    capture.start({ kind: 'screen' });
    children[0]!.emit('error', new Error('ENOENT'));

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(capture.running).toBe(false);
  });
});

it('ignores stale PCM and errors after an automatic helper restart', async () => {
  vi.useFakeTimers();
  const { capture, children } = setup();
  const heard: Buffer[] = [];
  capture.onData((chunk) => heard.push(chunk));
  capture.start({ kind: 'screen' });
  banner(children[0]!);
  children[0]!.emit('exit', 2);
  await vi.advanceTimersByTimeAsync(1);

  children[0]!.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
  expect(heard).toEqual([]);
  children[0]!.emit('error', new Error('late old child failure'));
  expect(capture.running).toBe(true);
  expect(children[1]!.killed).toBe(false);
  capture.stop();
});

it('does not accept a stale READY from an automatically restarted helper', async () => {
  vi.useFakeTimers();
  const { capture, children } = setup();
  capture.start({ kind: 'screen' });
  children[0]!.emit('exit', 2);
  await vi.advanceTimersByTimeAsync(1);
  let ready = false;
  const waiting = capture.waitUntilCapturing().then(() => { ready = true; });

  banner(children[0]!);
  await Promise.resolve();
  expect(ready).toBe(false);
  banner(children[1]!);
  await waiting;
  capture.stop();
});

it('does not treat a retry gap as a ready capture', async () => {
  vi.useFakeTimers();
  const { capture, children } = setup({ backoffMs: [1000] });
  capture.start({ kind: 'screen' });
  banner(children[0]!);
  children[0]!.emit('exit', 1);

  let settled = false;
  const waiting = capture.waitUntilCapturing(50_000).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1000);
  banner(children[1]!);
  await waiting;
  expect(settled).toBe(true);
  capture.stop();
});

it('refuses to capture another source while one is already running', () => {
  const { capture, spawner } = setup();
  capture.start({ kind: 'window', windowId: '11' });

  expect(() => capture.start({ kind: 'window', windowId: '22' })).toThrow();
  expect(() => capture.start({ kind: 'screen' })).toThrow();
  expect(() => capture.start({ kind: 'window', windowId: '11' })).not.toThrow();

  expect(spawner).toHaveBeenCalledTimes(1);
  expect(capture.running).toBe(true);
  capture.stop();
});

it('waits for a restarted helper again but still reports the session ending', async () => {
  vi.useFakeTimers();
  const { capture, children } = setup({ backoffMs: [1], maxRestarts: 1 });
  const stopped: Error[] = [];
  capture.onStopped((error) => stopped.push(error));
  capture.start({ kind: 'screen' });
  banner(children[0]!);

  children[0]!.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(1);

  const waiting = capture.waitUntilCapturing(5000);
  const assertion = expect(waiting).rejects.toThrow(/ready/);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;

  expect(stopped).toHaveLength(1);
  expect(capture.running).toBe(false);
});
