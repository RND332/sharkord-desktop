import { installGetDisplayMediaPatch, type PatchEnvironment } from './index';

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
}
