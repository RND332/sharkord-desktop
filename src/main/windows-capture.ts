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

/** The helper exits with this when the OS itself has no process loopback (Windows 10 and older). */
export const PERMANENT_EXIT_CODE = 3;

const defaultSpawner: Spawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;

/** Where the helper lands: next to the resources in a package, in the tree during development. */
export const helperPath = (): string => {
  const packaged = join(process.resourcesPath ?? '', 'native', 'win-audio-capture.exe');
  if (app.isPackaged) return packaged;
  return join(app.getAppPath(), 'native', 'out', 'win-audio-capture.exe');
};

export const helperExists = (): boolean => process.platform === 'win32' && existsSync(helperPath());

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

/**
 * System audio without this app: the helper opens a WASAPI process loopback in exclude mode for
 * our process tree. Windows only offers that from a certain build onwards, so a helper that cannot
 * activate simply exits — the caller then falls back to video-only sharing.
 */
export class WindowsCapture {
  private child: ChildProcessLike | null = null;
  private stopping = true;
  private restarts = 0;
  private sawAudio = false;
  private waiter: { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly spawner: Spawner;
  private readonly log: (msg: string, ...rest: unknown[]) => void;

  constructor(private readonly options: WindowsCaptureOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.log = options.log ?? (() => {});
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.restarts = 0;
    this.sawAudio = false;
    this.spawnChild();
  }

  /**
   * Resolves once the helper is really producing audio, rejects when it died first — which is how a
   * Windows build below 20348 answers, since exclude mode simply is not there.
   */
  waitUntilCapturing(timeoutMs = 2000): Promise<void> {
    if (this.sawAudio) return Promise.resolve();
    if (!this.child) return Promise.reject(new Error('the audio helper is not running'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.waiter = null;
        reject(new Error('the audio helper produced no audio'));
      }, timeoutMs);

      this.waiter = {
        resolve: () => {
          clearTimeout(timer);
          if (this.waiter?.timer === timer) this.waiter = null;
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          if (this.waiter?.timer === timer) this.waiter = null;
          reject(error);
        },
        timer
      };
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.child?.kill();
    this.child = null;
  }

  onData(callback: (chunk: Buffer) => void): () => void {
    this.dataCallbacks.add(callback);
    return () => {
      this.dataCallbacks.delete(callback);
    };
  }

  private spawnChild(): void {
    const {
      excludePid = process.pid,
      sampleRate = 48000,
      channels = 2,
      path = helperPath()
    } = this.options;

    const child = this.spawner(path, [
      '--exclude-pid',
      String(excludePid),
      '--rate',
      String(sampleRate),
      '--channels',
      String(channels)
    ]);

    this.child = child;
    child.stdout?.on('data', (chunk) => {
      this.sawAudio = true;
      this.waiter?.resolve();
      for (const callback of this.dataCallbacks) callback(chunk);
    });
    child.stderr?.on('data', (chunk) => this.log('win-audio-capture:', chunk.toString().trim()));

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      if (this.child === child) this.child = null;
      return true;
    };

    child.on('error', (error: Error) => {
      if (!settle()) return;
      this.waiter?.reject(error);
      this.log(`cannot run the audio helper: ${error.message}`);
      this.stopping = true; // nothing to retry
    });

    child.on('exit', (code) => {
      if (!settle()) return;
      this.waiter?.reject(new Error(`the audio helper exited with code ${code ?? 'null'}`));
      if (this.stopping) return;

      // Exit 3 is the helper saying the OS has no exclude mode at all: retrying changes nothing.
      if (code === PERMANENT_EXIT_CODE) {
        this.stopping = true;
        this.log('this Windows build has no process-excluding loopback; system audio will be measured instead');
        return;
      }

      const backoff = this.options.backoffMs ?? [250, 500, 1000, 2000, 4000];
      const maxRestarts = this.options.maxRestarts ?? 5;
      if (this.restarts >= maxRestarts) {
        this.log(`audio helper exited (${code}) and gave up after ${this.restarts} restarts`);
        return;
      }

      const delay = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 4000;
      this.restarts += 1;
      this.log(`audio helper exited (${code}), restart ${this.restarts} in ${delay}ms`);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopping) this.spawnChild();
      }, delay);
    });
  }
}
