import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, join } from 'node:path';
import { HyprlandWindowContinuity } from './hyprland-window-continuity';
import { readProcessIdentity } from './tap';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const SCREENCAST_INTERFACE = 'org.freedesktop.impl.portal.ScreenCast';
const MAX_LINE_BYTES = 4096;
const MAX_PROTOCOL_BUFFER_BYTES = 16 * 1024;
const MAX_QUEUED_EVENTS = 8;
const MAX_HANDLE_BYTES = 1024;
const MAX_TEXT_BYTES = 512;

export type PortalOwners = {
  portalOwner: string;
  backendOwner: string;
  backendName: string;
  appId: string;
};

export type PortalStartCall = {
  cookie: number;
  requesterName: string;
  requestHandle: string;
  sessionHandle: string;
  appId: string;
};

export type PortalWindowSelection = {
  generation: string;
  sourceType: 2;
  windowClass: string;
  windowHandle?: string;
  pipewireSerial: string;
};

export type PortalScreenSelection = {
  generation: string;
  sourceType: 1;
  output: string;
  pipewireSerial: string;
};

export type PortalSelection = PortalWindowSelection | PortalScreenSelection;
export type PortalSelectionDetails = Omit<PortalWindowSelection, 'generation'> | Omit<PortalScreenSelection, 'generation'>;

export type PortalMessage = {
  type?: unknown;
  cookie?: unknown;
  reply_cookie?: unknown;
  sender?: unknown;
  destination?: unknown;
  path?: unknown;
  interface?: unknown;
  member?: unknown;
  payload?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const safeCookie = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff;

const isUniqueName = (value: unknown): value is string =>
  typeof value === 'string' && /^:[0-9]{1,10}\.[0-9]{1,10}$/.test(value);

const isTyped = (value: unknown): value is { type: string; data: unknown } =>
  isRecord(value) && typeof value.type === 'string' && Object.hasOwn(value, 'data');

const oneValue = (value: unknown): unknown => {
  if (!isTyped(value)) return undefined;
  if (value.type !== 'v') return value;
  if (!Array.isArray(value.data) || value.data.length !== 1) return undefined;
  return value.data[0];
};

const dictionary = (value: unknown): Record<string, unknown> | null => {
  let data = value;
  if (isTyped(data)) {
    if (data.type !== 'a{sv}') return null;
    data = data.data;
  }
  if (Array.isArray(data)) {
    if (data.length !== 1) return null;
    [data] = data;
  }
  if (!isRecord(data)) return null;
  return data;
};

const typedValue = (value: unknown, type: string): unknown => {
  const item = oneValue(value);
  if (!isTyped(item) || item.type !== type) return undefined;
  return item.data;
};

const dbusPathRequester = (path: unknown, kind: 'request' | 'session'): string | null => {
  if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_HANDLE_BYTES) return null;
  const expression = kind === 'request'
    ? /^\/org\/freedesktop\/portal\/desktop\/request\/1_([0-9]{1,10})\/[A-Za-z0-9_]+$/
    : /^\/org\/freedesktop\/portal\/desktop\/session\/1_([0-9]{1,10})\/[A-Za-z0-9_]+$/;
  const match = expression.exec(path);
  return match ? `:1.${match[1]}` : null;
};

export const parsePortalStartCall = (message: unknown, owners: PortalOwners): PortalStartCall | null => {
  if (!isRecord(message) || message.type !== 'method_call' || message.sender !== owners.portalOwner ||
      (message.destination !== owners.backendName && message.destination !== owners.backendOwner) ||
      message.path !== PORTAL_PATH || message.interface !== SCREENCAST_INTERFACE || message.member !== 'Start' ||
      !safeCookie(message.cookie)) return null;

  const payload = message.payload;
  if (!isRecord(payload) || payload.type !== 'oossa{sv}' || !Array.isArray(payload.data) || payload.data.length !== 5) return null;
  const [requestHandle, sessionHandle, appId, parentWindow, options] = payload.data;
  const requestOwner = dbusPathRequester(requestHandle, 'request');
  const sessionOwner = dbusPathRequester(sessionHandle, 'session');
  // Unsandboxed host applications can have an empty app ID. Request ownership is
  // still checked against the exact D-Bus connection PID by the tracker.
  if (!requestOwner || !sessionOwner || requestOwner !== sessionOwner ||
      (appId !== owners.appId && appId !== '') ||
      typeof parentWindow !== 'string' || Buffer.byteLength(parentWindow, 'utf8') > 4096 ||
      !dictionary(options)) return null;

  return {
    cookie: message.cookie,
    requesterName: requestOwner,
    requestHandle: requestHandle as string,
    sessionHandle: sessionHandle as string,
    appId: appId as string
  };
};

