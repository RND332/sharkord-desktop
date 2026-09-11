import { execFile, spawn } from 'node:child_process';

export type Runner = (args: string[]) => Promise<string>;

export type Sink = {
  index: number;
  name: string;
  description: string;
  priority: number;
  isMonitor: boolean;
};

export type SinkInput = {
  id: number;
  sinkIndex: number;
  appName: string;
  processId: number | null;
  binary: string | null;
};

export type Module = { id: number; name: string; args: string[] };

export type SubscribeEvent = { event: string; type: string; index: number | null };

export const realRunner: Runner = (args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile('pactl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  return promise;
};

const blocksOf = (text: string, label: string): Array<{ id: number; body: string }> => {
  const blocks: Array<{ id: number; body: string }> = [];
  let current: { id: number; body: string[] } | null = null;

  for (const line of text.split('\n')) {
    const header = line.match(new RegExp(`^${label} #(\\d+)$`));
    if (header) {
      if (current) blocks.push({ id: current.id, body: current.body.join('\n') });
      current = { id: Number(header[1]), body: [] };
      continue;
    }
    current?.body.push(line);
  }

  if (current) blocks.push({ id: current.id, body: current.body.join('\n') });
  return blocks;
};

const property = (body: string, key: string): string | null => {
  const match = body.match(new RegExp(`^[\\t ]*${key} = "?(.*?)"?$`, 'm'));
  return match?.[1] ?? null;
};

/** Header lines of a block look like `Name: alsa_output…`, not `key = "value"`. */
const field = (body: string, key: string): string | null => {
  const match = body.match(new RegExp(`^[\\t ]*${key}: (.*)$`, 'm'));
  return match?.[1]?.trim() ?? null;
};

const numberOrNull = (value: string | null): number | null => {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) ? parsed : null;
};

export const parseSinks = (text: string): Sink[] =>
  blocksOf(text, 'Sink').map(({ id, body }) => {
    const name = field(body, 'Name') ?? '';
    return {
      index: id,
      name,
      description: field(body, 'Description') ?? '',
      priority: numberOrNull(property(body, 'priority.session')) ?? 0,
      isMonitor: name.endsWith('.monitor')
    };
  });

export const parseSinkInputs = (text: string): SinkInput[] =>
  blocksOf(text, 'Sink Input').map(({ id, body }) => ({
    id,
    sinkIndex: numberOrNull(field(body, 'Sink')) ?? -1,
    appName: property(body, 'application.name') ?? '',
    processId: numberOrNull(property(body, 'application.process.id')),
    binary: property(body, 'application.process.binary')
  }));

export const parseModules = (text: string): Module[] =>
  blocksOf(text, 'Module').map(({ id, body }) => ({
    id,
    name: field(body, 'Name') ?? '',
    args: (field(body, 'Argument') ?? '').split(/\s+/).filter(Boolean)
  }));

export const parseDefaultSink = (text: string): string => text.trim();

export const parseSubscribeLine = (line: string): SubscribeEvent | null => {
  const match = line.match(/^Event '([^']+)' on (\S+)(?: #(\d+))?/);
  if (!match) return null;
  return {
    event: match[1] ?? '',
    type: match[2] ?? '',
    index: match[3] === undefined ? null : Number(match[3])
  };
};

export const listSinks = async (runner: Runner): Promise<Sink[]> =>
  parseSinks(await runner(['list', 'sinks']));

export const listSinkInputs = async (runner: Runner): Promise<SinkInput[]> =>
  parseSinkInputs(await runner(['list', 'sink-inputs']));

export const listModules = async (runner: Runner): Promise<Module[]> =>
  parseModules(await runner(['list', 'modules']));

export const getDefaultSink = async (runner: Runner): Promise<string> =>
  parseDefaultSink(await runner(['get-default-sink']));

export const loadModule = async (runner: Runner, name: string, args: string[]): Promise<number> => {
  const id = Number((await runner(['load-module', name, ...args])).trim());
  if (!Number.isInteger(id)) throw new Error(`pactl load-module ${name} returned no module id`);
  return id;
};

export const unloadModule = async (runner: Runner, id: number): Promise<void> => {
  await runner(['unload-module', String(id)]);
};

export const moveSinkInput = async (runner: Runner, id: number, sinkName: string): Promise<void> => {
  await runner(['move-sink-input', String(id), sinkName]);
};

export const setDefaultSink = async (runner: Runner, name: string): Promise<void> => {
  await runner(['set-default-sink', name]);
};

export const pickHardwareSink = (sinks: Sink[], excludeNames: string[]): string | null => {
  const candidates = sinks
    .filter((sink) => !sink.isMonitor && !excludeNames.includes(sink.name))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0]?.name ?? null;
};

export const subscribe = (
  onEvent: (event: SubscribeEvent) => void,
  spawner: typeof spawn = spawn
): (() => void) => {
  const child = spawner('pactl', ['subscribe']);
  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseSubscribeLine(line);
      if (event) onEvent(event);
    }
  });

  return () => {
    child.kill();
  };
};
