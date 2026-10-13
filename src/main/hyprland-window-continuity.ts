import { createConnection, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  defaultRunner,
  isProcessInFamily,
  readProcessIdentity,
  readProcessStat,
  type ProcessStat,
  type Runner,
  type TapTarget
} from './tap';

const MAX_EVENT_LINE_BYTES = 64 * 1024;
const MAX_EVENT_HISTORY = 64;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CLASS_BYTES = 512;

export type HyprlandWindowEntry = {
  address: string;
  windowClass: string;
  pid: number | null;
  processStartTime: string | null;
};

type TopologyEvent = {
  kind: 'openwindow' | 'closewindow' | 'kill' | 'class-change' | 'helper-window-open' | 'helper-window-close' | 'helper-window-kill';
  address: string;
};

type ProcessIdentity = { pid: number; startTime: string };

type Options = {
  socketPath?: string;
  runtimeDir?: string;
  instanceSignature?: string;
  runner?: Runner;
  readIdentity?: (pid: number) => { pid: number; startTime: string } | null;
  processStat?: (pid: number) => ProcessStat | null;
  portalBackendProcess?: ProcessIdentity;
  connectTimeoutMs?: number;
  maxEventHistory?: number;
};

const validEventAddress = (value: string): boolean => /^[0-9a-f]+$/.test(value);
const validSnapshotAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]+$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const defaultSocketPath = (runtimeDir: string | undefined, instanceSignature: string | undefined): string | null => {
  const root = runtimeDir ?? process.env.XDG_RUNTIME_DIR;
  const signature = instanceSignature ?? process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!root || !isAbsolute(root) || !signature || !/^[A-Za-z0-9_-]{1,128}$/.test(signature)) return null;
  const path = join(root, 'hypr', signature, '.socket2.sock');
  return Buffer.byteLength(path, 'utf8') < 108 ? path : null;
};

const normalizeSnapshot = (
  value: unknown,
  readIdentity: (pid: number) => { pid: number; startTime: string } | null
): HyprlandWindowEntry[] | null => {
  if (!Array.isArray(value)) return null;
  const addresses = new Set<string>();
  const result: HyprlandWindowEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.mapped !== 'boolean') return null;
    if (!raw.mapped) continue;
    if (!validSnapshotAddress(raw.address) || addresses.has(raw.address) ||
        typeof raw.class !== 'string' || Buffer.byteLength(raw.class, 'utf8') > MAX_CLASS_BYTES) return null;
    addresses.add(raw.address);
    const pid = Number.isSafeInteger(raw.pid) && (raw.pid as number) > 1 ? raw.pid as number : null;
    const identity = pid === null ? null : readIdentity(pid);
    result.push({
      address: raw.address,
      windowClass: raw.class,
      pid,
      processStartTime: identity?.pid === pid && typeof identity.startTime === 'string' && identity.startTime.length > 0
        ? identity.startTime
        : null
    });
  }
  return result.sort((left, right) => left.address.localeCompare(right.address));
};

