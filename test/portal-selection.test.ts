import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcessMock.spawn };
});

import {
  parsePortalStartCall,
  parsePortalStartReply,
  PortalSelectionObserver,
  PortalSelectionTracker,
  portalObserverTestHelpers,
  type PortalStartCall
} from '../src/main/portal-selection';

const OWNERS = {
  portalOwner: ':1.29',
  backendOwner: ':1.41',
  backendName: 'org.freedesktop.impl.portal.desktop.hyprland',
  appId: 'sharkord-desktop'
};

const startCall = (overrides: Record<string, unknown> = {}) => ({
  type: 'method_call',
  cookie: 88,
  sender: OWNERS.portalOwner,
  destination: OWNERS.backendName,
  path: '/org/freedesktop/portal/desktop',
  interface: 'org.freedesktop.impl.portal.ScreenCast',
  member: 'Start',
  payload: {
    type: 'oossa{sv}',
    data: [
      '/org/freedesktop/portal/desktop/request/1_3588/webrtc394218407',
      '/org/freedesktop/portal/desktop/session/1_3588/webrtc_session1340027225',
      OWNERS.appId,
      '',
      [{ types: { type: 'u', data: 3 }, multiple: { type: 'b', data: false } }]
    ]
  },
  ...overrides
});

const startReply = (call: PortalStartCall, options: {
  sourceType?: number;
  streamSourceType?: number;
  issuer?: string;
  restoreVersion?: number;
  windowClass?: string;
  output?: string;
  serial?: string | number;
  omitSerial?: boolean;
  streams?: unknown[];
  status?: number;
  restoreData?: unknown;
  omitRestoreData?: boolean;
  overrides?: Record<string, unknown>;
} = {}) => ({
  type: 'method_return',
  sender: OWNERS.backendOwner,
  destination: OWNERS.portalOwner,
  reply_cookie: call.cookie,
  payload: {
    type: 'ua{sv}',
    data: [options.status ?? 0, [{
      source_type: { type: 'u', data: options.sourceType ?? 2 },
      streams: {
        type: 'a(ua{sv})',
        data: options.streams ?? [[51, [{
          source_type: { type: 'u', data: options.streamSourceType ?? options.sourceType ?? 2 },
          ...(options.output === undefined ? {} : { mapping_id: { type: 's', data: options.output } }),
          'pipewire-serial': options.omitSerial ? undefined : { type: 't', data: options.serial ?? '901' }
        }]]]
      },
      restore_data: options.omitRestoreData ? undefined : options.restoreData ?? {
        type: '(suv)',
        data: [
          options.issuer ?? 'hyprland',
          options.restoreVersion ?? 3,
          {
            type: 'a{sv}',
            data: [{
              windowClass: { type: 's', data: options.windowClass ?? 'fixture-app' },
              windowHandle: { type: 't', data: '812' },
              timeIssued: { type: 't', data: '1791830000' },
              token: { type: 's', data: 'todo' },
              withCursor: { type: 'u', data: 0 }
            }]
          }
        ]
      }
    }]]
  },
  ...options.overrides
});

const outputRestoreData = (output: string) => ({
  type: '(suv)',
  data: ['hyprland', 3, { type: 'a{sv}', data: [{ output: { type: 's', data: output } }] }]
});

const makeTracker = (lookupPid: (name: string) => Promise<number>) => new PortalSelectionTracker({
  ...OWNERS,
  mainPid: 2369069,
  generation: 'capture-generation-1',
  lookupPid
});

