import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export type ChildProcessLike = {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  kill(): void;
};

export type Spawner = (bin: string, args: string[]) => ChildProcessLike;

/** The helper exits with this when the OS refused process loopback for the target. */
export const PERMANENT_EXIT_CODE = 3;
/** The helper exits with this when the process behind the shared window went away. */
export const WINDOW_GONE_EXIT_CODE = 4;

/** What the helper should capture: our whole desktop without ourselves, or one window's app. */
export type WindowsCaptureTarget = { kind: 'screen' } | { kind: 'window'; windowId: string };

const defaultSpawner: Spawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;

/** Where the helper lands: next to the resources in a package, in the tree during development. */
export const helperPath = (): string => {
  const packaged = join(process.resourcesPath ?? '', 'native', 'win-audio-capture.exe');
  if (app.isPackaged) return packaged;
  return join(app.getAppPath(), 'native', 'out', 'win-audio-capture.exe');
};

export const helperExists = (): boolean => process.platform === 'win32' && existsSync(helperPath());

/** `desktopCapturer` ids on Windows are `screen:<display>:<index>` and `window:<hwnd>:<index>`. */
export const windowsTargetForSource = (sourceId: string): WindowsCaptureTarget => {
  const parsed = /^(screen|window):(\d+):(\d+)$/.exec(sourceId);
  if (!parsed) throw new Error(`not a capturable Windows source id: ${sourceId}`);
  if (parsed[1] === 'screen') return { kind: 'screen' };

  const hwnd = Number(parsed[2]);
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || String(hwnd) !== parsed[2]) {
    throw new Error(`the window source has no usable handle: ${sourceId}`);
  }
  return { kind: 'window', windowId: String(hwnd) };
};

export type WindowsCaptureOptions = {
  excludePid?: number;
  sampleRate?: number;
  channels?: number;
  spawner?: Spawner;
  log?: (msg: string, ...rest: unknown[]) => void;
  maxRestarts?: number;
  backoffMs?: number[];
  path?: string;
};

