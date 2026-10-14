import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAudioPlaybackRecovery } from '../src/patch/audio-playback-recovery';

class Stream {
  constructor(readonly tracks = [{ readyState: 'live' }]) {}
  getAudioTracks() { return this.tracks; }
}

const operations: string[] = [];
class Media {
  srcObject: Stream | null = new Stream();
  error: { code: number } | null = null;
  paused = false;
  autoplay = true;
  muted = false;
  volume = 0.5;
  sinkId = 'selected-speaker';
  constructor(readonly name: string) {}
  load = vi.fn(() => { operations.push(`load:${this.name}`); this.error = null; this.paused = true; });
  play = vi.fn(async () => { operations.push(`play:${this.name}`); this.paused = false; });
  pause = vi.fn(() => { operations.push(`pause:${this.name}`); this.paused = true; });
}
class Page {
  elements: Media[] = [];
  handlers = new Map<string, Set<EventListener>>();
  addEventListener(type: string, callback: EventListener, capture: boolean) {
    expect(capture).toBe(true);
    const callbacks = this.handlers.get(type) ?? new Set();
    callbacks.add(callback);
    this.handlers.set(type, callbacks);
  }
  removeEventListener(type: string, callback: EventListener, capture: boolean) {
    expect(capture).toBe(true);
    this.handlers.get(type)?.delete(callback);
  }
  querySelectorAll(selector: string) { expect(selector).toBe('audio, video'); return this.elements; }
  emit(type: string, target: unknown) {
    for (const listener of this.handlers.get(type) ?? []) listener({ target } as Event);
  }
}

let page: Page;
let dispose: () => void;
let now: number;
beforeEach(() => {
  now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('HTMLMediaElement', Media);
  vi.stubGlobal('MediaStream', Stream);
  operations.length = 0;
  page = new Page();
  dispose = installAudioPlaybackRecovery(page as unknown as Document);
});
afterEach(() => { dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fail = (element: Media, code = 3) => {
  element.error = { code };
  page.emit('error', element);
};

describe('stream audio playback recovery', () => {
  it('reloads all shared renderer owners before resuming voice and screen audio', () => {
    const voice = new Media('voice');
    const share = new Media('share');
    page.elements.push(voice, share);
    page.emit('play', voice);
    voice.paused = true;
    voice.error = { code: 3 };
    page.emit('pause', voice); // Chromium's error-driven pause, not a user pause.
    page.emit('error', voice);
    expect(operations).toEqual(['load:voice', 'load:share', 'play:voice', 'play:share']);
    expect(voice.error).toBeNull();
    expect(voice.paused).toBe(false);
  });

  it('preserves source identity, selected speaker, volume and mute', () => {
    const voice = new Media('voice');
    voice.muted = true;
    voice.volume = 0.17;
    const original = voice.srcObject;
    page.elements.push(voice);
    fail(voice);
    expect(voice.srcObject).toBe(original);
    expect(voice.sinkId).toBe('selected-speaker');
    expect(voice.volume).toBe(0.17);
    expect(voice.muted).toBe(true);
  });

  it('does not autoplay a stream intentionally paused before the interruption', () => {
    const voice = new Media('voice');
    const paused = new Media('paused');
    page.elements.push(voice, paused);
    page.emit('play', paused);
    paused.paused = true;
    page.emit('pause', paused);
    fail(voice);
    expect(paused.load).toHaveBeenCalledOnce();
    expect(paused.pause).toHaveBeenCalledOnce();
    expect(paused.play).not.toHaveBeenCalled();
    expect(paused.paused).toBe(true);
  });

  it('also repairs media elements attached after installing the listener', () => {
    const later = new Media('later');
    page.elements.push(later);
    fail(later);
    expect(later.load).toHaveBeenCalledOnce();
    expect(later.play).toHaveBeenCalledOnce();
  });

  it('ignores video-only streams and ended audio while repairing live audio', () => {
    const voice = new Media('voice');
    const video = new Media('video');
    const ended = new Media('ended');
    video.srcObject = new Stream([]);
    ended.srcObject = new Stream([{ readyState: 'ended' }]);
    page.elements.push(voice, video, ended);
    fail(voice);
    expect(video.load).not.toHaveBeenCalled();
    expect(ended.load).not.toHaveBeenCalled();
    expect(voice.load).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 4])('ignores unrelated media error code %s', (code) => {
    const voice = new Media('voice');
    page.elements.push(voice);
    fail(voice, code);
    expect(voice.load).not.toHaveBeenCalled();
  });

  it('ignores ordinary file media and non-media error targets', () => {
    const file = new Media('file');
    file.srcObject = null;
    page.elements.push(file);
    fail(file);
    page.emit('error', { error: { code: 3 }, srcObject: new Stream() });
    expect(file.load).not.toHaveBeenCalled();
  });

  it('bounds persistent failures and permits recovery again outside the window', () => {
    const voice = new Media('voice');
    page.elements.push(voice);
    for (let i = 0; i < 5; i++) fail(voice);
    expect(voice.load).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('repeated failures'));
    now += 60_000;
    fail(voice);
    expect(voice.load).toHaveBeenCalledTimes(4);
  });

  it('does not produce an unhandled rejection when playback is denied', async () => {
    const voice = new Media('voice');
    const error = new Error('autoplay denied');
    voice.play.mockRejectedValueOnce(error);
    page.elements.push(voice);
    fail(voice);
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('restart failed'), error);
    expect(voice.load).toHaveBeenCalledOnce();
  });

  it('removes all document listeners on disposal', () => {
    const voice = new Media('voice');
    page.elements.push(voice);
    dispose();
    fail(voice);
    expect(voice.load).not.toHaveBeenCalled();
    expect([...page.handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
});
