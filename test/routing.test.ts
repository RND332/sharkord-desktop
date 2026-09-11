import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Runner } from '../src/main/pipewire';
import { RoutingManager } from '../src/main/routing';

const SINK_NAME = 'sharkord_capture';
const OWN_PID = 1234;
const FOREIGN_PID = 4321;

type FakeSink = { index: number; name: string; description: string; priority: number };
type FakeModule = { id: number; name: string; args: string[] };
type FakeInput = { id: number; sinkIndex: number; processId: number | null; appName: string };

type World = {
  runner: Runner;
  calls: string[][];
  sinks: FakeSink[];
  modules: FakeModule[];
  inputs: FakeInput[];
  state: { defaultSink: string };
};

const renderSinks = (sinks: FakeSink[]): string =>
  sinks
    .map(
      (sink) => `Sink #${sink.index}
	Name: ${sink.name}
	Description: ${sink.description}
	Properties:
		priority.session = "${sink.priority}"`
    )
    .join('\n');

const renderModules = (modules: FakeModule[]): string =>
  modules
    .map(
      (module) => `Module #${module.id}
	Name: ${module.name}
	Argument: ${module.args.join(' ')}`
    )
    .join('\n');

const renderInputs = (inputs: FakeInput[]): string =>
  inputs
    .map(
      (input) => `Sink Input #${input.id}
	Sink: ${input.sinkIndex}
	Properties:
		application.name = "${input.appName}"
		application.process.id = "${input.processId ?? ''}"`
    )
    .join('\n');

const makeWorld = (
  options: { modules?: FakeModule[]; sinks?: FakeSink[]; inputs?: FakeInput[] } = {}
): World => {
  const sinks: FakeSink[] = options.sinks ?? [
    { index: 1, name: 'alsa_output.usb-Focusrite', description: 'Focusrite', priority: 1000 },
    { index: 2, name: 'alsa_output.pci-hdmi', description: 'HDMI', priority: 600 }
  ];
  const modules: FakeModule[] = options.modules ?? [];
  const inputs: FakeInput[] = options.inputs ?? [
    { id: 500, sinkIndex: 1, processId: FOREIGN_PID, appName: 'Google Chrome' },
    { id: 501, sinkIndex: 1, processId: OWN_PID, appName: 'Sharkord' },
    { id: 502, sinkIndex: 1, processId: null, appName: 'paplay' }
  ];
  const state = { defaultSink: 'alsa_output.usb-Focusrite' };
  let nextModuleId = 900;
  const calls: string[][] = [];

  const runner: Runner = async (args) => {
    calls.push(args);
    const [command, second] = args;

    if (command === 'list' && second === 'sinks') return renderSinks(sinks);
    if (command === 'list' && second === 'modules') return renderModules(modules);
    if (command === 'list' && second === 'sink-inputs') return renderInputs(inputs);
    if (command === 'get-default-sink') return state.defaultSink;

    if (command === 'set-default-sink') {
      state.defaultSink = args[1] ?? state.defaultSink;
      return '';
    }
    if (command === 'load-module') {
      const id = nextModuleId;
      nextModuleId += 1;
      const name = args[1] ?? '';
      modules.push({ id, name, args: args.slice(2) });
      if (name === 'module-null-sink') {
        sinks.push({ index: 9, name: SINK_NAME, description: 'Sharkord stream capture', priority: 0 });
      }
      return `${id}`;
    }
    if (command === 'unload-module') {
      const id = Number(args[1]);
      const removed = modules.findIndex((module) => module.id === id);
      if (removed >= 0) {
        const [module] = modules.splice(removed, 1);
        if (module?.name === 'module-null-sink') {
          const sinkIndex = sinks.findIndex((sink) => sink.name === SINK_NAME);
          if (sinkIndex >= 0) sinks.splice(sinkIndex, 1);
        }
      }
      return '';
    }
    if (command === 'move-sink-input') {
      const input = inputs.find((candidate) => candidate.id === Number(args[1]));
      const target = sinks.find((sink) => sink.name === args[2]);
      if (input && target) input.sinkIndex = target.index;
      return '';
    }

    throw new Error(`unexpected pactl call: ${args.join(' ')}`);
  };

  return { runner, calls, sinks, modules, inputs, state };
};

