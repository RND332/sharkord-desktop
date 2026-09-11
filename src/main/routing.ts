import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultSink,
  listModules,
  listSinkInputs,
  listSinks,
  loadModule,
  moveSinkInput,
  pickHardwareSink,
  realRunner,
  setDefaultSink,
  unloadModule,
  type Module,
  type Runner,
  type Sink
} from './pipewire';

export type RoutingDeps = {
  runner?: Runner;
  statePath?: string;
  sinkName?: string;
  hwSinkOverride?: string | null;
  log?: (msg: string, ...rest: unknown[]) => void;
  isOwnProcess?: (pid: number | null) => boolean;
};

export type RoutingState = {
  active: boolean;
  sinkName: string;
  hwSink: string | null;
  nullModuleId: number | null;
  loopbackModuleId: number | null;
};

type StoredState = {
  sinkName: string;
  hwSink: string | null;
  nullModuleId: number | null;
  loopbackModuleId: number | null;
};

const parentPid = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
};

const isOwnProcess = (pid: number | null): boolean => {
  let current = pid;
  const seen = new Set<number>();
  while (current !== null && current > 1 && !seen.has(current)) {
    if (current === process.pid) return true;
    seen.add(current);
    current = parentPid(current);
  }
  return false;
};

/**
 * Owns the virtual capture sink: makes it the default output so every other application's
 * audio passes through it, and loops it back so the user still hears everything.
 * The desktop client's own playback is pinned elsewhere (PULSE_SINK) and stays out of the capture.
 */
export class RoutingManager {
  private readonly runner: Runner;
  private readonly sinkName: string;
  private readonly statePath: string;
  private readonly hwSinkOverride: string | null;
  private readonly log: (msg: string, ...rest: unknown[]) => void;
  private readonly ownsProcess: (pid: number | null) => boolean;
  private current: RoutingState;

  constructor(deps: RoutingDeps = {}) {
    this.runner = deps.runner ?? realRunner;
    this.sinkName = deps.sinkName ?? 'sharkord_capture';
    this.statePath = deps.statePath ?? join(process.env.XDG_RUNTIME_DIR ?? homedir(), 'sharkord-desktop.json');
    this.hwSinkOverride = deps.hwSinkOverride ?? null;
    this.log = deps.log ?? (() => {});
    this.ownsProcess = deps.isOwnProcess ?? isOwnProcess;
    this.current = {
      active: false,
      sinkName: this.sinkName,
      hwSink: null,
      nullModuleId: null,
      loopbackModuleId: null
    };
  }

  get state(): RoutingState {
    return { ...this.current };
  }

  /** Removes anything a previous (possibly crashed) run left behind. */
  async cleanupStale(): Promise<void> {
    const stored = this.readStoredState();
    const ids = new Set<number>();
    if (stored?.nullModuleId) ids.add(stored.nullModuleId);
    if (stored?.loopbackModuleId) ids.add(stored.loopbackModuleId);

    try {
      for (const module of await listModules(this.runner)) {
        if (this.isOurs(module)) ids.add(module.id);
      }
    } catch (error) {
      this.log('could not list modules:', error);
    }

    for (const id of ids) {
      try {
        await unloadModule(this.runner, id);
        this.log('unloaded stale module', id);
      } catch (error) {
        this.log('could not unload stale module', id, error);
      }
    }

    try {
      unlinkSync(this.statePath);
    } catch {
      // nothing to clean
    }
  }

  async start(): Promise<RoutingState> {
    await this.cleanupStale();

    const sinks = await listSinks(this.runner);
    const hwSink = await this.resolveHardwareSink(sinks);
    if (!hwSink) throw new Error('no playback device available for local monitoring');

    const nullModuleId = await loadModule(this.runner, 'module-null-sink', [
      `sink_name=${this.sinkName}`,
      'sink_properties=device.description=Sharkord stream capture'
    ]);
    const loopbackModuleId = await loadModule(this.runner, 'module-loopback', [
      `source=${this.sinkName}.monitor`,
      `sink=${hwSink}`,
      'latency_msec=10'
    ]);

    await setDefaultSink(this.runner, this.sinkName);
    await this.moveForeignStreams();

    this.current = {
      active: true,
      sinkName: this.sinkName,
      hwSink,
      nullModuleId,
      loopbackModuleId
    };
    this.persist();
    return this.state;
  }

