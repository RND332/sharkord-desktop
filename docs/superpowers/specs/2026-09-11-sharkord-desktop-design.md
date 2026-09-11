# Sharkord Desktop — Design

**Date:** 2026-09-11
**Status:** approved (scope: personal tool, single instance `sharkord.example.com`)
**Author:** agent, on behalf of Talgat

## Problem

Sharing a screen in Sharkord delivers video only. Viewers of the share hear nothing from the
streamer's PC, and the naive fix (capturing "system audio") captures the streamer's *local playback
of the voice channel*, so viewers hear themselves (echo/feedback).

Sharkord v0.0.25 (the deployed server, = current upstream release) already ships the publish path:
the client asks `getDisplayMedia({ audio: … })` and, when an audio track comes back, publishes it as
a `SCREEN_AUDIO` producer. Upstream's newer `restrictOwnAudio` toggle is not in v0.0.25 and Chromium
does not implement it on Linux.

On Linux, Chromium cannot provide system audio at all:

- `getDisplayMedia({ audio: true })` returns no audio track (no OS loopback backend).
- PipeWire monitor sources are filtered out of `enumerateDevices()` (measured in Electron 43: 5
  physical inputs, no `Monitor of …`), so a monitor cannot be opened via `getUserMedia()` either.

## Solution

An Electron desktop client that loads the unmodified Sharkord web client and supplies the missing
capture itself, with audio routing arranged so that "everything the streamer hears except Sharkord"
exists as a single PipeWire signal.

### Audio graph

```text
games / browser / YouTube ──►  [sharkord_capture]  (null sink, DEFAULT)  ──monitor──► parec ──► injected
                                          │                                                       audio track
                                          └─monitor──► loopback ──► [real output device] ──► streamer hears it
                                                                                                    │
desktop client itself  ──(PULSE_SINK=<real output>)──────────────────► [real output device] ──► streamer  │
                                                                      hears voices                     ▼
                                                                      (never captured)      mediasoup SCREEN_AUDIO
```

The capture point is the **virtual sink's** monitor, not the hardware monitor: the hardware monitor
unavoidably contains the voice playback. Everything else (games, browser, YouTube, the streamer's
own client UI sounds) lands on the virtual sink and is captured; the desktop client's own playback is
pinned to the real output device via `PULSE_SINK` and is therefore absent from the capture.

Measured on the target workstation (2026-09-11): a tone sent straight to the Focusrite appears in the
virtual-sink capture at amplitude `0.0000`; a tone sent to the capture sink appears at `0.3500`; the
loopback reproduces both locally at full level.

### Capture → track injection

Chromium hides monitor devices, so the audio is captured natively and injected:

1. main process spawns `parec -d sharkord_capture.monitor --format=float32le --rate=48000
   --channels=2 --latency-msec=20` (supervised, restarted on unexpected exit);
2. 20 ms chunks travel over IPC to the renderer;
3. a **main-world** patch of `navigator.mediaDevices.getDisplayMedia` (installed by the preload)
   calls the original for video (portal picker), and appends an audio track built from the PCM with
   `MediaStreamTrackGenerator` + `AudioData` (`f32`, interleaved);
4. the Sharkord client sees a normal `MediaStream` with a video and an audio track and publishes both
   — including `SCREEN_AUDIO` — with no client changes.

Verified in Electron 43: `MediaStreamTrackGenerator` / `MediaStreamTrackProcessor` / `AudioData` exist
and the full `parec → IPC → AudioData → track` chain carries the signal (silence before the tone,
correct level during it).

The patch is applied to the standard API only, so it survives Sharkord client updates and requires no
fork and no server change.

## Components

| File | Responsibility |
|---|---|
| `src/main/pipewire.ts` | stateless `pactl` wrapper: typed invocations + parsers (`list sinks`, `list sink-inputs`, `list modules`, `get-default-sink`, `subscribe`) |
| `src/main/routing.ts` | `RoutingManager`: setup (null sink → loopback → default sink → move foreign streams), health watch, teardown, stale-state recovery |
| `src/main/capture.ts` | `Capture`: `parec` supervisor, chunk fan-out, restart policy |
| `src/main/index.ts` | lifecycle, window, permissions, display-media handler, wiring, exit teardown, `--selftest` / `--cleanup` |
| `src/main/config.ts` | URL, sink name, hw sink override, debug PCM path, CLI parsing |
| `src/shared/pcm.ts` | interleaved f32 → `AudioData` framing math, Goertzel band measurement, WAV writer (used by the main-world patch and the selftest) |
| `src/preload/index.ts` | `contextBridge` API (`createSystemAudioTrack`, `release`), injects the patch into the main world |
| `src/patch/index.ts` | main-world `getDisplayMedia` wrapper (bundled by esbuild to `dist/patch.js`) |
| `scripts/` | build, selftest driver |