type Waiter = {
  generation: number;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const READY_LINE = /^READY (\d+)$/;

/**
 * System audio without this app: the helper opens a WASAPI process loopback over our own process
 * tree (screen shares) or over the process tree of a chosen window (window shares).
 */
export class WindowsCapture {
  private child: ChildProcessLike | null = null;
  private generation = 0;
  private target: WindowsCaptureTarget | null = null;
  private stopping = true;
  private restarts = 0;
  private ready = false;
  private established = false;
  private waiter: Waiter | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly stoppedCallbacks = new Set<(error: Error) => void>();
  private readonly spawner: Spawner;
  private readonly log: (msg: string, ...rest: unknown[]) => void;

  constructor(private readonly options: WindowsCaptureOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.log = options.log ?? (() => {});
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(target: WindowsCaptureTarget): void {
    if (this.child) {
      const running = this.target;
      const same =
        running !== null &&
        running.kind === target.kind &&
        (target.kind === 'screen' || (running.kind === 'window' && running.windowId === target.windowId));
      if (same) return;
      throw new Error('an audio capture is already running for another source');
    }
    this.stopping = false;
    this.target = target;
    this.restarts = 0;
    this.ready = false;
    this.established = false;
    this.generation += 1;
    this.clearRestart();
    this.failWaiter(new Error('the audio capture was restarted'));
    this.spawnChild();
  }

  /**
   * Resolves once the helper reported that its capture is running — silent apps included — and
   * rejects when the capture never got there or was stopped first.
   */
  waitUntilCapturing(timeoutMs = 7000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.child && !this.restartTimer) {
      return Promise.reject(new Error('the audio helper is not running'));
    }
    if (this.waiter) return this.waiter.promise;

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const generation = this.generation;
    const timer = setTimeout(() => {
      if (this.waiter?.timer !== timer) return;
      this.abort(this.child, new Error('the audio helper was not ready in time'));
    }, timeoutMs);

    this.waiter = { generation, promise, resolve, reject, timer };
    return promise;
  }

  stop(): void {
    this.stopping = true;
    this.generation += 1;
    this.ready = false;
    this.established = false;
    this.target = null;
    this.clearRestart();
    const child = this.child;
    this.child = null;
    child?.kill();
    this.failWaiter(new Error('the audio capture was stopped'));
  }

  onData(callback: (chunk: Buffer) => void): () => void {
    this.dataCallbacks.add(callback);
    return () => {
      this.dataCallbacks.delete(callback);
    };
  }

  /** Reports the final end of a capture that had been running; never fires for an explicit stop. */
  onStopped(callback: (error: Error) => void): () => void {
    this.stoppedCallbacks.add(callback);
    return () => {
      this.stoppedCallbacks.delete(callback);
    };
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private abort(child: ChildProcessLike | null, error: Error): void {
    const wasEstablished = this.established;
    this.stopping = true;
    this.generation += 1;
    this.ready = false;
    this.established = false;
    this.target = null;
    this.clearRestart();
    if (this.child === child) this.child = null;
    child?.kill();
    this.failWaiter(error);
    if (wasEstablished) {
      for (const callback of this.stoppedCallbacks) callback(error);
    }
  }

  private spawnChild(): void {
    const target = this.target;
    if (!target) return;

    const {
      excludePid = process.pid,
      sampleRate = 48000,
      channels = 2,
      path = helperPath()
    } = this.options;

    const args = ['--exclude-pid', String(excludePid)];
    if (target.kind === 'window') args.push('--include-window', target.windowId);
    args.push('--rate', String(sampleRate), '--channels', String(channels));

    const generation = this.generation;
    const child = this.spawner(path, args);
    this.child = child;
    this.ready = false;

    let carry = '';
    child.stdout?.on('data', (chunk) => {
      if (generation !== this.generation || this.child !== child) return;
      for (const callback of this.dataCallbacks) callback(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (generation !== this.generation || this.child !== child) return;
      const lines = (carry + chunk.toString()).split('\n');
      carry = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (READY_LINE.test(line)) {
          this.ready = true;
          this.established = true;
          const waiter = this.waiter;
          if (waiter) {
            this.waiter = null;
            clearTimeout(waiter.timer);
            waiter.resolve();
          }
        }
        this.log(`win-audio-capture: ${line}`);
      }
    });

    child.on('error', (error: Error) => {
      if (generation !== this.generation || this.child !== child) return;
      this.abort(child, error);
      this.log(`cannot run the audio helper: ${error.message}`);
    });

    child.on('exit', (code) => {
      if (generation !== this.generation || this.child !== child) return;
      this.child = null;
      this.ready = false;
      if (this.stopping) return;

      const error = new Error(
        code === WINDOW_GONE_EXIT_CODE
          ? 'the app behind the shared window is gone'
          : `the audio helper exited with code ${code ?? 'null'}`
      );

      if (target.kind === 'window' || code === PERMANENT_EXIT_CODE) {
        if (code === PERMANENT_EXIT_CODE) {
          this.log('the OS refused process loopback for this target');
        }
        this.abort(child, error);
        return;
      }

      const backoff = this.options.backoffMs ?? [250, 500, 1000, 2000, 4000];
      const maxRestarts = this.options.maxRestarts ?? 5;
      if (this.restarts >= maxRestarts) {
        this.log(`the audio helper exited (${code ?? 'null'}) and gave up after ${this.restarts} restarts`);
        this.abort(child, error);
        return;
      }

      const delay = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 4000;
      this.restarts += 1;
      this.log(`audio helper exited (${code ?? 'null'}), restart ${this.restarts} in ${delay}ms`);
      const restartGeneration = this.generation;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (restartGeneration !== this.generation || this.stopping) return;
        this.spawnChild();
      }, delay);
    });
  }
}
