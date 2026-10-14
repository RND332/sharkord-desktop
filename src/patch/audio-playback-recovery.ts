const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERIES = 3;

/** Rebuild Chromium's shared WebRTC renderer without replacing streams or peers. */
export const installAudioPlaybackRecovery = (doc: Document = document): (() => void) => {
  const playing = new WeakSet<HTMLMediaElement>();
  let attempts: number[] = [];

  const liveAudio = (element: HTMLMediaElement): boolean =>
    element.srcObject instanceof MediaStream &&
    element.srcObject.getAudioTracks().some((track) => track.readyState === 'live');

  const onPlay = (event: Event): void => {
    if (event.target instanceof HTMLMediaElement) playing.add(event.target);
  };
  const onPause = (event: Event): void => {
    // A render error pauses its owner before dispatching 'error'. Do not mistake
    // that native pause for the user's request to stop playback.
    if (event.target instanceof HTMLMediaElement && !event.target.error) playing.delete(event.target);
  };
  const onError = (event: Event): void => {
    const failed = event.target;
    if (!(failed instanceof HTMLMediaElement) || failed.error?.code !== 3 || !liveAudio(failed)) return;

    const now = Date.now();
    attempts = attempts.filter((time) => now - time < RECOVERY_WINDOW_MS);
    if (attempts.length >= MAX_RECOVERIES) {
      console.warn('[sharkord-desktop] audio playback recovery paused after repeated failures; reload the client');
      return;
    }
    attempts.push(now);

    const elements = Array.from(doc.querySelectorAll<HTMLMediaElement>('audio, video')).filter(liveAudio);
    const resume = elements.map((element) => !element.paused || playing.has(element));
    // Reload every owner before starting any of them: repairing only the element
    // which reported the error leaves the shared renderer held by its siblings.
    for (const element of elements) element.load();
    elements.forEach((element, index) => {
      if (!resume[index]) {
        element.pause(); // Prevent load() from autoplaying an intentionally paused stream.
        return;
      }
      void element.play().catch((error: unknown) => {
        console.warn('[sharkord-desktop] audio playback restart failed:', error);
      });
    });
    console.info('[sharkord-desktop] rebuilt stream audio playback:', elements.length);
  };

  doc.addEventListener('play', onPlay, true);
  doc.addEventListener('pause', onPause, true);
  // Media errors do not bubble; the capturing listener also covers future elements.
  doc.addEventListener('error', onError, true);
  return () => {
    doc.removeEventListener('play', onPlay, true);
    doc.removeEventListener('pause', onPause, true);
    doc.removeEventListener('error', onError, true);
  };
};
