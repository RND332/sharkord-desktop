import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type ChildProcessLike = {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  kill(): void;
};

export type Spawner = (bin: string, args: string[]) => ChildProcessLike;
export type Runner = (bin: string, args: string[]) => Promise<string>;

export type GraphStream = {
  nodeId: number;
  appName: string;
  processId: number | null;
  ports: string[];
};

export type Graph = { streams: GraphStream[]; tapNodeId: number | null };

const defaultSpawner: Spawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;

const defaultRunner: Runner = (bin, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  return promise;
};

type Props = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Reads the pieces of `pw-dump` we care about: every audio playback stream with its node id (names
 * repeat — one Chromium process can have a dozen identically named streams), and the tap node.
 */
export const parseGraph = (json: string, tapName: string): Graph => {
  let objects: unknown;
  try {
    objects = JSON.parse(json);
  } catch {
    return { streams: [], tapNodeId: null };
  }
  if (!Array.isArray(objects)) return { streams: [], tapNodeId: null };

  const streams: GraphStream[] = [];
  const portsByNode = new Map<number, string[]>();
  let tapNodeId: number | null = null;

  for (const entry of objects) {
    const record = entry as {
      id?: unknown;
      type?: unknown;
      info?: { props?: Props; direction?: unknown };
    };
    const props = record.info?.props ?? {};
    const id = num(record.id);

    if (record.type === 'PipeWire:Interface:Node' && id !== null) {
      const mediaClass = props['media.class'];
      if (mediaClass === 'Stream/Output/Audio') {
        streams.push({
          nodeId: id,
          appName: String(props['application.name'] ?? props['node.name'] ?? ''),
          processId: num(props['application.process.id']),
          ports: []
        });
        continue;
      }
      if (mediaClass === 'Stream/Input/Audio' && props['node.name'] === tapName) {
        tapNodeId = id;
      }
      continue;
    }

    // PipeWire spells this "out" in the port properties and "output" in the port info.
    const direction = String(props['port.direction'] ?? record.info?.direction ?? '');
    if (record.type === 'PipeWire:Interface:Port' && (direction === 'out' || direction === 'output')) {
      const owner = num(props['node.id']);
      const name = props['port.name'];
      if (owner === null || typeof name !== 'string') continue;
      portsByNode.set(owner, [...(portsByNode.get(owner) ?? []), name]);
    }
  }

  for (const stream of streams) {
    stream.ports = portsByNode.get(stream.nodeId) ?? [];
  }

  return { streams, tapNodeId };
};

/** Which tap inputs a stream's output port feeds. Mono fans out to both sides. */
export const targetsFor = (port: string): string[] => {
  switch (port) {
    case 'output_FL':
      return ['input_FL'];
    case 'output_FR':
      return ['input_FR'];
    case 'output_MONO':
      return ['input_FL', 'input_FR'];
    default:
      return [];
  }
};

const parentPid = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const parsed = Number(fields[1]);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const isOwnProcess = (pid: number | null, self: number = process.pid): boolean => {
  let current = pid;
  const seen = new Set<number>();
  while (current !== null && current > 1 && !seen.has(current)) {
    if (current === self) return true;
    seen.add(current);
    current = parentPid(current);
  }
  return false;
};

export type TapOptions = {
  tapName?: string;
  sampleRate?: number;
  channels?: number;
  spawner?: Spawner;
  runner?: Runner;
  log?: (msg: string, ...rest: unknown[]) => void;
  pollMs?: number;
  maxRestarts?: number;
  backoffMs?: number[];
  ownsProcess?: (pid: number | null) => boolean;
};

export type TapState = { running: boolean; linked: number; restarts: number };

/**
 * Records the audio of every *other* application by linking their output ports into a plain
 * `pw-record` node. Nothing in the session's routing is touched: no sink is created, no default
 * device changes and no stream is moved — the client's own playback is simply never linked.
 */
export class TapCapture {
  private child: ChildProcessLike | null = null;
  private stopping = true;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private readonly linked = new Set<string>();
  private readonly tappedPids = new Set<number>();
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly stateCallbacks = new Set<(state: TapState) => void>();
  private readonly spawner: Spawner;
  private readonly runner: Runner;
  private readonly tapName: string;
  private readonly ownsProcess: (pid: number | null) => boolean;
  private readonly log: (msg: string, ...rest: unknown[]) => void;

  constructor(private readonly options: TapOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.runner = options.runner ?? defaultRunner;
    this.tapName = options.tapName ?? 'sharkord_capture';
    this.ownsProcess = options.ownsProcess ?? ((pid) => isOwnProcess(pid));
    this.log = options.log ?? (() => {});
  }

  get running(): boolean {
    return this.child !== null;
  }

  get restartCount(): number {
    return this.restarts;
  }