const serialString = (value: unknown): string | null => {
  const serial = typedValue(value, 't');
  if (typeof serial === 'number' && Number.isSafeInteger(serial) && serial > 0) return String(serial);
  if (typeof serial === 'string' && /^[1-9][0-9]{0,19}$/.test(serial)) return serial;
  return null;
};

const parseRestoreProperties = (value: unknown): Record<string, unknown> | null => {
  const restore = oneValue(value);
  if (!isTyped(restore) || restore.type !== '(suv)' || !Array.isArray(restore.data) || restore.data.length !== 3) return null;
  const [vendor, version, rawPrivateData] = restore.data;
  if (vendor !== 'hyprland' || version !== 3) return null;
  const privateData = oneValue(rawPrivateData);
  if (!isTyped(privateData) || privateData.type !== 'a{sv}') return null;
  return dictionary(privateData);
};

export const parsePortalStartReply = (
  message: unknown,
  call: PortalStartCall,
  owners: PortalOwners
): PortalSelectionDetails | null => {
  if (!isRecord(message) || message.type !== 'method_return' || message.sender !== owners.backendOwner ||
      message.destination !== owners.portalOwner || message.reply_cookie !== call.cookie || !safeCookie(message.reply_cookie)) return null;

  const payload = message.payload;
  if (!isRecord(payload) || payload.type !== 'ua{sv}' || !Array.isArray(payload.data) || payload.data.length !== 2 || payload.data[0] !== 0) return null;
  const results = dictionary(payload.data[1]);
  if (!results) return null;

  const sourceType = typedValue(results.source_type, 'u');
  if (sourceType !== 1 && sourceType !== 2) return null;
  const streamsValue = oneValue(results.streams);
  if (!isTyped(streamsValue) || streamsValue.type !== 'a(ua{sv})' || !Array.isArray(streamsValue.data) || streamsValue.data.length !== 1) return null;
  const stream = streamsValue.data[0];
  if (!Array.isArray(stream) || stream.length !== 2 || !Number.isSafeInteger(stream[0]) || (stream[0] as number) <= 0) return null;
  const streamProps = dictionary(stream[1]);
  if (!streamProps || typedValue(streamProps.source_type, 'u') !== sourceType) return null;
  const pipewireSerial = serialString(streamProps['pipewire-serial']);
  if (!pipewireSerial) return null;

  const restore = parseRestoreProperties(results.restore_data);
  if (!restore) return null;
  if (sourceType === 1) {
    const output = typedValue(restore.output, 's');
    const mappingId = typedValue(streamProps.mapping_id, 's');
    if (typeof output !== 'string' || output.length === 0 || Buffer.byteLength(output, 'utf8') > 512 || mappingId !== output) return null;
    return { sourceType: 1, output, pipewireSerial };
  }

  const windowClass = typedValue(restore.windowClass, 's');
  if (typeof windowClass !== 'string' || windowClass.length === 0 || Buffer.byteLength(windowClass, 'utf8') > 512) return null;
  const windowHandle = serialString(restore.windowHandle);
  return { sourceType: 2, windowClass, ...(windowHandle ? { windowHandle } : {}), pipewireSerial };
};

const samePortalSource = (left: PortalSelection, right: PortalSelectionDetails): boolean => {
  if (left.sourceType !== right.sourceType) return false;
  if (left.sourceType === 1 && right.sourceType === 1) return left.output === right.output;
  if (left.sourceType !== 2 || right.sourceType !== 2 || left.windowClass !== right.windowClass) return false;
  return left.windowHandle === undefined || right.windowHandle === undefined || left.windowHandle === right.windowHandle;
};