describe('Hyprland portal Start identity', () => {
  it('accepts only a complete Start call from the current portal to the current backend', () => {
    expect(parsePortalStartCall(startCall(), OWNERS)).toMatchObject({
      cookie: 88,
      requesterName: ':1.3588',
      requestHandle: '/org/freedesktop/portal/desktop/request/1_3588/webrtc394218407',
      sessionHandle: '/org/freedesktop/portal/desktop/session/1_3588/webrtc_session1340027225',
      appId: OWNERS.appId
    });
  });

  it.each([
    ['wrong frontend', { sender: ':1.30' }],
    ['wrong backend destination', { destination: ':1.42' }],
    ['wrong object path', { path: '/org/freedesktop/portal/desktop/session/1_3588/x' }],
    ['wrong interface', { interface: 'org.freedesktop.portal.ScreenCast' }],
    ['wrong member', { member: 'SelectSources' }],
    ['wrong app id', { payload: { type: 'oossa{sv}', data: ['/org/freedesktop/portal/desktop/request/1_3588/x', '/org/freedesktop/portal/desktop/session/1_3588/y', 'other-app', '', [{}]] } }],
    ['wrong signature', { payload: { type: 'ooss', data: [] } }],
    ['mismatched requester names', { payload: { type: 'oossa{sv}', data: ['/org/freedesktop/portal/desktop/request/1_999/x', '/org/freedesktop/portal/desktop/session/1_3588/y', OWNERS.appId, '', [{}]] } }],
    ['malformed object paths', { payload: { type: 'oossa{sv}', data: ['/org/freedesktop/portal/desktop/request/1_3588/x/extra', '/org/freedesktop/portal/desktop/session/1_3588/y', OWNERS.appId, '', [{}]] } }],
    ['oversized handle', { payload: { type: 'oossa{sv}', data: [`/org/freedesktop/portal/desktop/request/1_3588/${'x'.repeat(2048)}`, '/org/freedesktop/portal/desktop/session/1_3588/y', OWNERS.appId, '', [{}]] } }]
  ])('rejects %s', (_case, overrides) => {
    expect(parsePortalStartCall(startCall(overrides), OWNERS)).toBeNull();
  });

  it('accepts an owned unsandboxed Start with the empty app id returned by the native portal', async () => {
    const message = startCall();
    message.payload.data[2] = '';
    const tracker = makeTracker(async () => 2369069);

    await tracker.receive(message);
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));

    expect(tracker.selection).toEqual({
      generation: 'capture-generation-1',
      sourceType: 2,
      windowClass: 'fixture-app',
      windowHandle: '812',
      pipewireSerial: '901'
    });
  });

  it.each([OWNERS.appId, ''])('checks the D-Bus connection PID for app id %j', async (appId) => {
    const message = startCall();
    message.payload.data[2] = appId;
    const lookupPid = vi.fn(async (name: string) => name === ':1.3588' ? 5555 : 0);
    const tracker = makeTracker(lookupPid);
    await tracker.receive(message);
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(lookupPid).toHaveBeenCalledWith(':1.3588');
    expect(tracker.selection).toBeNull();
  });

  it('accepts one successful response only from the exact backend and matching request cookie', () => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    expect(parsePortalStartReply(startReply(call), call, OWNERS)).toEqual({
      sourceType: 2,
      windowClass: 'fixture-app',
      windowHandle: '812',
      pipewireSerial: '901'
    });
  });

  it.each([
    ['wrong reply cookie', { reply_cookie: 89 }],
    ['wrong reply sender', { sender: ':1.42' }],
    ['wrong reply destination', { destination: ':1.30' }],
    ['error response', { type: 'error' }],
    ['wrong reply signature', { payload: { type: 's', data: ['no'] } }],
    ['failed response status', { payload: { type: 'ua{sv}', data: [1, [{}]] } }]
  ])('rejects %s', (_case, overrides) => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    expect(parsePortalStartReply(startReply(call, { overrides }), call, OWNERS)).toBeNull();
  });

  it.each([4, 7])('refuses unsupported source type %s', (sourceType) => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    expect(parsePortalStartReply(startReply(call, { sourceType }), call, OWNERS)).toBeNull();
  });

  it('preserves the exact output metadata for an explicitly selected source_type 1 monitor', () => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    const screenRestoreData = {
      type: '(suv)',
      data: ['hyprland', 3, { type: 'a{sv}', data: [{ output: { type: 's', data: 'DP-1' } }] }]
    };
    expect(parsePortalStartReply(startReply(call, {
      sourceType: 1,
      output: 'DP-1',
      restoreData: screenRestoreData
    }), call, OWNERS)).toEqual({ sourceType: 1, output: 'DP-1', pipewireSerial: '901' });
  });

  it.each([
    ['missing restore output', { omitRestoreData: true, output: 'DP-1' }],
    ['missing stream mapping', { restoreData: { type: '(suv)', data: ['hyprland', 3, { type: 'a{sv}', data: [{ output: { type: 's', data: 'DP-1' } }] }] } }],
    ['mismatched stream mapping', { output: 'DP-2', restoreData: { type: '(suv)', data: ['hyprland', 3, { type: 'a{sv}', data: [{ output: { type: 's', data: 'DP-1' } }] }] } }],
    ['mismatched per-stream type', { streamSourceType: 2, output: 'DP-1', restoreData: { type: '(suv)', data: ['hyprland', 3, { type: 'a{sv}', data: [{ output: { type: 's', data: 'DP-1' } }] }] } }]
  ])('refuses a screen selection with %s', (_case, options) => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    expect(parsePortalStartReply(startReply(call, { sourceType: 1, ...options }), call, OWNERS)).toBeNull();
  });

  it.each([
    ['missing restore data', { omitRestoreData: true }],
    ['wrong vendor', { issuer: 'gnome' }],
    ['unsupported version', { restoreVersion: 2 }],
    ['empty class', { windowClass: '' }],
    ['missing serial', { omitSerial: true }],
    ['multiple streams', { streams: [[51, []], [52, []]] }]
  ])('refuses %s', (_case, options) => {
    const call = parsePortalStartCall(startCall(), OWNERS)!;
    expect(parsePortalStartReply(startReply(call, options), call, OWNERS)).toBeNull();
  });
});