  get tapNode(): string {
    return this.tapName;
  }

  get linkedCount(): number {
    return this.linked.size;
  }

  /** Processes whose playback is currently linked into the tap. */
  get tappedProcessIds(): number[] {
    return [...this.tappedPids];
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.child?.kill();
    this.child = null;
    this.linked.clear();
    this.tappedPids.clear();
    this.emitState();
  }

  onData(callback: (chunk: Buffer) => void): () => void {
    this.dataCallbacks.add(callback);
    return () => {
      this.dataCallbacks.delete(callback);
    };
  }

  onStateChange(callback: (state: TapState) => void): () => void {
    this.stateCallbacks.add(callback);
    return () => {
      this.stateCallbacks.delete(callback);
    };
  }

  /** Links any newly appeared playback stream into the tap. */
  async reconcile(): Promise<void> {
    // The poll timer, the IPC path and the first spawn can all ask at once; coalesce.
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    if (!this.child) return;

    let graph: Graph;
    try {
      graph = parseGraph(await this.runner('pw-dump', ['-i', '0']), this.tapName);
    } catch (error) {
      this.log('could not inspect the pipewire graph:', error);
      return;
    }
    if (graph.tapNodeId === null) return;

    const alive = new Set<number>();
    for (const stream of graph.streams) {
      alive.add(stream.nodeId);
      if (this.ownsProcess(stream.processId)) continue;

      for (const port of stream.ports) {
        for (const target of targetsFor(port)) {
          const key = `${stream.nodeId}:${port}->${target}`;
          if (this.linked.has(key)) continue;
          try {
            await this.runner('pw-link', [`${stream.nodeId}:${port}`, `${graph.tapNodeId}:${target}`]);
            this.linked.add(key);
            if (stream.processId !== null) this.tappedPids.add(stream.processId);
            this.log(`tapped ${stream.appName || stream.nodeId}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('File exists')) {
              this.linked.add(key);
              continue;
            }
            this.log('could not tap', key, message);
          }
        }
      }
    }

    // Streams that vanished take their links with them.
    const alivePids = new Set(
      graph.streams.filter((stream) => alive.has(stream.nodeId)).map((stream) => stream.processId)
    );
    for (const key of [...this.linked]) {
      if (!alive.has(Number(key.slice(0, key.indexOf(':'))))) this.linked.delete(key);
    }
    for (const pid of [...this.tappedPids]) {
      if (!alivePids.has(pid)) this.tappedPids.delete(pid);
    }
    this.emitState();
  }

  private scheduleRestart(code: number | null): void {
    if (this.stopping) {
      this.emitState();
      return;
    }

    const backoff = this.options.backoffMs ?? [250, 500, 1000, 2000, 4000];
    const maxRestarts = this.options.maxRestarts ?? 5;
    if (this.restarts >= maxRestarts) {
      this.log(`pw-record exited (${code}) and gave up after ${this.restarts} restarts`);
      this.emitState();
      return;
    }

    const delay = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 4000;
    this.restarts += 1;
    this.log(`pw-record exited (${code}), restart ${this.restarts} in ${delay}ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
    this.emitState();
  }

  private emitState(): void {
    const state: TapState = { running: this.running, linked: this.linked.size, restarts: this.restarts };
    for (const callback of this.stateCallbacks) callback(state);
  }

  private spawnChild(): void {
    const { sampleRate = 48000, channels = 2 } = this.options;
    const child = this.spawner('pw-record', [
      '-P',
      'node.autoconnect=false',
      '-P',
      `node.name=${this.tapName}`,
      '-P',
      'application.name=sharkord-desktop',
      '-P',
      'node.description=sharkord-desktop',
      '--format',
      'f32',
      `--rate=${sampleRate}`,
      `--channels=${channels}`,
      '-'
    ]);

    this.child = child;
    this.linked.clear();

    child.stdout?.on('data', (chunk) => {
      for (const callback of this.dataCallbacks) callback(chunk);
    });
    child.stderr?.on('data', (chunk) => this.log('pw-record:', chunk.toString().trim()));

    // 'error' and 'exit' can both arrive for one child; the first one wins.
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      if (this.child === child) this.child = null;
      return true;
    };

    child.on('error', (error: Error) => {
      if (!settle()) return;
      const code = (error as NodeJS.ErrnoException).code;
      this.log(`cannot record: ${error.message}`);
      if (code === 'ENOENT') {
        // No PipeWire tools on this machine — retrying will not help.
        this.stopping = true;
        this.emitState();
        return;
      }
      this.scheduleRestart(null);
    });

    child.on('exit', (code) => {
      if (!settle()) return;
      this.scheduleRestart(code);
    });

    const pollMs = this.options.pollMs ?? 1000;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.reconcile();
    }, pollMs);

    void this.reconcile();
    this.emitState();
  }
}
