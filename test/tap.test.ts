import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOwnProcess,
  parseGraph,
  targetsFor,
  TapCapture,
  type ChildProcessLike,
  type Runner,
  type Spawner
} from '../src/main/tap';

/** Two Chromium streams share a name (that is why links are made by node id), plus mono paplay. */
const PW_DUMP = JSON.stringify([
  {
    id: 221,
    type: 'PipeWire:Interface:Node',
    info: {
      props: {
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Google Chrome',
        'application.name': 'Google Chrome',
        'application.process.id': 27893
      }
    }
  },
  {
    id: 222,
    type: 'PipeWire:Interface:Node',
    info: {
      props: {
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Google Chrome',
        'application.name': 'Google Chrome',
        'application.process.id': 27893
      }
    }
  },
  {
    id: 141,
    type: 'PipeWire:Interface:Node',
    info: {
      props: {
        'media.class': 'Stream/Input/Audio',
        'node.name': 'sharkord_capture',
        'application.process.id': 999
      }
    }
  },
  {
    id: 300,
    type: 'PipeWire:Interface:Node',
    info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'alsa_output.x' } }
  },
  { id: 400, type: 'PipeWire:Interface:Port', info: { direction: 'output', props: { 'node.id': 221, 'port.direction': 'out', 'port.name': 'output_FL' } } },
  { id: 401, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 221, 'port.direction': 'output', 'port.name': 'output_FR' } } },
  { id: 402, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 222, 'port.direction': 'out', 'port.name': 'output_MONO' } } },
  { id: 403, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 221, 'port.direction': 'in', 'port.name': 'input_FL' } } }
]);

type Link = { from: string; to: string };

const makeWorld = (ownPids: number[] = [], dump: string = PW_DUMP) => {
  const links: Link[] = [];
  const spawns: string[][] = [];
  const runner: Runner = async (bin, args) => {
    if (bin === 'pw-dump') return dump;
    if (bin === 'pw-link') {
      links.push({ from: args[0]!, to: args[1]! });
      return '';
    }
    throw new Error(`unexpected ${bin} ${args.join(' ')}`);
  };
  const errors: Array<(error: Error) => void> = [];
  const spawner: Spawner = (_bin, args) => {
    spawns.push(args);
    return {
      stdout: null,
      stderr: null,
      on: (event: string, cb: (arg: never) => void) => {
        if (event === 'error') errors.push(cb as unknown as (error: Error) => void);
      },
      kill: () => {}
    } satisfies ChildProcessLike;
  };
  const tap = new TapCapture({
    spawner,
    runner,
    pollMs: 60_000,
    ownsProcess: (pid) => pid !== null && ownPids.includes(pid),
    log: () => {}
  });
  return { links, spawns, tap, emitSpawnError: (error: Error) => errors.forEach((cb) => cb(error)) };
};

describe('parseGraph', () => {
  it('keeps every playback stream by id, even when names collide', () => {
    const graph = parseGraph(PW_DUMP, 'sharkord_capture');

    expect(graph.streams).toEqual([
      { nodeId: 221, appName: 'Google Chrome', processId: 27893, ports: ['output_FL', 'output_FR'] },
      { nodeId: 222, appName: 'Google Chrome', processId: 27893, ports: ['output_MONO'] }
    ]);
    expect(graph.tapNodeId).toBe(141);
  });

  it('survives output that is not the expected JSON', () => {
    expect(parseGraph('not json', 'sharkord_capture')).toEqual({ streams: [], tapNodeId: null });
    expect(parseGraph('{"id":1}', 'sharkord_capture')).toEqual({ streams: [], tapNodeId: null });
  });
});

describe('targetsFor', () => {
  it('maps channels one to one and fans mono out to both sides', () => {
    expect(targetsFor('output_FL')).toEqual(['input_FL']);
    expect(targetsFor('output_FR')).toEqual(['input_FR']);
    expect(targetsFor('output_MONO')).toEqual(['input_FL', 'input_FR']);
    expect(targetsFor('output_AUX0')).toEqual([]);
  });
});

describe('isOwnProcess', () => {
  it('recognises the current process', () => {
    expect(isOwnProcess(process.pid)).toBe(true);
    expect(isOwnProcess(1)).toBe(false);
    expect(isOwnProcess(null)).toBe(false);
  });
});