  async stop(): Promise<void> {
    if (!this.current.active) {
      await this.cleanupStale();
      return;
    }

    const { hwSink, nullModuleId, loopbackModuleId } = this.current;

    try {
      const sinks = await listSinks(this.runner);
      const target =
        hwSink && sinks.some((sink) => sink.name === hwSink)
          ? hwSink
          : pickHardwareSink(sinks, [this.sinkName]);
      if (target) await setDefaultSink(this.runner, target);
    } catch (error) {
      this.log('could not restore the default sink:', error);
    }

    for (const id of [loopbackModuleId, nullModuleId]) {
      if (!id) continue;
      try {
        await unloadModule(this.runner, id);
      } catch (error) {
        this.log('could not unload module', id, error);
      }
    }

    try {
      unlinkSync(this.statePath);
    } catch {
      // already gone
    }

    this.current = {
      active: false,
      sinkName: this.sinkName,
      hwSink: null,
      nullModuleId: null,
      loopbackModuleId: null
    };
  }

  /** Repairs whatever a device change or a PipeWire restart broke. */
  async ensureHealthy(): Promise<void> {
    if (!this.current.active) return;

    try {
      const modules = await listModules(this.runner);
      if (!modules.some((module) => module.id === this.current.nullModuleId)) {
        this.log('capture sink vanished, rebuilding routing');
        await this.start();
        return;
      }

      const sinks = await listSinks(this.runner);
      const hwAlive =
        this.current.hwSink !== null && sinks.some((sink) => sink.name === this.current.hwSink);
      const loopbackAlive = modules.some((module) => module.id === this.current.loopbackModuleId);

      if (!loopbackAlive || !hwAlive) {
        const hwSink = hwAlive
          ? this.current.hwSink
          : pickHardwareSink(sinks, [this.sinkName]);
        if (!hwSink) return;

        if (this.current.loopbackModuleId) {
          await unloadModule(this.runner, this.current.loopbackModuleId).catch(() => {});
        }
        this.current.loopbackModuleId = await loadModule(this.runner, 'module-loopback', [
          `source=${this.sinkName}.monitor`,
          `sink=${hwSink}`,
          'latency_msec=10'
        ]);
        this.current.hwSink = hwSink;
        this.persist();
        this.log('monitoring loopback re-pointed at', hwSink);
      }

      if ((await getDefaultSink(this.runner).catch(() => this.sinkName)) !== this.sinkName) {
        await setDefaultSink(this.runner, this.sinkName);
      }
    } catch (error) {
      this.log('health check failed:', error);
    }
  }

  private isOurs(module: Module): boolean {
    if (module.name === 'module-null-sink') {
      return module.args.some((arg) => arg === `sink_name=${this.sinkName}`);
    }
    if (module.name === 'module-loopback') {
      return module.args.some((arg) => arg === `source=${this.sinkName}.monitor`);
    }
    return false;
  }

  private async resolveHardwareSink(sinks: Sink[]): Promise<string | null> {
    if (this.hwSinkOverride) return this.hwSinkOverride;

    const candidates = sinks.filter((sink) => !sink.isMonitor && sink.name !== this.sinkName);
    if (candidates.length === 0) return null;

    const current = await getDefaultSink(this.runner).catch(() => '');
    if (candidates.some((sink) => sink.name === current)) return current;

    return pickHardwareSink(sinks, [this.sinkName]);
  }

  private async moveForeignStreams(): Promise<void> {
    const sinks = await listSinks(this.runner);
    const target = sinks.find((sink) => sink.name === this.sinkName);
    if (!target) return;

    for (const input of await listSinkInputs(this.runner)) {
      if (input.sinkIndex === target.index) continue;
      if (this.ownsProcess(input.processId)) continue;
      try {
        await moveSinkInput(this.runner, input.id, this.sinkName);
      } catch (error) {
        this.log('could not move stream', input.id, error);
      }
    }
  }

  private readStoredState(): StoredState | null {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as StoredState;
    } catch {
      return null;
    }
  }

  private persist(): void {
    const stored: StoredState = {
      sinkName: this.sinkName,
      hwSink: this.current.hwSink,
      nullModuleId: this.current.nullModuleId,
      loopbackModuleId: this.current.loopbackModuleId
    };
    try {
      writeFileSync(this.statePath, JSON.stringify(stored));
    } catch (error) {
      this.log('could not persist routing state:', error);
    }
  }
}