export type NativeOwnedStart = {
  cookie: number;
  requesterName: string;
  requesterPid: number;
  appId: string;
};

export type NativeOwnedSelection = PortalSelectionDetails & { cookie: number };

type PendingStart = { call: PortalStartCall };

export class PortalSelectionTracker {
  private readonly pending = new Map<number, PendingStart>();
  private currentSelection: PortalSelection | null = null;
  private acceptedSelections: PortalSelection[] = [];
  private active = true;
  private failed = false;
  private ownStartCount = 0;

  constructor(private readonly options: PortalOwners & {
    mainPid: number;
    generation: string;
    lookupPid: (name: string) => Promise<number | null>;
  }) {}

  get selection(): PortalSelection | null {
    return this.active && !this.failed ? this.currentSelection : null;
  }

  get selections(): PortalSelection[] {
    return this.active && !this.failed ? [...this.acceptedSelections] : [];
  }

  get isActive(): boolean {
    return this.active && !this.failed;
  }

  async receive(message: unknown): Promise<void> {
    if (!this.isActive || !isRecord(message)) return;

    if (message.type === 'signal' && message.sender === DBUS_NAME && message.path === DBUS_PATH &&
        message.interface === DBUS_INTERFACE && message.member === 'NameOwnerChanged') {
      const payload = message.payload;
      if (isRecord(payload) && payload.type === 'sss' && Array.isArray(payload.data) && payload.data.length === 3) {
        const [name, oldOwner, newOwner] = payload.data;
        if ((name === this.options.backendName || name === 'org.freedesktop.portal.Desktop') &&
            oldOwner !== newOwner) this.fail();
      }
      return;
    }

    const call = parsePortalStartCall(message, this.options);
    if (call) {
      const key = call.cookie;
      if (this.pending.has(key)) {
        this.fail();
        return;
      }
      const pid = await this.options.lookupPid(call.requesterName).catch(() => null);
      if (!this.isActive || pid !== this.options.mainPid) return;
      if (this.pending.size !== 0 || this.ownStartCount >= 2) {
        this.fail();
        return;
      }
      this.ownStartCount += 1;
      this.pending.set(key, { call });
      return;
    }

    if ((message.type !== 'method_return' && message.type !== 'error') ||
        message.sender !== this.options.backendOwner || message.destination !== this.options.portalOwner ||
        !safeCookie(message.reply_cookie)) return;
    const pending = this.pending.get(message.reply_cookie);
    if (!pending) return;
    this.pending.delete(message.reply_cookie);
    if (message.type !== 'method_return') {
      this.fail();
      return;
    }
    const result = parsePortalStartReply(message, pending.call, this.options);
    if (!result || this.acceptedSelections.length >= 2 ||
        (this.currentSelection !== null && !samePortalSource(this.currentSelection, result))) {
      this.fail();
      return;
    }
    const selection = { generation: this.options.generation, ...result } as PortalSelection;
    if (this.currentSelection === null) this.currentSelection = selection;
    this.acceptedSelections.push(selection);
  }

  receiveNativeStart(start: NativeOwnedStart): void {
    if (!this.isActive) return;
    const match = /^:1\.([0-9]{1,10})$/.exec(start.requesterName);
    if (!safeCookie(start.cookie) || !match || start.requesterPid !== this.options.mainPid ||
        (start.appId !== this.options.appId && start.appId !== '')) {
      this.fail();
      return;
    }
    if (this.pending.has(start.cookie) || this.pending.size !== 0 || this.ownStartCount >= 2) {
      this.fail();
      return;
    }
    const suffix = `1_${match[1]}/native_${start.cookie}`;
    const call: PortalStartCall = {
      cookie: start.cookie,
      requesterName: start.requesterName,
      requestHandle: `/org/freedesktop/portal/desktop/request/${suffix}`,
      sessionHandle: `/org/freedesktop/portal/desktop/session/${suffix}`,
      appId: start.appId
    };
    this.ownStartCount += 1;
    this.pending.set(start.cookie, { call });
  }

