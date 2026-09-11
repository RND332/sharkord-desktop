import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseDefaultSink,
  parseModules,
  parseSinkInputs,
  parseSinks,
  parseSubscribeLine,
  pickHardwareSink,
  type Sink
} from '../src/main/pipewire';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./support/${name}`, import.meta.url)), 'utf8');

const sink = (name: string, priority: number): Sink => ({
  index: 1,
  name,
  description: name,
  priority,
  isMonitor: false
});

describe('pactl parsing', () => {
  it('reads sinks from real pactl output', () => {
    const sinks = parseSinks(fixture('pactl-sinks.txt'));

    expect(sinks.length).toBeGreaterThan(0);
    for (const parsed of sinks) {
      expect(parsed.index).toBeGreaterThan(0);
      expect(parsed.name.length).toBeGreaterThan(0);
      expect(parsed.isMonitor).toBe(false);
    }
    expect(parseDefaultSink(fixture('pactl-default-sink.txt'))).toBe(
      'alsa_output.usb-Focusrite_Scarlett_Solo_4th_Gen_S1X3F982C00452-00.HiFi__Line1__sink'
    );
  });

  it('reads names, priorities and monitor flags', () => {
    const parsed = parseSinks(`Sink #42
	Name: sharkord_capture
	Description: Sharkord stream capture
	Properties:
		priority.session = "1000"
Sink #43
	Name: alsa_output.usb-Focusrite.HiFi__Line1__sink
	Description: Focusrite
	Properties:
		priority.session = "500"
`);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ index: 42, name: 'sharkord_capture', priority: 1000 });
    expect(parsed[1]?.description).toBe('Focusrite');
  });

  it('reads sink inputs with the owning process', () => {
    const inputs = parseSinkInputs(fixture('pactl-sink-inputs.txt'));

    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some((input) => input.processId !== null && input.processId > 0)).toBe(true);
    expect(inputs.every((input) => input.sinkIndex > 0)).toBe(true);
  });

  it('maps application properties of a stream', () => {
    const parsed = parseSinkInputs(`Sink Input #7174
	Driver: PipeWire
	Sink: 458
	Properties:
		application.name = "Google Chrome"
		application.process.id = "27893"
		application.process.binary = "chrome"
`);

    expect(parsed).toEqual([
      { id: 7174, sinkIndex: 458, appName: 'Google Chrome', processId: 27893, binary: 'chrome' }
    ]);
  });

  it('reads modules and their arguments', () => {
    const modules = parseModules(fixture('pactl-modules.txt'));
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.every((module) => module.name.length > 0)).toBe(true);

    const parsed = parseModules(`Module #536870916
	Name: module-loopback
	Argument: source=sharkord_capture.monitor sink=alsa_output.x latency_msec=10
	Usage counter: n/a
`);

    expect(parsed[0]).toEqual({
      id: 536870916,
      name: 'module-loopback',
      args: ['source=sharkord_capture.monitor', 'sink=alsa_output.x', 'latency_msec=10']
    });
  });

  it('parses subscription events', () => {
    expect(parseSubscribeLine("Event 'new' on sink #42")).toEqual({
      event: 'new',
      type: 'sink',
      index: 42
    });
    expect(parseSubscribeLine("Event 'remove' on sink-input #9")).toEqual({
      event: 'remove',
      type: 'sink-input',
      index: 9
    });
    expect(parseSubscribeLine("Event 'change' on server")).toEqual({
      event: 'change',
      type: 'server',
      index: null
    });
    expect(parseSubscribeLine('not an event')).toBeNull();
  });
});

describe('pickHardwareSink', () => {
  it('prefers the highest priority non-virtual sink', () => {
    const picked = pickHardwareSink(
      [sink('virtual', 5000), sink('usb', 900), sink('hdmi', 1200)],
      ['virtual']
    );
    expect(picked).toBe('hdmi');
  });

  it('ignores monitor sources and returns null when nothing is left', () => {
    const monitor: Sink = { ...sink('capture.monitor', 9999), isMonitor: true };
    expect(pickHardwareSink([monitor, sink('capture', 9999)], ['capture'])).toBeNull();
  });
});