describe('TapCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records into a private node instead of creating a sink', () => {
    const { spawns, tap } = makeWorld();

    tap.start();

    expect(spawns[0]).toEqual([
      '-P',
      'node.autoconnect=false',
      '-P',
      'node.name=sharkord_capture',
      '-P',
      'application.name=sharkord-desktop',
      '-P',
      'node.description=sharkord-desktop',
      '--format',
      'f32',
      '--rate=48000',
      '--channels=2',
      '-'
    ]);
    tap.stop();
  });

  it("links every other application's playback into the tap by node id, mono fanned out", async () => {
    const { links, tap } = makeWorld();
    tap.start();
    await tap.reconcile();

    expect(links).toEqual([
      { from: '221:output_FL', to: '141:input_FL' },
      { from: '221:output_FR', to: '141:input_FR' },
      { from: '222:output_MONO', to: '141:input_FL' },
      { from: '222:output_MONO', to: '141:input_FR' }
    ]);
    expect(tap.linkedCount).toBe(4);
    tap.stop();
  });

  it('never links the client itself', async () => {
    const { links, tap } = makeWorld([27893]);
    tap.start();
    await tap.reconcile();

    expect(links).toEqual([]);
    tap.stop();
  });

  it('is idempotent when nothing changed', async () => {
    const { links, tap } = makeWorld();
    tap.start();
    await tap.reconcile();
    await tap.reconcile();

    expect(links).toHaveLength(4);
    tap.stop();
  });

  it('does not let a stopped share poison the next capture with stale links or errors', async () => {
    const newDump = PW_DUMP.replace('"id":141,', '"id":241,');
    const links: Link[] = [];
    const logs: string[] = [];
    let dumpCalls = 0;
    let rejectFirst!: (error: Error) => void;
    const runner: Runner = async (bin, args) => {
      if (bin === 'pw-link') {
        links.push({ from: args[0]!, to: args[1]! });
        return '';
      }
      dumpCalls += 1;
      if (dumpCalls === 1) {
        return new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return newDump;
    };
    const spawner: Spawner = () => ({
      stdout: null,
      stderr: null,
      on: () => {},
      kill: () => {}
    });
    const tap = new TapCapture({
      runner,
      spawner,
      pollMs: 60_000,
      log: (...parts) => logs.push(parts.map(String).join(' '))
    });

    tap.start();
    const firstReconcile = tap.reconcile();
    tap.stop();
    tap.start();
    const secondReconcile = tap.reconcile();
    rejectFirst(new Error('stale graph failed'));
    await firstReconcile;
    await secondReconcile;

    expect(dumpCalls).toBe(2);
    expect(links).toEqual([
      { from: '221:output_FL', to: '241:input_FL' },
      { from: '221:output_FR', to: '241:input_FR' },
      { from: '222:output_MONO', to: '241:input_FL' },
      { from: '222:output_MONO', to: '241:input_FR' }
    ]);
    expect(logs.some((line) => line.includes('could not inspect'))).toBe(false);
    tap.stop();
  });

  it('forgets streams that disappeared', async () => {
    const { tap } = makeWorld();
    tap.start();
    await tap.reconcile();
    expect(tap.linkedCount).toBe(4);

    const withoutChrome = JSON.stringify(
      (JSON.parse(PW_DUMP) as Array<Record<string, unknown>>).filter((entry) => entry.id !== 221 && entry.id !== 222)
    );
    const runner: Runner = async (bin) => (bin === 'pw-dump' ? withoutChrome : '');
    const fresh = new TapCapture({ runner, pollMs: 60_000, log: () => {} });
    fresh.start();
    await fresh.reconcile();
    expect(fresh.linkedCount).toBe(0);
    fresh.stop();
    tap.stop();
  });

  it('treats an existing link as success', async () => {
    const runner: Runner = async (bin) => {
      if (bin === 'pw-dump') return PW_DUMP;
      throw new Error('failed to link ports: File exists');
    };
    const logs: string[] = [];
    const spawner: Spawner = () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} });
    const tap = new TapCapture({
      spawner,
      runner,
      pollMs: 60_000,
      log: (...parts: unknown[]) => logs.push(String(parts[0]))
    });

    tap.start();
    await tap.reconcile();

    expect(tap.linkedCount).toBe(4);
    expect(logs.some((line) => line.includes('could not tap'))).toBe(false);
    tap.stop();
  });

  it('reports a machine without pw-record instead of crashing, and does not retry', () => {
    const { tap, spawns, emitSpawnError } = makeWorld();
    tap.start();

    emitSpawnError(Object.assign(new Error('spawn pw-record ENOENT'), { code: 'ENOENT' }));
    vi.advanceTimersByTime(60_000);

    expect(tap.running).toBe(false);
    expect(spawns).toHaveLength(1);
    tap.stop();
  });

  it('retries when the recorder dies for another reason', () => {
    const { tap, spawns, emitSpawnError } = makeWorld();
    tap.start();
    emitSpawnError(Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' }));
    vi.advanceTimersByTime(300);

    expect(spawns).toHaveLength(2);
    tap.stop();
  });

  it('clears its state when stopped', async () => {
    const { tap } = makeWorld();
    tap.start();
    await tap.reconcile();
    tap.stop();

    expect(tap.running).toBe(false);
    expect(tap.linkedCount).toBe(0);
  });
});