  async receiveNativeSelection(selection: NativeOwnedSelection): Promise<void> {
    if (!this.isActive) return;
    if (!safeCookie(selection.cookie) || !this.pending.has(selection.cookie)) {
      this.fail();
      return;
    }
    const streamProperties: Record<string, unknown> = {
      source_type: { type: 'u', data: selection.sourceType },
      'pipewire-serial': { type: 't', data: selection.pipewireSerial }
    };
    const restoreProperties: Record<string, unknown> = {};
    if (selection.sourceType === 1) {
      streamProperties.mapping_id = { type: 's', data: selection.output };
      restoreProperties.output = { type: 's', data: selection.output };
    } else {
      restoreProperties.windowClass = { type: 's', data: selection.windowClass };
    }
    const reply = {
      type: 'method_return',
      sender: this.options.backendOwner,
      destination: this.options.portalOwner,
      reply_cookie: selection.cookie,
      payload: {
        type: 'ua{sv}',
        data: [0, [{
          source_type: { type: 'u', data: selection.sourceType },
          streams: { type: 'a(ua{sv})', data: [[1, [streamProperties]]] },
          restore_data: {
            type: '(suv)',
            data: ['hyprland', 3, { type: 'a{sv}', data: [restoreProperties] }]
          }
        }]]
      }
    };
    await this.receive(reply);
  }

  cancel(): void {
    this.active = false;
    this.currentSelection = null;
    this.acceptedSelections = [];
    this.pending.clear();
  }

  private fail(): void {
    this.failed = true;
    this.currentSelection = null;
    this.acceptedSelections = [];
    this.pending.clear();
  }
}

type ObserverOptions = {
  appId?: string;
  timeoutMs?: number;
  helperPath?: string;
  windowWitness?: HyprlandWindowContinuity;
};

type NativeReady = {
  event: 'ready';
  portalOwner: string;
  backendOwner: string;
  backendPid: number;
};

type NativeStartEvent = NativeOwnedStart & { event: 'start' };
type NativeSelectionEvent = NativeOwnedSelection & { event: 'selection' };
type NativeInvalidEvent = { event: 'invalid'; reason: string };
type NativeEvent = NativeReady | NativeStartEvent | NativeSelectionEvent | NativeInvalidEvent;

const NATIVE_INVALID_REASONS = new Set([
  'owner-changed', 'malformed-owned-start-header', 'malformed-owned-start-prefix',
  'malformed-request-path', 'mismatched-owned-session', 'malformed-owned-start-signature',
  'invalid-owned-app-id', 'duplicate-or-excess-start', 'too-many-pending-starts',
  'owned-start-error', 'malformed-owned-reply', 'duplicate-owned-reply',
  'owned-start-timeout', 'monitor-failed', 'startup-failed'
]);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolvePortalMetadataHelper = (override?: string): string | null => {
  if (override !== undefined) return isAbsolute(override) && isExecutableFile(override) ? override : null;
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) return null;
  const filename = `portal-metadata-linux-${process.arch}`;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'native', filename)] : []),
    join(__dirname, '..', 'native', 'out', filename)
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
};

