import { spawn } from 'node:child_process';

export type ChildProcessLike = {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(): void;
};

export type Spawner = (bin: string, args: string[]) => ChildProcessLike;

export type CaptureOptions = {
  sinkName?: string;
  sampleRate?: number;
  channels?: number;
  latencyMs?: number;
  spawner?: Spawner;
  log?: (msg: string, ...rest: unknown[]) => void;
  maxRestarts?: number;
  backoffMs?: number[];
};

export type CaptureState = { running: boolean; restarts: number };

const defaultSpawner: Spawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;

const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 4000];

/** Keeps a `parec` reading the capture sink's monitor alive, restarting it when PipeWire hiccups. */
export class Capture {
  private child: ChildProcessLike | null = null;
  private stopping = true;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly stateCallbacks = new Set<(state: CaptureState) => void>();

  constructor(private readonly options: CaptureOptions = {}) {}

  get running(): boolean {
    return this.child !== null;
  }

  get restartCount(): number {
    return this.restarts;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.restarts = 0;
    this.spawnChild();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.child?.kill();
    this.child = null;
    this.emitState();
  }

  onData(callback: (chunk: Buffer) => void): () => void {
    this.dataCallbacks.add(callback);
    return () => {
      this.dataCallbacks.delete(callback);
    };
  }

  onStateChange(callback: (state: CaptureState) => void): () => void {
    this.stateCallbacks.add(callback);
    return () => {
      this.stateCallbacks.delete(callback);
    };
  }

  private emitState(): void {
    const state: CaptureState = { running: this.running, restarts: this.restarts };
    for (const callback of this.stateCallbacks) callback(state);
  }

  private spawnChild(): void {
    const {
      sinkName = 'sharkord_capture',
      sampleRate = 48000,
      channels = 2,
      latencyMs = 20
    } = this.options;

    const spawner = this.options.spawner ?? defaultSpawner;
    const child = spawner('parec', [
      '-d',
      `${sinkName}.monitor`,
      '--format=float32le',
      `--rate=${sampleRate}`,
      `--channels=${channels}`,
      `--latency-msec=${latencyMs}`
    ]);

    this.child = child;
    child.stdout?.on('data', (chunk) => {
      for (const callback of this.dataCallbacks) callback(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      this.options.log?.('parec:', chunk.toString().trim());
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopping) {
        this.emitState();
        return;
      }

      const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
      const maxRestarts = this.options.maxRestarts ?? 5;
      if (this.restarts >= maxRestarts) {
        this.options.log?.(`parec exited (${code}) and gave up after ${this.restarts} restarts`);
        this.emitState();
        return;
      }

      const delay = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 4000;
      this.restarts += 1;
      this.options.log?.(`parec exited (${code}), restart ${this.restarts} in ${delay}ms`);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopping) this.spawnChild();
      }, delay);
      this.emitState();
    });

    this.emitState();
  }
}
