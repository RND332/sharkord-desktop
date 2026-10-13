import { defaultRunner, isOwnProcess, parseGraph, readProcessIdentity, type Runner, type TapTarget } from './tap';
import type { HyprlandWindowContinuity } from './hyprland-window-continuity';
import type { PortalSelection } from './portal-selection';

const isPortalGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isPortalSerial = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);

export const resolveLinuxAudioTarget = async (
  source: { id: string; name: string },
  options: {
    wayland: boolean;
    runner?: Runner;
    selection?: PortalSelection | null;
    windowWitness?: Pick<HyprlandWindowContinuity, 'isActive' | 'resolveWindowClass'>;
    readIdentity?: (pid: number) => { pid: number; startTime: string } | null;
  }
): Promise<TapTarget | null> => {
  const runner = options.runner ?? defaultRunner;
  const readIdentity = options.readIdentity ?? readProcessIdentity;
  if (options.wayland) {
    // Source IDs and names are opaque on Wayland. Only the exact, owned portal
    // Start metadata can identify a type-1 output or type-2 selected window.
    const selection = options.selection;
    if (!selection || !isPortalGeneration(selection.generation) || !isPortalSerial(selection.pipewireSerial)) return null;
    if (selection.sourceType === 1) {
      if (typeof selection.output !== 'string' || selection.output.length === 0 || Buffer.byteLength(selection.output, 'utf8') > 512) return null;
      return {
        kind: 'screen',
        portalGeneration: selection.generation,
        portalSourceType: 1,
        portalOutput: selection.output,
        portalPipewireSerial: selection.pipewireSerial
      };
    }
    if (selection.sourceType !== 2 || typeof selection.windowClass !== 'string' ||
        selection.windowClass.length === 0 || Buffer.byteLength(selection.windowClass, 'utf8') > 512 ||
        !options.windowWitness?.isActive) return null;
    try {
      const target = await options.windowWitness.resolveWindowClass(selection.windowClass);
      if (!target || target.kind !== 'application' || !options.windowWitness.isActive) return null;
      return {
        ...target,
        portalGeneration: selection.generation,
        portalSourceType: 2,
        portalWindowClass: selection.windowClass,
        ...(selection.windowHandle ? { portalWindowHandle: selection.windowHandle } : {}),
        portalPipewireSerial: selection.pipewireSerial
      };
    } catch {
      return null;
    }
  }
  if (/^screen:\d+:\d+$/.test(source.id)) return { kind: 'screen' };
  const window = /^window:([1-9]\d*):\d+$/.exec(source.id);
  if (!window) return null;
  try {
    const result = await runner('xprop', ['-id', window[1]!, '_NET_WM_PID']);
    const pidMatch = /^_NET_WM_PID\(CARDINAL\) = ([1-9]\d*)\s*$/.exec(result);
    if (!pidMatch || !Number.isSafeInteger(Number(pidMatch[1]))) return null;
    const pid = Number(pidMatch[1]);
    const identity = readIdentity(pid);
    if (!identity || identity.pid !== pid) return null;
    return { kind: 'application', processId: pid, processStartTime: identity.startTime };
  } catch {
    return null;
  }
};

type PortalCaptureBindingOptions = {
  runner?: Runner;
  tapName?: string;
  captureProcess?: (pid: number | null) => boolean;
  isActive?: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
};

/** Bind audio only to an active video stream from this exact portal grant. */
export const bindPortalCaptureTarget = async (
  target: TapTarget,
  selections: () => readonly PortalSelection[],
  options: PortalCaptureBindingOptions = {}
): Promise<TapTarget | null> => {
  const generation = target.portalGeneration;
  const serial = target.portalPipewireSerial;
  const validCommon = isPortalGeneration(generation) && isPortalSerial(serial);
  const validScreen = target.kind === 'screen' && target.portalSourceType === 1 &&
    typeof target.portalOutput === 'string' && target.portalOutput.length > 0 && Buffer.byteLength(target.portalOutput, 'utf8') <= 512;
  const validWindow = target.kind === 'application' && target.portalSourceType === 2 &&
    typeof target.portalWindowClass === 'string' && target.portalWindowClass.length > 0 &&
    Buffer.byteLength(target.portalWindowClass, 'utf8') <= 512 && Number.isSafeInteger(target.processId) &&
    target.processId > 1 && typeof target.processStartTime === 'string' && target.processStartTime.length > 0;
  if (!validCommon || (!validScreen && !validWindow)) return null;

  const runner = options.runner ?? defaultRunner;
  const captureProcess = options.captureProcess ?? ((pid) => isOwnProcess(pid));
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? 2500, 5000));
  const pollMs = Math.max(1, Math.min(options.pollMs ?? 50, 250));
  const deadline = Date.now() + timeoutMs;
  const matchesTarget = (selection: PortalSelection): boolean => {
    if (selection.generation !== generation || selection.sourceType !== target.portalSourceType ||
        !isPortalSerial(selection.pipewireSerial)) return false;
    if (target.kind === 'screen') return selection.sourceType === 1 && selection.output === target.portalOutput;
    if (selection.sourceType !== 2 || selection.windowClass !== target.portalWindowClass) return false;
    return target.portalWindowHandle === undefined || selection.windowHandle === undefined ||
      target.portalWindowHandle === selection.windowHandle;
  };

  while (Date.now() <= deadline) {
    if (options.isActive && !options.isActive()) return null;
    let observed: readonly PortalSelection[];
    try {
      observed = selections();
    } catch {
      return null;
    }
    const serials = new Set(observed.filter(matchesTarget).map((selection) => selection.pipewireSerial));
    if (!serial || !serials.has(serial)) return null;

    let graphJson: string;
    try {
      graphJson = await runner('pw-dump', ['-i', '0']);
    } catch {
      return null;
    }
    if (options.isActive && !options.isActive()) return null;
    const graph = parseGraph(graphJson, options.tapName ?? 'sharkord_capture');
    const matches = graph.videoCaptures.filter((capture) => captureProcess(capture.processId) &&
      capture.targetSerials.length === 1 && serials.has(capture.targetSerials[0]!));
    if (matches.length === 1) {
      return { ...target, portalPipewireSerial: matches[0]!.targetSerials[0]! };
    }
    if (matches.length > 1 || Date.now() >= deadline) return null;
    await delay(pollMs);
  }
  return null;
};