const makeManager = (world: World, statePath: string): RoutingManager =>
  new RoutingManager({
    runner: world.runner,
    statePath,
    sinkName: SINK_NAME,
    isOwnProcess: (pid) => pid === OWN_PID,
    log: () => {}
  });

const statePath = (): string => join(mkdtempSync(join(tmpdir(), 'sharkord-routing-')), 'state.json');

describe('RoutingManager', () => {
  it('makes the capture sink the default and loops it back to the real device', async () => {
    const world = makeWorld();
    const path = statePath();
    const manager = makeManager(world, path);

    const state = await manager.start();

    expect(state).toMatchObject({ active: true, sinkName: SINK_NAME, hwSink: 'alsa_output.usb-Focusrite' });
    expect(world.state.defaultSink).toBe(SINK_NAME);
    expect(world.modules.map((module) => module.name)).toEqual(['module-null-sink', 'module-loopback']);
    expect(world.modules[1]?.args).toEqual([
      `source=${SINK_NAME}.monitor`,
      'sink=alsa_output.usb-Focusrite',
      'latency_msec=10'
    ]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ hwSink: 'alsa_output.usb-Focusrite' });
  });

  it('moves every foreign stream into the capture sink but leaves its own playback alone', async () => {
    const world = makeWorld();
    const manager = makeManager(world, statePath());

    await manager.start();

    const destination = (id: number): number | undefined =>
      world.inputs.find((input) => input.id === id)?.sinkIndex;
    expect(destination(500)).toBe(9);
    expect(destination(501)).toBe(1);
    expect(destination(502)).toBe(9);
  });

  it('restores the default sink and removes its modules on stop', async () => {
    const world = makeWorld();
    const path = statePath();
    const manager = makeManager(world, path);

    await manager.start();
    await manager.stop();

    expect(world.state.defaultSink).toBe('alsa_output.usb-Focusrite');
    expect(world.modules).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    expect(manager.state.active).toBe(false);
  });

  it('cleans up modules a crashed run left behind', async () => {
    const world = makeWorld({
      modules: [
        {
          id: 77,
          name: 'module-loopback',
          args: [`source=${SINK_NAME}.monitor`, 'sink=alsa_output.usb-Focusrite', 'latency_msec=10']
        },
        {
          id: 78,
          name: 'module-null-sink',
          args: [`sink_name=${SINK_NAME}`, 'sink_properties=device.description=x']
        },
        { id: 79, name: 'module-null-sink', args: ['sink_name=unrelated'] }
      ],
      sinks: [
        { index: 1, name: 'alsa_output.usb-Focusrite', description: 'Focusrite', priority: 1000 },
        { index: 9, name: SINK_NAME, description: 'leftover', priority: 0 }
      ]
    });
    const manager = makeManager(world, statePath());

    await manager.cleanupStale();

    expect(world.modules.map((module) => module.id)).toEqual([79]);
  });

  it('rebuilds the loopback when it disappears and re-asserts the default sink', async () => {
    const world = makeWorld();
    const manager = makeManager(world, statePath());
    await manager.start();

    world.modules.splice(
      world.modules.findIndex((module) => module.name === 'module-loopback'),
      1
    );
    await world.runner(['set-default-sink', 'alsa_output.pci-hdmi']);

    await manager.ensureHealthy();

    expect(world.modules.filter((module) => module.name === 'module-loopback')).toHaveLength(1);
    expect(world.state.defaultSink).toBe(SINK_NAME);
  });

  it('re-points monitoring at another device when the old one vanishes', async () => {
    const world = makeWorld();
    const manager = makeManager(world, statePath());
    await manager.start();

    world.sinks.splice(
      world.sinks.findIndex((sink) => sink.name === 'alsa_output.usb-Focusrite'),
      1
    );

    await manager.ensureHealthy();

    const loopback = world.modules.find((module) => module.name === 'module-loopback');
    expect(loopback?.args).toContain('sink=alsa_output.pci-hdmi');
    expect(manager.state.hwSink).toBe('alsa_output.pci-hdmi');
  });

  it('survives a double stop', async () => {
    const world = makeWorld();
    const manager = makeManager(world, statePath());
    await manager.start();

    await manager.stop();
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});
