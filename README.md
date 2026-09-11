# Sharkord Desktop

[![build](https://github.com/RND332/sharkord-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/RND332/sharkord-desktop/actions/workflows/build.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Electron client for a self-hosted [Sharkord](https://github.com/Sharkord/sharkord) instance whose
screen shares carry **the whole PC's audio except Sharkord itself** — viewers hear your games, browser
and music, never their own voices.

> [!NOTE]
> Entirely vibecoded: this codebase was written end-to-end by an AI coding agent (opencode-go /
> deepseek-v4.1-flash) from a one-paragraph request, including the design spec, the implementation
> plan, the tests, and the CI. No human wrote or reviewed the code before it shipped.

## Platform support

| Platform | Status |
|---|---|
| **Linux + PipeWire** | Full feature — this is what the project is about, verified on Arch/Hyprland/Wayland with Electron 44 |
| Windows | Client wrapper only: no routing, `getDisplayMedia` is left to Chromium, so screen audio follows the platform (and includes whatever you hear, unless Sharkord's own `restrictOwnAudio` setting handles it). Untested here. |
| macOS | Same as Windows: wrapper only, untested. Screen audio needs the platform's own permission/support. |

Builds for all three platforms are produced by CI; only the Linux build can do the audio exclusion.

## Install

Download from [Releases](https://github.com/RND332/sharkord-desktop/releases): AppImage/deb,
Windows installer/portable, macOS dmg/zip. macOS and Windows builds are unsigned, so expect a
Gatekeeper/SmartScreen warning.

On first start the app asks which server to open and remembers the answer in
`<userData>/config.json`; change it later with **Ctrl/Cmd+Shift+S** or by setting `SHARKORD_URL`
(passing `--url=` also works and wins over the stored value). Anything without a scheme is assumed to
be `https://`, and the address is validated before it is used.

## How it works

The client's playback is the noise everyone else hears back, so it is kept out of the captured signal
by construction:

```text
games / browser / YouTube ──►  [sharkord_capture]  (null sink, DEFAULT)  ──monitor──► parec ──► injected
                                          │                                                       audio track
                                          └─monitor──► loopback ──► [real output device] ──► you hear it
                                                                                                    │
this app  ──(PULSE_SINK=<real output>)───────────────────────────► [real output device] ──► you hear  │
                                                                   the voice channel            ▼
                                                                   (never captured)   Sharkord SCREEN_AUDIO
```

1. On start the app creates a null sink, makes it the PipeWire default (so every other application
   lands there) and loops it back to your real output device — you keep hearing everything.
2. The app's own audio is pinned to the real output device with `PULSE_SINK`, so the voice channel is
   audible to you and absent from the capture.
3. When the Sharkord client asks for a screen share, the injected patch calls the normal picker for
   video and attaches an audio track built from `parec sharkord_capture.monitor` via
   `MediaStreamTrackGenerator`. The client publishes it as its usual `SCREEN_AUDIO` producer.

Everything reverses on exit: the default sink is restored, the modules are unloaded, and streams that
were on the capture sink are relocated by WirePlumber.

## Usage

```bash
bun install
bun run start          # build + launch
bun run test           # unit tests
bun run selftest       # proves the app's own audio is excluded from the capture
bun run dist:linux     # packaged builds (dist:win, dist:mac on those hosts)
bun run build && electron . --cleanup   # remove leftovers after a crash
```

`bin/sharkord-desktop` is a launcher for a desktop entry; `sharkord-desktop.desktop` can be copied to
`~/.local/share/applications/` (edit the `Exec` path).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARKORD_URL` | — (asks on first run) | web client to load (`--url=` also works; both beat the stored server) |
| `SHARKORD_SINK_NAME` | `sharkord_capture` | name of the virtual capture sink |
| `SHARKORD_HW_SINK` | current default sink | output device that keeps playing locally |
| `SHARKORD_DEBUG_PCM` | — | dump the captured PCM to this WAV path while streaming |

## Verification

`bun run selftest` plays a 997 Hz tone *inside the app window* and a 1493 Hz tone from an unrelated
process into the capture sink, then measures three signals (last run, 2026-09-12):

| signal | pc tone (must be captured) | app tone (must not leak) |
|---|---|---|
| capture sink monitor | `0.350` | `0.001` |
| injected track read back in the renderer | `0.350` | `0.001` |
| hardware monitor (control) | — | `0.350` |

The third row proves the tone really played; the middle row proves the track handed to the client
carries it. Both tone levels are exactly the amplitude that was played (0.35).

`bun run test` covers the pactl parsers against captured fixtures, the routing manager against a fake
`pactl` (setup order, idempotent restart, stale cleanup while another instance is live, loopback
repair, device loss, own-stream protection), the `parec` supervisor's restart policy, the PCM framing
(byte-exact carry, per-channel RMS, Goertzel selectivity), patch behaviour (passthrough, merge,
fallback, backpressure, release), and the server configuration (URL normalisation, hostile configs,
storage round-trip).

Electron on Linux has no default screen picker — `getDisplayMedia` rejects with `NotSupportedError`
unless the app installs `setDisplayMediaRequestHandler`. This app installs one that calls
`desktopCapturer.getSources()`, which is what raises the desktop's own dialog (Hyprland's
`hyprland-preview-share-picker`) and returns the source the user selected there. Electron's own
`useSystemPicker` option is macOS-only and is not used.

## Known limits

- The audio exclusion is Linux/PipeWire only; the whole point is routing that Windows/macOS do
  differently.
- Applications that bypass the PipeWire graph (raw ALSA exclusive mode) are not captured.
- Any *other* Sharkord client on the machine (a browser tab) plays through the virtual sink and would
  therefore be part of the stream — use this app as your client while streaming.
- Audio you deliberately route to a second device stays there; the stream carries the default sink.

## Layout

| Path | Role |
|---|---|
| `src/main/server-config.ts` | server URL validation + storage |
| `src/connect/connect.html` | first-run / change-server picker |
| `src/main/pipewire.ts` | `pactl` wrapper + parsers |
| `src/main/routing.ts` | virtual sink / loopback / default-sink lifecycle |
| `src/main/capture.ts` | supervised `parec` |
| `src/main/selftest.ts` | tone-exclusion proof |
| `src/preload/index.ts` | capture bridge |
| `src/patch/` | main-world `getDisplayMedia` patch |
| `docs/superpowers/` | design spec + implementation plan |