describe('active-generation portal selection tracker', () => {
  it('ignores an unrelated same-app-id process and accepts only the exact main PID', async () => {
    const lookupPid = vi.fn(async (name: string) => name === ':1.1001' ? 5555 : 2369069);
    const tracker = makeTracker(lookupPid);
    const foreign = startCall({
      cookie: 87,
      payload: {
        type: 'oossa{sv}',
        data: [
          '/org/freedesktop/portal/desktop/request/1_1001/a',
          '/org/freedesktop/portal/desktop/session/1_1001/b',
          OWNERS.appId, '', [{}]
        ]
      }
    });
    await tracker.receive(foreign);
    await tracker.receive(startCall());
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(tracker.selection).toEqual({
      generation: 'capture-generation-1',
      sourceType: 2,
      windowClass: 'fixture-app',
      windowHandle: '812',
      pipewireSerial: '901'
    });
  });

  it('accepts a later restored capture Start only for the same chosen window class', async () => {
    const tracker = makeTracker(async () => 2369069);
    const firstCall = parsePortalStartCall(startCall(), OWNERS)!;
    await tracker.receive(startCall());
    await tracker.receive(startReply(firstCall));

    const restoredMessage = startCall({
      cookie: 89,
      payload: {
        type: 'oossa{sv}',
        data: [
          '/org/freedesktop/portal/desktop/request/1_3588/restored',
          '/org/freedesktop/portal/desktop/session/1_3588/restored_session',
          OWNERS.appId, '', [{}]
        ]
      }
    });
    const restoredCall = parsePortalStartCall(restoredMessage, OWNERS)!;
    await tracker.receive(restoredMessage);
    await tracker.receive(startReply(restoredCall, { serial: '902' }));

    expect(tracker.selections).toEqual([
      { generation: 'capture-generation-1', sourceType: 2, windowClass: 'fixture-app', windowHandle: '812', pipewireSerial: '901' },
      { generation: 'capture-generation-1', sourceType: 2, windowClass: 'fixture-app', windowHandle: '812', pipewireSerial: '902' }
    ]);
    expect(tracker.selection).toEqual(tracker.selections[0]);
  });

  it('fails closed when a later restored Start changes the selected class', async () => {
    const tracker = makeTracker(async () => 2369069);
    const firstCall = parsePortalStartCall(startCall(), OWNERS)!;
    await tracker.receive(startCall());
    await tracker.receive(startReply(firstCall));
    const restoredMessage = startCall({ cookie: 89 });
    const restoredCall = parsePortalStartCall(restoredMessage, OWNERS)!;
    await tracker.receive(restoredMessage);
    await tracker.receive(startReply(restoredCall, { windowClass: 'other-app', serial: '902' }));
    expect(tracker.selection).toBeNull();
    expect(tracker.selections).toEqual([]);
  });

  it('fails closed when the same generation has concurrent own Start requests', async () => {
    const tracker = makeTracker(async () => 2369069);
    await tracker.receive(startCall());
    await tracker.receive(startCall({ cookie: 89 }));
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(tracker.selection).toBeNull();
  });

  it('retains exact screen output identity across the restored Start and serial history', async () => {
    const tracker = makeTracker(async () => 2369069);
    const firstMessage = startCall();
    const firstCall = parsePortalStartCall(firstMessage, OWNERS)!;
    await tracker.receive(firstMessage);
    await tracker.receive(startReply(firstCall, {
      sourceType: 1, output: 'DP-1', restoreData: outputRestoreData('DP-1')
    }));
    const restoredMessage = startCall({ cookie: 89 });
    const restoredCall = parsePortalStartCall(restoredMessage, OWNERS)!;
    await tracker.receive(restoredMessage);
    await tracker.receive(startReply(restoredCall, {
      sourceType: 1, output: 'DP-1', serial: '902', restoreData: outputRestoreData('DP-1')
    }));
    expect(tracker.selection).toEqual({
      generation: 'capture-generation-1', sourceType: 1, output: 'DP-1', pipewireSerial: '901'
    });
    expect(tracker.selections).toEqual([
      { generation: 'capture-generation-1', sourceType: 1, output: 'DP-1', pipewireSerial: '901' },
      { generation: 'capture-generation-1', sourceType: 1, output: 'DP-1', pipewireSerial: '902' }
    ]);
  });

  it('invalidates a later Start that changes the selected monitor output or source type', async () => {
    const tracker = makeTracker(async () => 2369069);
    const firstMessage = startCall();
    const firstCall = parsePortalStartCall(firstMessage, OWNERS)!;
    await tracker.receive(firstMessage);
    await tracker.receive(startReply(firstCall, {
      sourceType: 1, output: 'DP-1', restoreData: outputRestoreData('DP-1')
    }));
    const restoredMessage = startCall({ cookie: 89 });
    const restoredCall = parsePortalStartCall(restoredMessage, OWNERS)!;
    await tracker.receive(restoredMessage);
    await tracker.receive(startReply(restoredCall, {
      sourceType: 1, output: 'DP-2', restoreData: outputRestoreData('DP-2')
    }));
    expect(tracker.selection).toBeNull();
    expect(tracker.selections).toEqual([]);

    const sourceTypeTracker = makeTracker(async () => 2369069);
    const screenMessage = startCall();
    const screenCall = parsePortalStartCall(screenMessage, OWNERS)!;
    await sourceTypeTracker.receive(screenMessage);
    await sourceTypeTracker.receive(startReply(screenCall, {
      sourceType: 1, output: 'DP-1', restoreData: outputRestoreData('DP-1')
    }));
    const windowRestoreData = {
      type: '(suv)',
      data: ['hyprland', 3, { type: 'a{sv}', data: [{ windowClass: { type: 's', data: 'fixture-app' } }] }]
    };
    const windowMessage = startCall({ cookie: 89 });
    const windowCall = parsePortalStartCall(windowMessage, OWNERS)!;
    await sourceTypeTracker.receive(windowMessage);
    await sourceTypeTracker.receive(startReply(windowCall, {
      sourceType: 2, windowClass: 'fixture-app', restoreData: windowRestoreData
    }));
    expect(sourceTypeTracker.selection).toBeNull();
    expect(sourceTypeTracker.selections).toEqual([]);
  });

  it('invalidates the grant on portal/backend replacement, cancellation, and late replies', async () => {
    const tracker = makeTracker(async () => 2369069);
    await tracker.receive(startCall());
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(tracker.selection).not.toBeNull();
    await tracker.receive({
      type: 'signal', sender: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged',
      payload: { type: 'sss', data: [OWNERS.backendName, OWNERS.backendOwner, ':1.42'] }
    });
    await tracker.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(tracker.selection).toBeNull();

    const cancelled = makeTracker(async () => 2369069);
    await cancelled.receive(startCall());
    cancelled.cancel();
    await cancelled.receive(startReply({ cookie: 88 } as PortalStartCall));
    expect(cancelled.selection).toBeNull();
  });
});

