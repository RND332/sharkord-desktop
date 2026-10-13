import { createServer, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HyprlandWindowContinuity } from '../src/main/hyprland-window-continuity';

type Client = { address: string; mapped: boolean; pid: number; class: string };

const P1: Client = { address: '0x1', mapped: true, pid: 101, class: 'fixture-app' };
const P1_SECOND_WINDOW: Client = { address: '0x3', mapped: true, pid: 101, class: 'fixture-app' };
const P2: Client = { address: '0x2', mapped: true, pid: 202, class: 'fixture-app' };
const PORTAL_PICKER: Client = { address: '0x3', mapped: true, pid: 303, class: 'hyprland-share-picker' };

let server: ReturnType<typeof createServer>;
let serverSocket: Socket | null;
let socketPath: string;
let clients: Client[];
let witness: HyprlandWindowContinuity;
let runner: ReturnType<typeof vi.fn>;
let p1StartTime = 'p1-start';

const flushIpc = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
};

const startFixture = async (initial: Client[] = [P1], extra: Record<string, unknown> = {}): Promise<void> => {
  clients = initial;
  p1StartTime = 'p1-start';
  serverSocket = null;
  socketPath = join(process.cwd(), `.hypr-${process.pid}.sock`);
  expect(Buffer.byteLength(socketPath)).toBeLessThan(108);
  server = createServer((socket) => { serverSocket = socket; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  runner = vi.fn(async (bin: string, args: string[]) => {
    expect(bin).toBe('hyprctl');
    expect(args).toEqual(['clients', '-j']);
    return JSON.stringify(clients);
  });
  witness = new HyprlandWindowContinuity({
    socketPath,
    runner: runner as unknown as import('../src/main/tap').Runner,
    readIdentity: (pid: number) => pid === 101
      ? { pid, startTime: p1StartTime }
      : pid === 202 ? { pid, startTime: 'p2-start' }
        : pid === 303 ? { pid, startTime: 'picker-start' } : null,
    connectTimeoutMs: 500,
    ...extra
  } as never);
  expect(await witness.start()).toBe(true);
  expect(serverSocket).not.toBeNull();
};

const sendEvent = async (event: string): Promise<void> => {
  if (!serverSocket) throw new Error('fixture client is not connected');
  serverSocket.write(event);
  await flushIpc();
};

afterEach(async () => {
  witness?.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (socketPath) await unlink(socketPath).catch(() => {});
});

describe('Hyprland window continuity witness', () => {
  it('keeps a legitimate unchanged selected process eligible across multiple same-process windows', async () => {
    await startFixture([P1, P1_SECOND_WINDOW]);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toEqual({
      kind: 'application', processId: 101, processStartTime: 'p1-start'
    });
  });

  it('fails closed when a class has multiple pre-picker process roots', async () => {
    await startFixture([P1, P2]);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
    expect(witness.isActive).toBe(true);
  });

  it('allows a normal focus change when the reported class still matches that baseline window', async () => {
    await startFixture([P1]);
    await sendEvent('activewindow>>fixture-app,private title\nactivewindowv2>>1\n');
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toEqual({
      kind: 'application', processId: 101, processStartTime: 'p1-start'
    });
  });

  it('rejects an activewindow class change even when the same address and PID survive', async () => {
    await startFixture([P1, { ...P2, class: 'other-app' }]);
    await sendEvent('activewindow>>fixture-app,private title\nactivewindowv2>>2\n');
    expect(witness.invalidReason).toBe('window-class-change');
    expect(witness.topologyHistory).toEqual([{ kind: 'class-change', address: '2' }]);
    expect(JSON.stringify(witness.topologyHistory)).not.toContain('private title');
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('fails closed when an activewindow class event has no matching address event', async () => {
    await startFixture([P1]);
    await sendEvent('activewindow>>other-app,private title\nopenlayer>>portal-picker\n');
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('fails closed when an address event is missing its class partner', async () => {
    await startFixture([P1]);
    await sendEvent('activewindowv2>>1\n');
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('does not treat the native portal LayerSurface as a new client window', async () => {
    await startFixture([P1]);
    await sendEvent('openlayer>>portal-picker\ncloselayer>>portal-picker\n');
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toEqual({
      kind: 'application', processId: 101, processStartTime: 'p1-start'
    });
  });

  it('allows only windows from the D-Bus-verified portal backend process tree', async () => {
    await startFixture([P1], {
      portalBackendProcess: { pid: 300, startTime: 'backend-start' },
      processStat: (pid: number) => pid === 303
        ? { parentPid: 300, startTime: 'picker-start' }
        : pid === 300 ? { parentPid: 1, startTime: 'backend-start' } : null
    });
    clients = [P1, PORTAL_PICKER];
    await sendEvent('openwindow>>3,1,hyprland-share-picker,private title\n');
    await sendEvent('activewindow>>hyprland-share-picker,private title\nactivewindowv2>>3\n');
    expect(witness.isActive).toBe(true);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toEqual({
      kind: 'application', processId: 101, processStartTime: 'p1-start'
    });

    clients = [P1];
    await sendEvent('closewindow>>3\n');
    expect(witness.isActive).toBe(true);
    expect(JSON.stringify(witness.topologyHistory)).not.toContain('private title');
  });

  it('does not exempt a matching picker class outside the verified backend process tree', async () => {
    await startFixture([P1], {
      portalBackendProcess: { pid: 300, startTime: 'backend-start' },
      processStat: (pid: number) => pid === 300 ? { parentPid: 1, startTime: 'backend-start' } : null
    });
    clients = [P1, { ...P2, class: 'hyprland-share-picker' }];
    await sendEvent('openwindow>>2,1,hyprland-share-picker,private title\n');
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('rejects a selected P1 that closes and is replaced by same-class P2 before the post-selection snapshot', async () => {
    await startFixture([P1]);
    await sendEvent('closewindow>>1\nopenwindow>>2,1,fixture-app,private title\n');
    clients = [P2];
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
    expect(witness.isActive).toBe(false);
  });

  it('rejects a transient same-class P2 open/close even when P1 survives both snapshots', async () => {
    await startFixture([P1]);
    await sendEvent('openwindow>>2,1,fixture-app,private title\nclosewindow>>2\n');
    clients = [P1];
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
    expect(witness.isActive).toBe(false);
  });

  it('rejects PID reuse when the class and address survive but process start identity changes', async () => {
    await startFixture([P1]);
    p1StartTime = 'p1-reused';
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('rejects a same-address window whose selected class changes during consent', async () => {
    await startFixture([P1]);
    clients = [{ ...P1, class: 'other-app' }];
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('fails closed when the event socket disconnects', async () => {
    await startFixture([P1]);
    serverSocket?.destroy();
    await flushIpc();
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('fails closed when a lifecycle event has an invalid compositor address', async () => {
    await startFixture([P1]);
    await sendEvent('openwindow>>not-hex,1,fixture-app,private title\n');
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });

  it('fails closed when the expected socket is missing', async () => {
    socketPath = join(process.cwd(), `.hypr-missing-${process.pid}.sock`);
    await unlink(socketPath).catch(() => {});
    expect(Buffer.byteLength(socketPath)).toBeLessThan(108);
    witness = new HyprlandWindowContinuity({
      socketPath,
      runner: async () => JSON.stringify([P1]),
      readIdentity: (pid: number) => pid === 101 ? { pid, startTime: 'p1-start' } : null,
      connectTimeoutMs: 100
    });
    expect(await witness.start()).toBe(false);
    expect(witness.isActive).toBe(false);
    await expect(witness.resolveWindowClass('fixture-app')).resolves.toBeNull();
  });
});