const parseNativeEvent = (line: string): NativeEvent | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.event !== 'string') return null;
  if (value.event === 'ready' && hasOnlyKeys(value, ['event', 'portalOwner', 'backendOwner', 'backendPid']) &&
      isUniqueName(value.portalOwner) && isUniqueName(value.backendOwner) &&
      Number.isSafeInteger(value.backendPid) && (value.backendPid as number) > 1) {
    return value as NativeReady;
  }
  if (value.event === 'start' && hasOnlyKeys(value, ['event', 'cookie', 'requesterName', 'requesterPid', 'appId']) &&
      safeCookie(value.cookie) && isUniqueName(value.requesterName) &&
      Number.isSafeInteger(value.requesterPid) && (value.requesterPid as number) > 1 &&
      typeof value.appId === 'string' && Buffer.byteLength(value.appId, 'utf8') <= MAX_TEXT_BYTES) {
    return value as NativeStartEvent;
  }
  if (value.event === 'selection' && Number.isSafeInteger(value.cookie) && safeCookie(value.cookie) &&
      typeof value.pipewireSerial === 'string' && /^[1-9][0-9]{0,19}$/.test(value.pipewireSerial)) {
    if (value.sourceType === 1 && hasOnlyKeys(value, ['event', 'cookie', 'sourceType', 'pipewireSerial', 'output']) &&
        typeof value.output === 'string' && value.output.length > 0 && Buffer.byteLength(value.output, 'utf8') <= MAX_TEXT_BYTES) {
      return value as NativeSelectionEvent;
    }
    if (value.sourceType === 2 && hasOnlyKeys(value, ['event', 'cookie', 'sourceType', 'pipewireSerial', 'windowClass']) &&
        typeof value.windowClass === 'string' && value.windowClass.length > 0 && Buffer.byteLength(value.windowClass, 'utf8') <= MAX_TEXT_BYTES) {
      return value as NativeSelectionEvent;
    }
  }
  if (value.event === 'invalid' && hasOnlyKeys(value, ['event', 'reason']) &&
      typeof value.reason === 'string' && NATIVE_INVALID_REASONS.has(value.reason)) return value as NativeInvalidEvent;
  return null;
};

export class PortalSelectionObserver {
  private child: ChildProcess | null = null;
  private decoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private messageQueue: Promise<void> = Promise.resolve();
  private queuedEvents = 0;
  private tracker: PortalSelectionTracker | null = null;
  private owners: PortalOwners | null = null;
  private readyData: NativeReady | null = null;
  private readonly earlyStarts: NativeStartEvent[] = [];
  private active = false;
  private ready = false;
  private startupFailed = false;
  private stopped = false;
  private readonly generation = randomUUID();
  private readonly windowWitness: HyprlandWindowContinuity;
  private readyResolver: (() => void) | null = null;
  private readonly readyPromise = new Promise<void>((resolve) => { this.readyResolver = resolve; });

  constructor(private readonly options: ObserverOptions = {}) {
    this.windowWitness = options.windowWitness ?? new HyprlandWindowContinuity();
  }

  async start(): Promise<boolean> {
    if (this.active || this.child || this.stopped) return false;
    const helperPath = resolvePortalMetadataHelper(this.options.helperPath);
    if (!helperPath) {
      this.invalidate();
      return false;
    }
    this.active = true;
    let child: ChildProcess;
    try {
      child = spawn(helperPath, [
        '--pid', String(process.pid),
        '--app-id', this.options.appId ?? 'sharkord-desktop',
        '--backend-name', 'org.freedesktop.impl.portal.desktop.hyprland'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      this.invalidate();
      return false;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consumeChunk(chunk));
    child.stderr?.on('data', () => {});
    child.on('error', () => { if (!this.stopped) this.invalidate(); });
    child.on('exit', () => { if (!this.stopped) this.invalidate(); });

    let timeout: NodeJS.Timeout | undefined;
    const startupTimeout = Math.max(1, Math.min(this.options.timeoutMs ?? 2500, 10_000));
    const ready = await Promise.race([
      this.readyPromise.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), startupTimeout); })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!ready || !this.active || !this.ready || !this.readyData) {
      this.stop();
      return false;
    }