const snapshotsEqual = (left: readonly HyprlandWindowEntry[], right: readonly HyprlandWindowEntry[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * A conservative continuity witness for Hyprland's class-only portal metadata. It snapshots mapped
 * windows before the system picker opens and subscribes to socket2 first. Any open/close/kill event,
 * socket gap, malformed lifecycle event, or changed process identity invalidates the whole grant.
 */
export class HyprlandWindowContinuity {
  private socket: Socket | null = null;
  private decoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private baseline: HyprlandWindowEntry[] | null = null;
  private started = false;
  private stopped = false;
  private failure: string | null = null;
  private pendingActiveClass: string | null = null;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly eventHistory: TopologyEvent[] = [];
  private readonly helperWindowAddresses = new Map<string, ProcessIdentity>();
  private readonly runner: Runner;
  private readonly readIdentity: NonNullable<Options['readIdentity']>;
  private readonly processStat: NonNullable<Options['processStat']>;
  private portalBackendProcess: ProcessIdentity | null;
  private readonly maxEventHistory: number;

  constructor(private readonly options: Options = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.readIdentity = options.readIdentity ?? readProcessIdentity;
    this.processStat = options.processStat ?? readProcessStat;
    this.portalBackendProcess = options.portalBackendProcess ?? null;
    this.maxEventHistory = Math.max(1, Math.min(options.maxEventHistory ?? MAX_EVENT_HISTORY, 256));
  }

  get isActive(): boolean {
    return this.started && !this.stopped && this.failure === null && this.baseline !== null;
  }

  get invalidReason(): string | null {
    return this.failure;
  }

  setPortalBackendProcess(identity: ProcessIdentity): boolean {
    if (this.socket || this.started || this.stopped || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 ||
        typeof identity.startTime !== 'string' || identity.startTime.length === 0) return false;
    this.portalBackendProcess = { pid: identity.pid, startTime: identity.startTime };
    return true;
  }

  get topologyHistory(): readonly TopologyEvent[] {
    return this.eventHistory.slice();
  }

  async start(): Promise<boolean> {
    if (this.socket || this.started || this.stopped) return false;
    const socketPath = this.options.socketPath ?? defaultSocketPath(this.options.runtimeDir, this.options.instanceSignature);
    if (!socketPath || Buffer.byteLength(socketPath, 'utf8') >= 108) return false;

    let socket: Socket;
    try {
      socket = createConnection(socketPath);
    } catch {
      return false;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.consumeChunk(chunk));
    socket.on('error', () => this.invalidate('event-stream-disconnected'));
    socket.on('close', () => {
      if (!this.stopped) this.invalidate('event-stream-disconnected');
    });

    const timeoutMs = Math.max(1, Math.min(this.options.connectTimeoutMs ?? 1000, 5000));
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', () => reject(new Error('connect failed')));
        }),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
        })
      ]);
    } catch {
      this.invalidate('event-stream-disconnected');
      this.stop();
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.failure !== null || this.stopped) return false;

    const baseline = await this.readSnapshot();
    if (!baseline || this.failure !== null || this.stopped) {
      this.stop();
      return false;
    }
    this.baseline = baseline;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.eventQueue;
    if (this.failure !== null || this.stopped) {
      this.stop();
      return false;
    }
    this.started = true;
    return true;
  }

  async resolveWindowClass(windowClass: string): Promise<Extract<TapTarget, { kind: 'application' }> | null> {
    if (!windowClass || Buffer.byteLength(windowClass, 'utf8') > MAX_CLASS_BYTES) return null;
    const stable = await this.readStableBaseline();
    if (!stable) return null;
    const matches = stable.filter((entry) => entry.windowClass === windowClass);
    if (matches.length === 0 || matches.some((entry) => entry.pid === null || entry.processStartTime === null)) return null;
    const identities = new Set(matches.map((entry) => `${entry.pid}:${entry.processStartTime}`));
    if (identities.size !== 1) return null;
    const selected = matches[0]!;
    return { kind: 'application', processId: selected.pid!, processStartTime: selected.processStartTime! };
  }

  async verifyWindowTarget(
    target: { processId: number; processStartTime: string; portalWindowClass: string }
  ): Promise<boolean> {
    const stable = await this.readStableBaseline();
    if (!stable) return false;
    const matches = stable.filter((entry) => entry.windowClass === target.portalWindowClass);
    if (matches.length === 0 || matches.some((entry) => entry.pid === null || entry.processStartTime === null)) return false;
    const identities = new Set(matches.map((entry) => `${entry.pid}:${entry.processStartTime}`));
    return identities.size === 1 && matches[0]!.pid === target.processId &&
      matches[0]!.processStartTime === target.processStartTime;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.baseline = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private async readStableBaseline(): Promise<HyprlandWindowEntry[] | null> {
    if (!this.isActive || !this.baseline) return null;
    await this.eventQueue;
    if (!this.isActive) return null;
    const first = await this.readSnapshot();
    await this.eventQueue;
    if (!first || !this.isActive || !snapshotsEqual(this.baseline, first)) {
      if (this.isActive) this.invalidate('snapshot-changed');
      return null;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.eventQueue;
    if (!this.isActive) return null;
    const second = await this.readSnapshot();
    await this.eventQueue;
    if (!second || !this.isActive || !snapshotsEqual(this.baseline, second)) {
      if (this.isActive) this.invalidate('snapshot-changed');
      return null;
    }
    return this.baseline;
  }

  private isPortalHelper(entry: HyprlandWindowEntry): boolean {
    const backend = this.portalBackendProcess;
    if (!backend || entry.pid === null || entry.processStartTime === null) return false;
    const current = this.processStat(entry.pid);
    if (!current || current.startTime !== entry.processStartTime) return false;
    return isProcessInFamily(entry.pid, backend.pid, backend.startTime, this.processStat);
  }

  private async readSnapshot(includePortalHelpers = false): Promise<HyprlandWindowEntry[] | null> {
    let json: string;
    try {
      json = await this.runner('hyprctl', ['clients', '-j']);
    } catch {
      this.invalidate('snapshot-unavailable');
      return null;
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
      this.invalidate('snapshot-invalid');
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      this.invalidate('snapshot-invalid');
      return null;
    }
    const snapshot = normalizeSnapshot(raw, this.readIdentity);
    if (!snapshot) {
      this.invalidate('snapshot-invalid');
      return null;
    }
    return includePortalHelpers ? snapshot : snapshot.filter((entry) => !this.isPortalHelper(entry));
  }

  private consumeChunk(chunk: Buffer): void {
    if (this.stopped || this.failure !== null || chunk.byteLength > MAX_EVENT_LINE_BYTES) {
      if (!this.stopped) this.invalidate('event-history-overflow');
      return;
    }
    this.lineBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.lineBuffer, 'utf8') > MAX_EVENT_LINE_BYTES) {
      this.lineBuffer = '';
      this.invalidate('event-history-overflow');
      return;
    }
    let newline: number;
    while ((newline = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      this.eventQueue = this.eventQueue.then(() => this.processEventLine(line)).catch(() => {
        this.invalidate('event-processing-failed');
      });
      if (this.failure !== null) return;
    }
  }

  private async processEventLine(line: string): Promise<void> {
    if (this.stopped || this.failure !== null) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
      this.invalidate('event-history-overflow');
      return;
    }
    const separator = line.indexOf('>>');
    if (separator <= 0) {
      this.invalidate('malformed-event-stream');
      return;
    }
    const name = line.slice(0, separator);
    const data = line.slice(separator + 2);
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      this.invalidate('malformed-event-stream');
      return;
    }
    if (this.pendingActiveClass !== null && name !== 'activewindowv2') {
      this.pendingActiveClass = null;
      this.invalidate('incomplete-active-window-event');
      return;
    }
    if (name === 'activewindow') {
      const comma = data.indexOf(',');
      if (comma < 0 || Buffer.byteLength(data.slice(0, comma), 'utf8') > MAX_CLASS_BYTES) {
        this.pendingActiveClass = null;
        this.invalidate('malformed-active-window-event');
        return;
      }
      this.pendingActiveClass = data.slice(0, comma);
      return;
    }
    if (name === 'activewindowv2') {
      const activeClass = this.pendingActiveClass;
      this.pendingActiveClass = null;
      if (data === '') return;
      if (activeClass === null) {
        this.invalidate('incomplete-active-window-event');
        return;
      }
      if (!validEventAddress(data)) {
        this.invalidate('malformed-active-window-event');
        return;
      }
      if (this.helperWindowAddresses.has(data)) return;
      if (!this.baseline) {
        this.invalidate('active-window-before-baseline');
        return;
      }
      const entry = this.baseline.find((candidate) => candidate.address === `0x${data}`);
      if (!entry) {
        this.recordEvent('class-change', data, 'active-window-not-in-baseline');
        return;
      }
      if (entry.windowClass !== activeClass) this.recordEvent('class-change', data, 'window-class-change');
      return;
    }
    this.pendingActiveClass = null;
    if (name !== 'openwindow' && name !== 'closewindow' && name !== 'kill') return;
    const address = name === 'openwindow' ? data.slice(0, data.indexOf(',')) : data;
    if (!validEventAddress(address) || (name === 'openwindow' && !data.includes(','))) {
      this.invalidate('malformed-lifecycle-event');
      return;
    }
    if (name === 'openwindow') {
      const snapshot = await this.readSnapshot(true);
      if (!snapshot || this.failure !== null || this.stopped) return;
      const entry = snapshot.find((candidate) => candidate.address === `0x${address}`);
      if (entry && this.isPortalHelper(entry) && entry.pid !== null && entry.processStartTime !== null) {
        this.helperWindowAddresses.set(address, { pid: entry.pid, startTime: entry.processStartTime });
        this.recordEvent('helper-window-open', address, null);
        return;
      }
      this.helperWindowAddresses.delete(address);
      this.recordEvent('openwindow', address, 'window-lifecycle-change');
      return;
    }
    if (this.helperWindowAddresses.has(address)) {
      if (name === 'closewindow') this.helperWindowAddresses.delete(address);
      this.recordEvent(name === 'kill' ? 'helper-window-kill' : 'helper-window-close', address, null);
      return;
    }
    this.recordEvent(name, address, 'window-lifecycle-change');
  }

  private recordEvent(kind: TopologyEvent['kind'], address: string, reason: string | null): void {
    if (this.eventHistory.length >= this.maxEventHistory) {
      this.invalidate('event-history-overflow');
      return;
    }
    this.eventHistory.push({ kind, address });
    if (reason) this.invalidate(reason);
  }

  private invalidate(reason: string): void {
    if (this.failure !== null || this.stopped) return;
    this.failure = reason;
    this.started = false;
    this.socket?.destroy();
  }
}
