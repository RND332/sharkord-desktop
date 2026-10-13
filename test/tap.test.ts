import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOwnProcess,
  isProcessInFamily,
  parseGraph,
  readProcessIdentity,
  readProcessStat,
  targetsFor,
  TapCapture,
  type ChildProcessLike,
  type Runner,
  type Spawner
} from '../src/main/tap';

/** Two Chromium streams share a name (that is why links are made by node id), plus mono paplay. */
const PW_DUMP = JSON.stringify([
  { id: 901, type: 'PipeWire:Interface:Client', info: { props: {
    'pipewire.sec.pid': 27893, 'application.process.id': 27893
  } } },
  { id: 902, type: 'PipeWire:Interface:Client', info: { props: {
    'pipewire.sec.pid': 27893, 'application.process.id': 27893
  } } },
  {
    id: 221,
    type: 'PipeWire:Interface:Node',
    info: {
      props: {
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Google Chrome',
        'application.name': 'Google Chrome',
        'client.id': 901,
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
        'client.id': 902,
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

const withPortalCapture = (processId = 2369069): string => JSON.stringify([
  ...JSON.parse(PW_DUMP),
  {
    id: 502,
    type: 'PipeWire:Interface:Node',
    info: { props: { 'media.class': 'Video/Source', 'object.serial': '9001' } }
  },
  {
    id: 710,
    type: 'PipeWire:Interface:Node',
    info: { props: { 'media.class': 'Stream/Input/Video', 'application.process.id': processId, 'node.driver-id': 502 } }
  }
]);

type Link = { from: string; to: string };

const makeWorld = (
  ownPids: number[] = [],
  dump: string = PW_DUMP,
  processStat: (pid: number) => { parentPid: number; startTime: string } | null = (pid) => {
    if (pid === 27893) return { parentPid: 1, startTime: 'fixture-start' };
    if (pid === 30001) return { parentPid: 1, startTime: 'unrelated-start' };
    return readProcessStat(pid);
  },
  captureProcess: (pid: number | null) => boolean = (pid) => isOwnProcess(pid)
) => {
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
    captureProcess,
    processStat,
    log: () => {}
  });
  return { links, spawns, tap, setDump: (next: string) => { dump = next; }, emitSpawnError: (error: Error) => errors.forEach((cb) => cb(error)) };
};

describe('parseGraph', () => {
  it('uses the server-authenticated client PID rather than a forged audio node PID', () => {
    const graph = parseGraph(JSON.stringify([
      { id: 901, type: 'PipeWire:Interface:Client', info: { props: {
        'pipewire.sec.pid': 30001, 'application.process.id': 30001
      } } },
      { id: 221, type: 'PipeWire:Interface:Node', info: { props: {
        'media.class': 'Stream/Output/Audio', 'client.id': 901, 'application.process.id': 27893
      } } }
    ]), 'sharkord_capture');
    expect(graph.streams[0]!.processId).toBe(30001);
  });
  it('rejects an audio PID claim without server-authenticated client credentials', () => {
    const graph = parseGraph(JSON.stringify([
      { id: 901, type: 'PipeWire:Interface:Client', info: { props: { 'application.process.id': 27893 } } },
      { id: 221, type: 'PipeWire:Interface:Node', info: { props: {
        'media.class': 'Stream/Output/Audio', 'client.id': 901, 'application.process.id': 27893
      } } }
    ]), 'sharkord_capture');
    expect(graph.streams[0]!.processId).toBeNull();
  });
  it('rejects an unverified application PID behind a PulseAudio proxy', () => {
    const graph = parseGraph(JSON.stringify([
      { id: 901, type: 'PipeWire:Interface:Client', info: { props: {
        'pipewire.sec.pid': 1349, 'application.process.id': 27893
      } } },
      { id: 221, type: 'PipeWire:Interface:Node', info: { props: {
        'media.class': 'Stream/Output/Audio', 'client.id': 901, 'application.process.id': 27893
      } } }
    ]), 'sharkord_capture');
    expect(graph.streams[0]!.processId).toBeNull();
  });
  it('resolves native PipeWire stream PIDs from their client when absent on the node', () => {
    const objects = JSON.parse(PW_DUMP);
    const props = objects.find((entry: { id: number }) => entry.id === 221).info.props;
    delete props['application.process.id'];
    props['client.id'] = 900;
    objects.push({ id: 900, type: 'PipeWire:Interface:Client', info: { props: {
      'pipewire.sec.pid': '10845', 'application.process.id': '10845'
    } } });
    expect(parseGraph(JSON.stringify(objects), 'sharkord_capture').streams[0]!.processId).toBe(10845);
  });
  it('keeps every playback stream by id, even when names collide', () => {
    const graph = parseGraph(PW_DUMP, 'sharkord_capture');

    expect(graph.streams).toEqual([
      { nodeId: 221, appName: 'Google Chrome', processId: 27893, ports: ['output_FL', 'output_FR'] },
      { nodeId: 222, appName: 'Google Chrome', processId: 27893, ports: ['output_MONO'] }
    ]);
    expect(graph.tapNodeId).toBe(141);
  });

  it('resolves the portal video source serial instead of treating its recyclable node id as serial', () => {
    const graph = parseGraph(JSON.stringify([
      {
        id: 502,
        type: 'PipeWire:Interface:Node',
        info: { props: { 'media.class': 'Video/Source', 'object.serial': '9001' } }
      },
      {
        id: 710,
        type: 'PipeWire:Interface:Node',
        info: { props: {
          'media.class': 'Stream/Input/Video',
          'application.process.id': 2369069,
          'node.driver-id': 502
        } }
      }
    ]), 'sharkord_capture');

    expect(graph.videoCaptures).toEqual([{ nodeId: 710, processId: 2369069, targetSerials: ['9001'] }]);
    expect(graph.videoCaptures[0]!.targetSerials).not.toContain('502');
  });

  it('retains video-capture ownership and serial separately for exact session validation', () => {
    const graph = parseGraph(JSON.stringify([
      {
        id: 502,
        type: 'PipeWire:Interface:Node',
        info: { props: { 'media.class': 'Video/Source', 'object.serial': '9001' } }
      },
      {
        id: 710,
        type: 'PipeWire:Interface:Node',
        info: { props: { 'media.class': 'Stream/Input/Video', 'application.process.id': 999, 'node.target': '9001' } }
      }
    ]), 'sharkord_capture');
    expect(graph.videoCaptures).toEqual([{ nodeId: 710, processId: 999, targetSerials: ['9001'] }]);
  });

  it('survives output that is not the expected JSON', () => {
    expect(parseGraph('not json', 'sharkord_capture')).toEqual({ streams: [], tapNodeId: null, videoCaptures: [] });
    expect(parseGraph('{"id":1}', 'sharkord_capture')).toEqual({ streams: [], tapNodeId: null, videoCaptures: [] });
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

  it('never delivers buffered PCM from a stopped or replaced recorder', () => {
    const outputs: Array<(chunk: Buffer) => void> = [];
    const spawner: Spawner = () => ({
      stdout: { on: (_event, callback) => { outputs.push(callback); } },
      stderr: null,
      on: () => {},
      kill: () => {}
    });
    const tap = new TapCapture({ spawner, runner: async () => '[]' });
    const received: number[][] = [];
    tap.onData((chunk) => received.push(Array.from(chunk)));

    try {
      tap.start();
      outputs[0]!(Buffer.from([1]));
      tap.stop();
      outputs[0]!(Buffer.from([2]));
      tap.start();
      outputs[0]!(Buffer.from([4]));
      outputs[1]!(Buffer.from([3]));

      expect(received).toEqual([[1], [3]]);
    } finally {
      tap.stop();
    }
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

  it('links only the selected application even when an unrelated stream claims its PID', async () => {
    const objects = JSON.parse(PW_DUMP);
    Object.assign(objects.find((entry: { id: number }) => entry.id === 902).info.props, {
      'pipewire.sec.pid': 30001, 'application.process.id': 30001
    });
    const { links, tap } = makeWorld([], JSON.stringify(objects));
    tap.start({ kind: 'application', processId: 27893, processStartTime: 'fixture-start' });
    await tap.reconcile();
    expect(links.map((link) => link.from)).toEqual(['221:output_FL', '221:output_FR']);
    tap.stop();
  });

  it('refuses a portal PipeWire serial without a valid capture generation', () => {
    const { spawns, tap } = makeWorld();
    expect(tap.start({
      kind: 'application', processId: 27893, processStartTime: 'fixture-start', portalPipewireSerial: '9001'
    })).toBe(false);
    expect(spawns).toEqual([]);
    tap.stop();
  });

  it('links selected-app audio only while this process owns the exact selected portal video serial', async () => {
    const { links, tap, setDump } = makeWorld([], PW_DUMP, undefined, (pid) => pid === 2369069);
    tap.start({
      kind: 'application', processId: 27893, processStartTime: 'fixture-start',
      portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalSourceType: 2,
      portalWindowClass: 'google-chrome', portalPipewireSerial: '9001'
    });
    await tap.reconcile();
    expect(links).toEqual([]);

    setDump(withPortalCapture(999));
    await tap.reconcile();
    expect(links).toEqual([]);

    setDump(withPortalCapture());
    await tap.reconcile();
    expect(links.map((link) => link.from)).toEqual([
      '221:output_FL', '221:output_FR', '222:output_MONO', '222:output_MONO'
    ]);

    setDump(PW_DUMP);
    await tap.reconcile();
    expect(links.filter((link) => link.from === '-d')).toHaveLength(4);
    expect(tap.linkedCount).toBe(0);
    tap.stop();
  });

  it('stops linked portal audio when the graph becomes malformed', async () => {
    const { tap, setDump } = makeWorld([], withPortalCapture(), undefined, (pid) => pid === 2369069);
    expect(tap.start({
      kind: 'application', processId: 27893, processStartTime: 'fixture-start',
      portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalSourceType: 2,
      portalWindowClass: 'google-chrome', portalPipewireSerial: '9001'
    })).toBe(true);
    await tap.reconcile();
    expect(tap.linkedCount).toBe(4);
    setDump('not json');
    await tap.reconcile();
    expect(tap.running).toBe(false);
    expect(tap.linkedCount).toBe(0);
    tap.stop();
  });

  it('stops a previously linked capture when the tap disappears from a valid graph', async () => {
    const { tap, setDump } = makeWorld([], withPortalCapture(), undefined, (pid) => pid === 2369069);
    tap.start({
      kind: 'application', processId: 27893, processStartTime: 'fixture-start',
      portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalSourceType: 2,
      portalWindowClass: 'google-chrome', portalPipewireSerial: '9001'
    });
    await tap.reconcile();
    expect(tap.linkedCount).toBe(4);
    setDump('[]');
    await tap.reconcile();
    expect(tap.running).toBe(false);
    expect(tap.linkedCount).toBe(0);
    tap.stop();
  });

  it('kills the recorder and stops polling when pw-dump fails after linking', async () => {
    let inspectionFails = false;
    const kill = vi.fn();
    const tap = new TapCapture({
      runner: async (bin) => {
        if (bin !== 'pw-dump') return '';
        if (inspectionFails) throw new Error('pw-dump unavailable');
        return withPortalCapture();
      },
      spawner: () => ({ stdout: null, stderr: null, on: () => {}, kill }),
      processStat: (pid) => pid === 27893 ? { parentPid: 1, startTime: 'fixture-start' } : null,
      captureProcess: (pid) => pid === 2369069,
      pollMs: 60_000
    });
    tap.start({
      kind: 'application', processId: 27893, processStartTime: 'fixture-start',
      portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalSourceType: 2,
      portalWindowClass: 'google-chrome', portalPipewireSerial: '9001'
    });
    await tap.reconcile();
    expect(tap.linkedCount).toBe(4);
    inspectionFails = true;
    await tap.reconcile();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(tap.running).toBe(false);
    expect(tap.linkedCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    tap.stop();
  });

  it('keeps explicit whole-screen audio tied to its exact video stream and excludes Sharkord', async () => {
    const objects = JSON.parse(withPortalCapture());
    objects.push({
      id: 223,
      type: 'PipeWire:Interface:Node',
      info: { props: {
        'media.class': 'Stream/Output/Audio',
        'node.name': 'Sharkord',
        'application.name': 'Sharkord',
        'application.process.id': 2369069
      } }
    });
    objects.push({
      id: 224,
      type: 'PipeWire:Interface:Node',
      info: { props: { 'media.class': 'Stream/Output/Audio', 'node.name': 'unknown playback' } }
    });
    objects.push({
      id: 404,
      type: 'PipeWire:Interface:Port',
      info: { direction: 'out', props: { 'node.id': 223, 'port.direction': 'out', 'port.name': 'output_FL' } }
    });
    objects.push({
      id: 405,
      type: 'PipeWire:Interface:Port',
      info: { direction: 'out', props: { 'node.id': 224, 'port.direction': 'out', 'port.name': 'output_FL' } }
    });
    const { links, tap, setDump } = makeWorld([2369069], JSON.stringify(objects), undefined, (pid) => pid === 2369069);
    const screenTarget = {
      kind: 'screen' as const,
      portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalSourceType: 1 as const,
      portalOutput: 'DP-1',
      portalPipewireSerial: '9001'
    };
    expect(tap.start(screenTarget)).toBe(true);
    await tap.reconcile();
    expect(links.map((link) => link.from)).toEqual([
      '221:output_FL', '221:output_FR', '222:output_MONO', '222:output_MONO'
    ]);

    setDump(JSON.stringify(objects.filter((entry: { id: number }) => entry.id !== 502 && entry.id !== 710)));
    await tap.reconcile();
    expect(links.filter((link) => link.from === '-d')).toHaveLength(4);
    expect(tap.linkedCount).toBe(0);
    tap.stop();
  });

  it('refuses a Wayland screen target without exact type-1 output metadata', () => {
    const { spawns, tap } = makeWorld();
    expect(tap.start({
      kind: 'screen', portalGeneration: 'cbaf5b3d-6c4e-4ea4-9b6f-5779245d1a57',
      portalPipewireSerial: '9001'
    })).toBe(false);
    expect(spawns).toEqual([]);
    tap.stop();
  });

  it('includes selected application audio-helper descendants, not unidentified PIDs', async () => {
    const objects = JSON.parse(PW_DUMP);
    objects.find((entry: { id: number }) => entry.id === 221).info.props['application.process.id'] = process.pid;
    objects.find((entry: { id: number }) => entry.id === 222).info.props['application.process.id'] = null;
    Object.assign(objects.find((entry: { id: number }) => entry.id === 901).info.props, {
      'pipewire.sec.pid': process.pid, 'application.process.id': process.pid
    });
    delete objects.find((entry: { id: number }) => entry.id === 902).info.props['pipewire.sec.pid'];
    const targetIdentity = readProcessIdentity(process.ppid);
    expect(targetIdentity).not.toBeNull();
    const { links, tap } = makeWorld([], JSON.stringify(objects), readProcessStat);
    tap.start({ kind: 'application', processId: process.ppid, processStartTime: targetIdentity!.startTime });
    await tap.reconcile();
    expect(links.map((link) => link.from)).toEqual(['221:output_FL', '221:output_FR']);
    tap.stop();
  });

  it('disconnects a linked stream that no longer belongs to the selected application', async () => {
    const { links, tap, setDump } = makeWorld();
    tap.start({ kind: 'application', processId: 27893, processStartTime: 'fixture-start' });
    await tap.reconcile();
    setDump(PW_DUMP.replaceAll('27893', '30001'));
    await tap.reconcile();
    expect(links.filter((link) => link.from === '-d')).toHaveLength(4);
    expect(tap.linkedCount).toBe(0);
    expect(tap.tappedProcessIds).toEqual([]);
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

  it('does not spawn a second recorder when acquired during restart backoff', () => {
    const { tap, spawns, emitSpawnError } = makeWorld();
    tap.start();
    emitSpawnError(Object.assign(new Error('temporarily unavailable'), { code: 'EAGAIN' }));
    tap.start();
    expect(spawns).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(spawns).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(spawns).toHaveLength(2);
    tap.stop();
  });

  it('stops graph polling after a terminal recorder failure', async () => {
    let dumps = 0;
    let fail!: (error: Error) => void;
    const tap = new TapCapture({
      runner: async () => { dumps += 1; return PW_DUMP; },
      spawner: () => ({
        stdout: null, stderr: null, kill: () => {},
        on: (event, callback) => {
          if (event === 'error') fail = callback as (error: Error) => void;
        }
      }),
      pollMs: 100
    });
    tap.start();
    await tap.reconcile();
    fail(Object.assign(new Error('missing recorder'), { code: 'ENOENT' }));
    const before = dumps;
    await vi.advanceTimersByTimeAsync(1000);
    expect(dumps).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
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