describe('request-scoped native observer lifecycle', () => {
  class FakeMonitorChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    exitCode: number | null = null;
    killed = false;
    readonly kill = vi.fn((signal?: NodeJS.Signals) => {
      this.killed = true;
      queueMicrotask(() => this.emit('exit', null, signal));
      return true;
    });
  }

  const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };

  it('immediately invalidates selection and disposes only its child and witness', async () => {
    const child = new FakeMonitorChild();
    const witness = {
      isActive: false,
      setPortalBackendProcess: vi.fn(() => true),
      start: vi.fn(async () => { witness.isActive = true; return true; }),
      stop: vi.fn(() => { witness.isActive = false; })
    };
    childProcessMock.spawn.mockReset().mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        event: 'ready', portalOwner: OWNERS.portalOwner, backendOwner: OWNERS.backendOwner, backendPid: process.pid
      })}\n`)));
      return child;
    });
    const observer = new PortalSelectionObserver({ helperPath: process.execPath, windowWitness: witness as any });

    try {
      expect(await observer.start()).toBe(true);
      expect(childProcessMock.spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.any(Object));
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        event: 'start', cookie: 88, requesterName: ':1.3588', requesterPid: process.pid, appId: ''
      })}\n${JSON.stringify({
        event: 'selection', cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901'
      })}\n`));
      await flushMicrotasks();
      expect(observer.selections).toHaveLength(1);

      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ event: 'invalid', reason: 'owner-changed' })}\n`));
      await flushMicrotasks();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(witness.stop).toHaveBeenCalledTimes(1);
      expect(observer.selections).toEqual([]);
      expect(observer.isActive).toBe(false);
      observer.stop();
      expect(witness.stop).toHaveBeenCalledTimes(1);
    } finally {
      observer.stop();
    }
  });

  it('fails closed without an executable helper and never starts a fallback monitor', async () => {
    childProcessMock.spawn.mockReset();
    const observer = new PortalSelectionObserver({ helperPath: '/not/a/real/helper' });
    expect(await observer.start()).toBe(false);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(observer.isActive).toBe(false);
    observer.stop();
  });
});

describe('request-scoped native collector protocol', () => {
  const parseNativeEvent = portalObserverTestHelpers.parseNativeEvent;

  it('accepts only bounded ready/start and minimal selection events', () => {
    expect(parseNativeEvent(JSON.stringify({ event: 'ready', portalOwner: ':1.29', backendOwner: ':1.41', backendPid: 733 }))).toMatchObject({
      event: 'ready', portalOwner: ':1.29', backendOwner: ':1.41', backendPid: 733
    });
    expect(parseNativeEvent(JSON.stringify({ event: 'start', cookie: 88, requesterName: ':1.3588', requesterPid: 733, appId: '' }))).toMatchObject({
      event: 'start', cookie: 88, requesterName: ':1.3588', requesterPid: 733, appId: ''
    });
    expect(parseNativeEvent(JSON.stringify({ event: 'selection', cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901' }))).toMatchObject({
      event: 'selection', cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901'
    });
  });

  it('rejects unknown fields and any full restore-data/token/handle payload', () => {
    expect(parseNativeEvent(JSON.stringify({ event: 'selection', cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901', windowHandle: '812' }))).toBeNull();
    expect(parseNativeEvent(JSON.stringify({ event: 'selection', cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901', token: 'private' }))).toBeNull();
    expect(parseNativeEvent(JSON.stringify({ event: 'unknown', extra: true }))).toBeNull();
  });

  it('uses an explicitly supplied absolute executable path for isolated fixtures only', () => {
    expect(portalObserverTestHelpers.resolvePortalMetadataHelper('relative/helper')).toBeNull();
    expect(portalObserverTestHelpers.resolvePortalMetadataHelper('/not/a/real/helper')).toBeNull();
    expect(portalObserverTestHelpers.resolvePortalMetadataHelper(process.cwd())).toBeNull();
    expect(portalObserverTestHelpers.resolvePortalMetadataHelper(process.execPath)).toBe(process.execPath);
  });

  it('reuses the tracker guards with only minimal window or explicit monitor identity', async () => {
    const windowTracker = makeTracker(async () => 0);
    windowTracker.receiveNativeStart({ cookie: 88, requesterName: ':1.3588', requesterPid: 2369069, appId: '' });
    await windowTracker.receiveNativeSelection({ cookie: 88, sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901' });
    expect(windowTracker.selection).toEqual({
      generation: 'capture-generation-1', sourceType: 2, windowClass: 'fixture-app', pipewireSerial: '901'
    });

    const screenTracker = makeTracker(async () => 0);
    screenTracker.receiveNativeStart({ cookie: 89, requesterName: ':1.3588', requesterPid: 2369069, appId: OWNERS.appId });
    await screenTracker.receiveNativeSelection({ cookie: 89, sourceType: 1, output: 'DP-1', pipewireSerial: '902' });
    expect(screenTracker.selection).toEqual({
      generation: 'capture-generation-1', sourceType: 1, output: 'DP-1', pipewireSerial: '902'
    });
  });

  it('invalidates a native start with a requester PID other than the exact Electron PID', () => {
    const tracker = makeTracker(async () => 0);
    tracker.receiveNativeStart({ cookie: 88, requesterName: ':1.3588', requesterPid: 5555, appId: OWNERS.appId });
    expect(tracker.isActive).toBe(false);
    expect(tracker.selection).toBeNull();
  });
});
