import { installGetDisplayMediaPatch, type PatchEnvironment } from './index';

/** A quiet version marker in the top-left corner, next to nothing the client itself renders there. */
const showVersionBadge = (bridge: { appInfo?(): Promise<{ version: string }> }): void => {
  const appInfo = bridge.appInfo;
  if (!appInfo) return;
  const render = async (): Promise<void> => {
    const { version } = await appInfo();
    const badge = document.createElement('div');
    badge.dataset.sharkordDesktopVersion = version;
    badge.textContent = `Sharkord Desktop ${version}`;
    Object.assign(badge.style, {
      position: 'fixed',
      top: '6px',
      left: '8px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      font: '11px/1.4 system-ui, sans-serif',
      color: 'rgba(226, 232, 240, 0.65)',
      background: 'rgba(11, 13, 18, 0.45)',
      padding: '2px 6px',
      borderRadius: '5px',
      letterSpacing: '0.01em'
    } satisfies Partial<CSSStyleDeclaration>);
    document.body?.append(badge);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void render(), { once: true });
  } else {
    void render();
  }
};

type Bridge = PatchEnvironment['bridge'];

const globals = globalThis as {
  sharkordDesktop?: Bridge;
  MediaStreamTrackGenerator?: unknown;
  AudioData?: unknown;
};

const bridge = globals.sharkordDesktop;
const Generator = globals.MediaStreamTrackGenerator;
const AudioDataCtor = globals.AudioData;

if (!bridge) {
  console.warn('[sharkord-desktop] preload bridge missing, screen-share audio not patched');
} else if (!navigator.mediaDevices) {
  console.warn('[sharkord-desktop] mediaDevices unavailable on this page, not patching');
} else if (typeof Generator !== 'function' || typeof AudioDataCtor !== 'function') {
  console.warn(
    '[sharkord-desktop] MediaStreamTrackGenerator/AudioData unavailable, screen-share audio not patched'
  );
} else {
  installGetDisplayMediaPatch({
    mediaDevices: navigator.mediaDevices,
    MediaStream,
    // Both are Chromium-only constructors absent from the DOM lib; shape checked above.
    MediaStreamTrackGenerator: Generator as unknown as PatchEnvironment['MediaStreamTrackGenerator'],
    AudioData: AudioDataCtor as unknown as PatchEnvironment['AudioData'],
    bridge
  });
  showVersionBadge(bridge);
}