    const { portalOwner, backendOwner, backendPid } = this.readyData;
    const backendProcess = readProcessIdentity(backendPid);
    if (!backendProcess || backendProcess.pid !== backendPid ||
        !this.windowWitness.setPortalBackendProcess(backendProcess)) {
      this.invalidate();
      return false;
    }
    let witnessReady = false;
    try {
      witnessReady = await this.windowWitness.start();
    } catch {
      witnessReady = false;
    }
    if (!witnessReady || !this.active || this.stopped) {
      this.invalidate();
      return false;
    }
    const owners: PortalOwners = {
      portalOwner,
      backendOwner,
      backendName: 'org.freedesktop.impl.portal.desktop.hyprland',
      appId: this.options.appId ?? 'sharkord-desktop'
    };
    this.owners = owners;
    this.tracker = new PortalSelectionTracker({
      ...owners,
      mainPid: process.pid,
      generation: this.generation,
      lookupPid: async () => null
    });
    const earlyStarts = this.earlyStarts.splice(0);
    for (const event of earlyStarts) {
      this.tracker.receiveNativeStart(event);
      if (!this.tracker.isActive) {
        this.invalidate();
        return false;
      }
    }
    await this.messageQueue;
    if (!this.active || this.stopped || !this.tracker.isActive || child.exitCode !== null) {
      this.invalidate();
      return false;
    }
    return this.isActive;
  }

  get windowContinuity(): HyprlandWindowContinuity {
    return this.windowWitness;
  }

  get selections(): PortalSelection[] {
    return this.isActive ? this.tracker?.selections ?? [] : [];
  }

  get isActive(): boolean {
    return this.active && this.tracker?.isActive === true && this.windowWitness.isActive;
  }

  async verifyWindowTarget(target: { processId: number; processStartTime: string; portalWindowClass: string }): Promise<boolean> {
    return this.isActive && await this.windowWitness.verifyWindowTarget(target) && this.isActive;
  }

  async selectionAfterCapture(timeoutMs = 1000): Promise<PortalSelection | null> {
    if (!this.isActive || !this.tracker) return null;
    const tracker = this.tracker;
    const deadline = Date.now() + timeoutMs;
    while (this.isActive && tracker.selection === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    await this.messageQueue;
    const selected = this.isActive ? tracker.selection : null;
    if (!selected) this.stop();
    return selected;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.ready = false;
    this.readyResolver?.();
    this.readyResolver = null;
    this.tracker?.cancel();
    this.tracker = null;
    this.earlyStarts.length = 0;
    this.lineBuffer = '';
    this.windowWitness.stop();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }

  private invalidate(): void {
    if (this.startupFailed) return;
    this.startupFailed = true;
    this.ready = false;
    this.stop();
  }

  private consumeChunk(chunk: Buffer): void {
    if (!this.active || chunk.byteLength > MAX_PROTOCOL_BUFFER_BYTES) {
      this.invalidate();
      return;
    }
    this.lineBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.lineBuffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
      this.lineBuffer = '';
      this.invalidate();
      return;
    }
    let newline: number;
    while ((newline = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES || this.queuedEvents >= MAX_QUEUED_EVENTS) {
        this.invalidate();
        return;
      }
      this.queuedEvents += 1;
      this.messageQueue = this.messageQueue.then(() => this.processLine(line))
        .catch(() => this.invalidate())
        .finally(() => { this.queuedEvents = Math.max(0, this.queuedEvents - 1); });
    }
  }

  private async processLine(line: string): Promise<void> {
    if (!this.active || this.stopped) return;
    const event = parseNativeEvent(line);
    if (!event) {
      this.invalidate();
      return;
    }
    if (event.event === 'invalid') {
      this.invalidate();
      return;
    }
    if (event.event === 'ready') {
      if (this.ready || this.readyData) {
        this.invalidate();
        return;
      }
      this.readyData = event;
      this.ready = true;
      this.readyResolver?.();
      this.readyResolver = null;
      return;
    }
    if (!this.readyData) {
      this.invalidate();
      return;
    }
    if (event.event === 'start') {
      if (this.tracker) this.tracker.receiveNativeStart(event);
      else if (this.earlyStarts.length < 2) this.earlyStarts.push(event);
      else this.invalidate();
    } else if (event.event === 'selection') {
      if (!this.tracker) {
        this.invalidate();
        return;
      }
      await this.tracker.receiveNativeSelection(event);
    }
    if (!this.tracker?.isActive) this.invalidate();
  }
}

export const createPortalSelectionObserver = (options?: ObserverOptions): PortalSelectionObserver =>
  new PortalSelectionObserver(options);

export const portalObserverTestHelpers = {
  parseNativeEvent,
  resolvePortalMetadataHelper
};

export type PortalStartReply = ReturnType<typeof parsePortalStartReply>;
