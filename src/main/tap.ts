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

export type GraphVideoCapture = {
  nodeId: number;
  processId: number | null;
  targetSerials: string[];
};

export type Graph = { streams: GraphStream[]; tapNodeId: number | null; videoCaptures: GraphVideoCapture[] };

const defaultSpawner: Spawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;

export const defaultRunner: Runner = (bin, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3000, killSignal: 'SIGTERM' }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  return promise;
};

type Props = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const PORTAL_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safeSerial = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
};

/**
 * Reads audio output, capture video, and the tap from `pw-dump`. PipeWire global node IDs are
 * transient; portal serials are resolved from the referenced source node's `object.serial`.
 */
export const parseGraph = (json: string, tapName: string, strict = false): Graph => {
  let objects: unknown;
  try {
    objects = JSON.parse(json);
  } catch {
    if (strict) throw new Error('PipeWire graph is not valid JSON');
    return { streams: [], tapNodeId: null, videoCaptures: [] };
  }
  if (!Array.isArray(objects)) {
    if (strict) throw new Error('PipeWire graph is not an object array');
    return { streams: [], tapNodeId: null, videoCaptures: [] };
  }

  const streams: GraphStream[] = [];
  const rawVideoCaptures: Array<{ nodeId: number; processId: number | null; clientId: number | null; refs: unknown[] }> = [];
  const portsByNode = new Map<number, string[]>();
  const clientPids = new Map<number, number>();
  const audioClientPids = new Map<number, number>();
  const streamClients = new Map<number, number>();
  const videoNodeSerials = new Map<number, string>();
  let tapNodeId: number | null = null;

  for (const entry of objects) {
    const record = entry as {
      id?: unknown;
      type?: unknown;
      info?: { props?: Props; direction?: unknown };
    };
    const props = record.info?.props ?? {};
    const id = num(record.id);

    if (record.type === 'PipeWire:Interface:Client' && id !== null) {
      const pid = num(props['application.process.id']);
      if (pid !== null) clientPids.set(id, pid);
      // Audio consent uses the protocol's read-only peer PID, never a node's
      // self-reported application PID. A proxy's differing application claim
      // does not authenticate its underlying client, so omit that audio.
      const peerPid = num(props['pipewire.sec.pid']);
      if (peerPid !== null && (props['application.process.id'] === undefined || pid === peerPid)) {
        audioClientPids.set(id, peerPid);
      }
    }

    if (record.type === 'PipeWire:Interface:Node' && id !== null) {
      const mediaClass = props['media.class'];
      if (mediaClass === 'Video/Source') {
        const serial = safeSerial(props['object.serial']);
        if (serial) videoNodeSerials.set(id, serial);
      }
      if (mediaClass === 'Stream/Input/Video') {
        const clientId = num(props['client.id']);
        rawVideoCaptures.push({
          nodeId: id,
          processId: num(props['application.process.id']),
          clientId,
          refs: [props['node.target'], props['node.driver-id']].filter((value) => value !== undefined && value !== null)
        });
        continue;
      }
      if (mediaClass === 'Stream/Output/Audio') {
        const clientId = num(props['client.id']);
        if (clientId !== null) streamClients.set(id, clientId);
        streams.push({
          nodeId: id,
          appName: String(props['application.name'] ?? props['node.name'] ?? ''),
          processId: null,
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

  const videoSerialNodes = new Map<string, number[]>();
  for (const [nodeId, serial] of videoNodeSerials) {
    videoSerialNodes.set(serial, [...(videoSerialNodes.get(serial) ?? []), nodeId]);
  }
  const resolveRef = (value: unknown): string | null => {
    const ref = safeSerial(value);
    if (!ref) return null;
    const serialNodes = videoSerialNodes.get(ref) ?? [];
    const nodeSerial = videoNodeSerials.get(Number(ref));
    const matches = new Set([...serialNodes, ...(nodeSerial ? [Number(ref)] : [])]
      .map((nodeId) => videoNodeSerials.get(nodeId))
      .filter((serial): serial is string => serial !== undefined));
    return matches.size === 1 ? [...matches][0]! : null;
  };

  for (const stream of streams) {
    stream.ports = portsByNode.get(stream.nodeId) ?? [];
    stream.processId = audioClientPids.get(streamClients.get(stream.nodeId) ?? -1) ?? null;
  }

  const videoCaptures = rawVideoCaptures.map((capture) => {
    const processId = capture.processId ?? clientPids.get(capture.clientId ?? -1) ?? null;
    const targetSerials = [...new Set(capture.refs.map(resolveRef).filter((serial): serial is string => serial !== null))];
    return { nodeId: capture.nodeId, processId, targetSerials };
  });

  return { streams, tapNodeId, videoCaptures };
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

export const readProcessStat = (pid: number, procRoot = '/proc'): ProcessStat | null => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(parent) || parent < 0 || !startTime || !/^\d+$/.test(startTime)) return null;
    return { parentPid: parent, startTime };
  } catch {
    return null;
  }
};

export type ProcessStat = { parentPid: number; startTime: string };
export const readProcessIdentity = (pid: number, procRoot = '/proc'): { pid: number; startTime: string } | null => {
  const stat = readProcessStat(pid, procRoot);
  return stat ? { pid, startTime: stat.startTime } : null;
};

export const isOwnProcess = (pid: number | null, self: number = process.pid): boolean => {
  let current = pid;
  const seen = new Set<number>();
  while (current !== null && current > 1 && !seen.has(current)) {
    if (current === self) return true;
    seen.add(current);
    current = readProcessStat(current)?.parentPid ?? null;
  }
  return false;
};

export const isProcessInFamily = (
  pid: number | null,
  targetPid: number,
  targetStartTime: string,
  readStat: (pid: number) => ProcessStat | null = readProcessStat
): boolean => {
  let current = pid;
  const seen = new Set<number>();
  while (current !== null && current > 1 && !seen.has(current)) {
    const stat = readStat(current);
    if (!stat) return false;
    if (current === targetPid) return stat.startTime === targetStartTime;
    seen.add(current);
    current = stat.parentPid;
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
  captureProcess?: (pid: number | null) => boolean;
  processStat?: (pid: number) => ProcessStat | null;
};

export type TapState = { running: boolean; linked: number; restarts: number };
export type PortalTargetFields = {
  portalGeneration?: string;
  portalSourceType?: 1 | 2;
  portalPipewireSerial?: string;
  portalOutput?: string;
  portalWindowClass?: string;
  /** Opaque restore token data; never interpreted as a compositor address or PID. */
  portalWindowHandle?: string;
};
export type TapTarget =
  | ({ kind: 'screen' } & PortalTargetFields)
  | ({ kind: 'application'; processId: number; processStartTime: string } & PortalTargetFields);

/**
 * Records the selected application's process tree (or every *other* application for a screen)
 * by linking their output ports into a plain
 * `pw-record` node. Nothing in the session's routing is touched: no sink is created, no default
 * device changes and no stream is moved — the client's own playback is simply never linked.
 */
export class TapCapture {
  private target: TapTarget = { kind: 'screen' };
  private child: ChildProcessLike | null = null;
  private stopping = true;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private reconcileGeneration = 0;
  private readonly linked = new Set<string>();
  private readonly tappedPids = new Set<number>();
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly stateCallbacks = new Set<(state: TapState) => void>();
  private readonly spawner: Spawner;
  private readonly runner: Runner;
  private readonly tapName: string;
  private readonly ownsProcess: (pid: number | null) => boolean;
  private readonly captureProcess: (pid: number | null) => boolean;
  private readonly processStat: (pid: number) => ProcessStat | null;
  private readonly log: (msg: string, ...rest: unknown[]) => void;

  constructor(private readonly options: TapOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.runner = options.runner ?? defaultRunner;
    this.tapName = options.tapName ?? 'sharkord_capture';
    this.ownsProcess = options.ownsProcess ?? ((pid) => isOwnProcess(pid));
    this.captureProcess = options.captureProcess ?? ((pid) => isOwnProcess(pid));
    this.processStat = options.processStat ?? readProcessStat;
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

  start(target: TapTarget = { kind: 'screen' }): boolean {
    if (this.child || this.timer) return false;
    const hasPortalMetadata = target.portalGeneration !== undefined ||
      target.portalSourceType !== undefined || target.portalPipewireSerial !== undefined;
    const validPortalMetadata = !hasPortalMetadata || (
      PORTAL_GENERATION_PATTERN.test(target.portalGeneration ?? '') &&
      /^[1-9][0-9]{0,19}$/.test(target.portalPipewireSerial ?? '') &&
      (target.kind === 'screen'
        ? target.portalSourceType === 1 && typeof target.portalOutput === 'string' &&
          target.portalOutput.length > 0 && Buffer.byteLength(target.portalOutput, 'utf8') <= 512
        : target.portalSourceType === 2 && typeof target.portalWindowClass === 'string' &&
          target.portalWindowClass.length > 0 && Buffer.byteLength(target.portalWindowClass, 'utf8') <= 512)
    );
    if (!validPortalMetadata || (target.kind === 'application' && !this.hasCurrentTargetProcess(target))) {
      this.log('selected capture identity changed or its portal metadata is incomplete');
      return false;
    }
    this.target = target;
    this.stopping = false;
    this.reconciling = null;
    this.reconcileGeneration += 1;
    this.restarts = 0;
    this.spawnChild();
    return true;
  }

  stop(): void {
    this.stopping = true;
    this.reconcileGeneration += 1;
    this.reconciling = null;
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
    const child = this.child;
    if (!child) return;
    if (this.reconciling) return this.reconciling;
    const generation = this.reconcileGeneration;
    const promise = this.doReconcile(child, generation);
    this.reconciling = promise;
    void promise.then(
      () => {
        if (this.reconciling === promise) this.reconciling = null;
      },
      () => {
        if (this.reconciling === promise) this.reconciling = null;
      }
    );
    return promise;
  }

  private hasCurrentTargetProcess(target: Extract<TapTarget, { kind: 'application' }>): boolean {
    return target.kind === 'application' && this.processStat(target.processId)?.startTime === target.processStartTime;
  }

  private async doReconcile(child: ChildProcessLike, generation: number): Promise<void> {
    const current = (): boolean => this.child === child && this.reconcileGeneration === generation && !this.stopping;
    if (!current()) return;
    if (this.target.kind === 'application' && !this.hasCurrentTargetProcess(this.target)) {
      this.log('selected application process identity changed during capture');
      this.stop();
      return;
    }

    let graph: Graph;
    try {
      graph = parseGraph(await this.runner('pw-dump', ['-i', '0']), this.tapName, true);
    } catch (error) {
      if (current()) {
        this.log('could not inspect the pipewire graph; stopping capture:', error);
        this.stop();
      }
      return;
    }
    if (!current()) return;
    if (graph.tapNodeId === null) {
      // Startup may precede the tap node, but an established capture cannot keep unverified links.
      if (this.linked.size > 0) this.stop();
      return;
    }
    if (this.target.kind === 'application' && !this.hasCurrentTargetProcess(this.target)) {
      this.log('selected application process identity changed during graph inspection');
      this.stop();
      return;
    }

    const portalPipewireSerial = this.target.portalPipewireSerial;
    if (portalPipewireSerial !== undefined) {
      const captureMatches = graph.videoCaptures.filter((capture) =>
        this.captureProcess(capture.processId) && capture.targetSerials.length === 1 &&
        capture.targetSerials[0] === portalPipewireSerial
      );
      if (captureMatches.length !== 1) {
        for (const key of [...this.linked]) {
          const [from, to] = key.split('->');
          if (!current()) return;
          try {
            await this.runner('pw-link', ['-d', from!, `${graph.tapNodeId}:${to}`]);
          } catch (error) {
            if (current()) {
              this.log('could not remove audio without the selected portal video session; stopping capture:', error);
              this.stop();
            }
            return;
          }
          if (!current()) return;
          this.linked.delete(key);
        }
        this.tappedPids.clear();
        this.emitState();
        return;
      }
    }

    const alive = new Set<number>();
    for (const stream of graph.streams) {
      const allowed = stream.processId !== null && !this.ownsProcess(stream.processId) &&
        (this.target.kind === 'screen' || isProcessInFamily(
          stream.processId, this.target.processId, this.target.processStartTime, this.processStat
        ));
      if (!allowed) {
        // Ownership can change while a node survives (e.g. the selected app
        // exits and its audio helper is reparented). Drop only our tap links.
        for (const key of [...this.linked]) {
          if (!key.startsWith(`${stream.nodeId}:`)) continue;
          const [from, to] = key.split('->');
          if (!current()) return;
          try {
            await this.runner('pw-link', ['-d', from!, `${graph.tapNodeId}:${to}`]);
          } catch (error) {
            if (current()) {
              this.log('could not remove ineligible audio; stopping capture:', error);
              this.stop();
            }
            return;
          }
          if (!current()) return;
          this.linked.delete(key);
        }
        continue;
      }
      alive.add(stream.nodeId);

      for (const port of stream.ports) {
        for (const target of targetsFor(port)) {
          if (!current()) return;
          const key = `${stream.nodeId}:${port}->${target}`;
          if (this.linked.has(key)) continue;
          try {
            await this.runner('pw-link', [`${stream.nodeId}:${port}`, `${graph.tapNodeId}:${target}`]);
            if (!current()) return;
            if (this.target.kind === 'application' && !this.hasCurrentTargetProcess(this.target)) {
              this.log('selected application process identity changed while attaching audio');
              this.stop();
              return;
            }
            this.linked.add(key);
            if (stream.processId !== null) this.tappedPids.add(stream.processId);
            this.log(`tapped ${stream.appName || stream.nodeId}`);
          } catch (error) {
            if (!current()) return;
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

    if (!current()) return;
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
    this.tappedPids.clear();

    child.stdout?.on('data', (chunk) => {
      if (this.child !== child || this.stopping) return;
      for (const callback of this.dataCallbacks) callback(chunk);
    });
    child.stderr?.on('data', (chunk) => this.log('pw-record:', chunk.toString().trim()));

    // 'error' and 'exit' can both arrive for one child; the first one wins.
    let settled = false;
    const settle = (): boolean => {
      if (settled || this.child !== child) return false;
      settled = true;
      this.child = null;
      this.reconciling = null;
      this.reconcileGeneration += 1;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.linked.clear();
      this.tappedPids.clear();
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
