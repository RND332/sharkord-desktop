# Sharkord Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron desktop client for Sharkord whose screen share carries all PC audio *except* Sharkord's own playback.

**Architecture:** The app loads the unmodified web client, pins its own audio to the real output device (`PULSE_SINK`), makes a virtual null sink the system default (so every other app's audio lands there), captures that sink's monitor with `parec`, and injects the PCM as a `MediaStreamTrackGenerator` audio track into a main-world patch of `getDisplayMedia`. Routing is active while the app runs and is torn down on exit.

**Tech Stack:** Electron 43, TypeScript, esbuild, vitest, PipeWire via `pactl`/`parec`, bun as package manager.

**Spec:** `docs/superpowers/specs/2026-09-11-sharkord-desktop-design.md`

## Global Constraints

- Node/Electron main + preload are **CommonJS** (`dist/*.js`, `"type"` absent from package.json).
- Window loads `https://sharkord.example.com` by default (`SHARKORD_URL` overrides); no local client build.
- No fork of Sharkord, no server changes; patch the standard `getDisplayMedia` API only.
- Capture sink name `sharkord_capture`; loopback latency `10` ms; capture format `float32le 48000 Hz stereo`.
- `PULSE_SINK` for the whole app process tree = the real output device recorded before routing starts.
- All `pactl`/`parec` access goes through injectable `Runner`/`Spawner` seams — tests never touch the system.
- Do not commit `dist/`, `node_modules/`.

---

### Task 1: Scaffold

**Files:** Create `package.json`, `tsconfig.json`, `build.mjs`, `vitest.config.ts`, `.gitignore`, `README.md`, `src/main/index.ts` (temporary stub window).

- [ ] `package.json`: `main: dist/main.js`, scripts `build` (`node build.mjs`), `start` (`bun run build && electron .`), `test` (`vitest run`), `selftest` (`bun run build && electron . --selftest`); devDeps `electron@^43`, `esbuild`, `typescript`, `vitest`, `@types/node`.
- [ ] `build.mjs`: esbuild bundles `src/main/index.ts` → `dist/main.js` (platform node, external electron, cjs), `src/preload/index.ts` → `dist/preload.js`, `src/patch/index.ts` → `dist/patch.js` (iife, browser, target chrome120).
- [ ] Verify: `bun install && bun run build && bun run test` (empty suite passes), `bun run start` shows a window and logs the PipeWire default sink.

### Task 2: `src/main/pipewire.ts`

**Interfaces:** `Runner = (args: string[]) => Promise<string>`; `listSinks`, `listSinkInputs`, `listModules`, `getDefaultSink`, `loadModule(runner, name, args)`, `unloadModule`, `moveSinkInput`, `subscribe(runner, onEvent)`, `pickHardwareSink(sinks, excludeName)`.

- [ ] Parsers are pure functions over captured `pactl` text (`parseSinks`, `parseSinkInputs`, `parseModules`) using fixture files in `test/support/`.
- [ ] `pickHardwareSink`: highest `priority.session`, excluding our sink name and `*.monitor`.
- [ ] Tests: fixture parsing (name/index/priority/process id), `loadModule` returns module id from stdout, `subscribe` yields `{event, type, index}` for `Event 'new' on sink #42`.
- [ ] Verify: `bunx vitest run test/pipewire.test.ts`.

### Task 3: `src/main/routing.ts`

**Interfaces:** `RoutingManager(deps: { runner, statePath, sinkName, log })`, `start()`, `stop()`, `ensureHealthy()`, `state`.

- [ ] `start()` order: read+clean stale state → record `hwSink = getDefaultSink()` → `loadModule module-null-sink sink_name=<sinkName>` → `loadModule module-loopback source=<sinkName>.monitor sink=<hwSink> latency_msec=10` → `setDefaultSink <sinkName>` → move every sink-input whose `processId` is not in our process tree to the sink → write state file.
- [ ] `stop()`: `setDefaultSink <hwSink>`, unload both modules, delete state file. Must be safe to call twice.
- [ ] `ensureHealthy()`: re-create a missing module; if `hwSink` is gone, re-pick via `pickHardwareSink` and recreate the loopback (also re-set it as default? no: default stays ours).
- [ ] Tests (recording fake runner): exact command sequence; idempotent second `start()`; stale-state cleanup unloads recorded module ids; `ensureHealthy` repairs a vanished loopback; own-process sink-inputs are never moved.
- [ ] Verify: `bunx vitest run test/routing.test.ts`.

### Task 4: `src/main/capture.ts`

**Interfaces:** `Capture({ spawner, sinkName, sampleRate, channels, latencyMs, log })`, `start()`, `stop()`, `onData(cb)`, `onState(cb)`.

- [ ] `spawner(bin, args)` → `{ stdout, stderr, on('exit'), kill() }` (seam for tests).
- [ ] Args: `parec -d <sinkName>.monitor --format=float32le --rate=48000 --channels=2 --latency-msec=20`.
- [ ] Restart with backoff (250/500/1000/2000/4000 ms, max 5) on unexpected exit; `stop()` is final.
- [ ] Tests: arg vector; chunk fan-out; restart count and backoff; no restart after `stop()`.
- [ ] Verify: `bunx vitest run test/capture.test.ts`.

### Task 5: `src/shared/pcm.ts`

**Interfaces:** `frameInterleavedF32(chunk: Buffer, carry: Buffer): { carry, frames: Array<{ data: Float32Array, frames: number }> }`, `measureBand(samples, freq, sampleRate)`, `writeWav(path, chunks, sampleRate, channels)`.

- [ ] `frameInterleavedF32` keeps a byte carry so arbitrary parec chunk boundaries (non-multiple of 8 bytes) never split a frame; `data` is interleaved `f32` in `AudioData`'s `f32` format.
- [ ] Tests: odd splits reassemble byte-exactly; per-channel RMS of a synthetic stereo tone equals expected in **both** channels (`0.707 × amplitude`); silence measures ≈ 0; Goertzel finds 880 Hz and ignores 440 Hz; WAV header round-trips.
- [ ] Verify: `bunx vitest run test/pcm.test.ts`.

### Task 6: Preload bridge + main-world patch

**Files:** `src/preload/index.ts`, `src/patch/index.ts`, tests.

- [ ] Preload: `contextBridge.exposeInMainWorld('sharkordDesktop', { createSystemAudioTrack(), release(trackId), url })`; acquires capture lazily on first call (`capture:acquire`), refcounts, polls created tracks for `readyState === 'ended'` (500 ms) to `capture:release`; injects `dist/patch.js` with `webFrame.executeJavaScript` (main world) at preload time.
- [ ] Patch (main world): wraps `navigator.mediaDevices.getDisplayMedia`; calls the original with `{ video: constraints.video }`; when `constraints.audio` is truthy, requests the injected track from the bridge and returns `new MediaStream([...videoTracks, injectedTrack])`; forwards video `ended` → `injectedTrack.stop()`; on bridge failure returns the video-only stream and reports through `console.warn`.
- [ ] Tests (fake `navigator`, fake bridge, fake `MediaStream`): `audio:false` returns the original stream object untouched; `audio:true` yields 1 video + 1 injected audio track; bridge throw → video-only; video `ended` stops the injected track.
- [ ] Verify: `bunx vitest run test/patch.test.ts`.

### Task 7: `src/main/index.ts`

- [ ] CLI: `--selftest`, `--cleanup`, `--url=<url>`; config from `SHARKORD_URL`, `SHARKORD_SINK_NAME`, `SHARKORD_HW_SINK`, `SHARKORD_DEBUG_PCM`.
- [ ] Single-instance lock; `process.env.PULSE_SINK = hwSink` before routing/window; `RoutingManager.start()`; `Capture` started on demand from IPC.
- [ ] Window: `contextIsolation: true`, `sandbox: true`, `preload`, `autoplayPolicy: 'no-user-gesture-required'`.
- [ ] Permissions: `setPermissionRequestHandler` allows `media` + `display-capture` for the configured origin, denies everything else; `setPermissionCheckHandler` mirrors it.
- [ ] Display media: first try the default behaviour (portal picker on Wayland). If `getDisplayMedia` rejects, fall back to an in-app picker window fed by `desktopCapturer.getSources({ types: ['screen','window'] })` and `setDisplayMediaRequestHandler` returning `{ video: source }`. Record which path worked in the README.
- [ ] Lifecycle: `before-quit` + `SIGINT`/`SIGTERM` → synchronous `routing.stop()` (execFileSync path) ; `window.on('closed')` behaves the same.
- [ ] IPC: `capture:acquire` → `capture.start()`, `capture:release` → `capture.stop()`, `pcm` fan-out to the renderer.
- [ ] Verify: `bun run start` → app window shows Sharkord; `pactl get-default-sink` returns `sharkord_capture`; `pactl list sink-inputs` shows the app's own stream on the Focusrite; quitting restores the original default and removes the modules.

### Task 8: Selftest + docs

**Files:** `src/main/selftest.ts`, `README.md`, `sharkord-desktop.desktop`, `bin/sharkord-desktop`.

- [ ] Selftest driver: assert routing state; start capture; play tone A in the app window (`executeJavaScript`, WebAudio oscillator at 440 Hz), tone B from an external `paplay --device=sharkord_capture` process (or a second `pw-play`) at 880 Hz; record injected PCM for ~3 s; `measureBand` both frequencies; print `tone_inside_app`, `tone_external`, ratio, `PASS/FAIL`; exit code 0/1. Cleanup sink modules on exit.
- [ ] Verify: `bun run selftest` → `PASS` with `ratio < 0.01`.
- [ ] README: what it does, the audio graph, `bun run start|test|selftest`, `--cleanup`, known limits (apps bypassing PipeWire, other Sharkord clients in use while streaming).
- [ ] `.desktop` entry + `bin/sharkord-desktop` launcher (`electron .` from the repo path).

## Self-review

- Spec coverage: routing graph (T3), capture+injection (T4–T6), lifecycle/teardown/stale state (T7), verification incl. the tone-exclusion regression test (T8), out-of-scope items explicitly dropped.
- Type consistency: `Runner`/`Spawner` seams defined in T2/T4 and used by T3/T7; `frameInterleavedF32` used by both patch and selftest; `measureBand` defined in T5, used in T8.