## Interfaces

```ts
// pipewire.ts
type Runner = (args: string[]) => Promise<string>;
listSinks(r): Promise<Sink[]>;            // {index, name, driver, priority, isVirtual}
listSinkInputs(r): Promise<SinkInput[]>;  // {id, sinkIndex, appName, processId, binary}
listModules(r): Promise<Module[]>;        // {id, name, args}
getDefaultSink(r): Promise<string>;
loadModule(r, name, args): Promise<number>;
unloadModule(r, id): Promise<void>;
moveSinkInput(r, id, sinkName): Promise<void>;
subscribe(r, onEvent): () => void;

// routing.ts
class RoutingManager {
  start(): Promise<void>;      // idempotent; cleans stale state first
  stop(): Promise<void>;       // restores default sink, unloads modules
  ensureHealthy(): Promise<void>;
  get state(): { sinkName, hwSink, nullModuleId, loopbackModuleId, active };
}

// capture.ts
class Capture {
  start(): void;  stop(): void;
  onData(cb: (chunk: Buffer) => void): () => void;
}

// shared/pcm.ts
frameInterleavedF32(buf, offsetBytes): { frames, data: Float32Array } | null
measureBand(samples: Float32Array, freq: number, sampleRate: number): number  // Goertzel amplitude
writeWav(path, chunks, sampleRate, channels)
```

IPC (main → renderer): `pcm` (Buffer). Renderer → main: `capture:acquire` / `capture:release`.

## Failure handling

- **Crash / SIGKILL while routing is active** — module ids and the previous default sink are written
  to `$XDG_RUNTIME_DIR/sharkord-desktop.json`; `start()` tears that state down before re-setting up, and
  `--cleanup` does the same by hand. `before-quit`/`SIGINT`/`SIGTERM` run a synchronous teardown.
- **Unloading the null sink relocates orphaned streams** to the restored default (WirePlumber
  behaviour), so quitting the app cannot silence the PC.
- **Device change / unplug** — `pactl subscribe` events are debounced into `ensureHealthy()`: a
  missing loopback or sink is recreated; if the recorded hardware sink vanished, a replacement is
  chosen by highest `priority.session` among non-virtual sinks.
- **`parec` dies** — restart with backoff (max 5 attempts); if the sink itself is gone, stay down and
  report; capture restarts on the next share.
- **Audio outside Sharkord routed to a non-default device deliberately** — such streams are moved
  into the capture sink while the app runs (that is the point: "whole PC sound"), and every moved
  stream's original sink is recorded so nothing is misrouted after teardown. *(v1: streams are moved
  at setup; per-stream restore is only needed if the user reports lost pinning.)*
- **Chromium auto-grant** — `setPermissionRequestHandler` allows `media`/`display-capture` for the
  configured origin only, everything else is denied.

## Verification

1. **Unit** (vitest): parsers against captured `pactl` output; `RoutingManager` against a recording
   fake runner (setup order, idempotent restart, teardown, health repair, own-stream protection);
   `Capture` restart policy with a fake spawn; `pcm` framing incl. **per-channel** RMS assertion
   (catches the interleaved/planar confusion observed in the spike) and Goertzel measurement;
   `patch` behaviour (audio:false passthrough, merge, capture-failure fallback, release on stop).
2. **Selftest** (`bun run selftest`): launches the real app, asserts routing state via `pactl`, then
   plays tone A *inside the app window* and tone B from an external process while recording the
   injected PCM; asserts tone A is absent (< 1 % of tone B) and tone B present. This is the
   regression test for the whole point of the project.
3. **Live E2E**: real voice channel, real viewer — streamer must hear everyone, viewers must hear
   desktop audio and not themselves. User-driven.

## Out of scope

Windows/macOS; capture of apps bypassing PipeWire (raw ALSA exclusive); per-app include/exclude
lists; a "include Sharkord audio" toggle; upstreaming to Sharkord; packaging (AppImage/pacman).
