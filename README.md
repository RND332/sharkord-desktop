# Sharkord Desktop

Electron client for a self-hosted [Sharkord](https://github.com/Sharkord/sharkord) instance that makes
screen shares carry **the whole PC's audio except Sharkord itself** — viewers hear your games, browser
and music, never their own voices.

Tested on Arch/Hyprland/Wayland with PipeWire 1.6 and Electron 44; the server side is stock upstream
Sharkord (v0.0.25 at the time of writing), no patches, no fork.

## How it works

The client's playback is the noise everyone else hears back. So it is kept out of the captured signal
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
bun run build && electron . --cleanup   # remove leftovers after a crash
```

`bin/sharkord-desktop` is a launcher for a desktop entry; `sharkord-desktop.desktop` can be copied to
`~/.local/share/applications/`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARKORD_URL` | `https://sharkord.example.com` | web client to load (`--url=` also works) |
| `SHARKORD_SINK_NAME` | `sharkord_capture` | name of the virtual capture sink |
| `SHARKORD_HW_SINK` | current default sink | output device that keeps playing locally |
| `SHARKORD_DEBUG_PCM` | — | dump the captured PCM to this WAV path while streaming |

## Verification

`bun run selftest` measures three signals while a 997 Hz tone plays *inside the app* and a 1493 Hz tone
plays from an unrelated process into the capture sink:

- capture PCM: pc tone present, app tone absent;
- hardware monitor: app tone present (proves the tone really played);
- injected track (read back through `MediaStreamTrackProcessor` in the renderer): pc tone present, app
  tone absent.

## Known limits

- Linux/PipeWire only; the whole point is routing that Windows/macOS do differently.
- Applications that bypass the PipeWire graph (raw ALSA exclusive mode) are not captured.
- Any *other* Sharkord client on the machine (a browser tab) plays through the virtual sink and would
  therefore be part of the stream — use this app as your client while streaming.
- Audio you deliberately route to a second device stays there; the stream carries the default sink.

## Layout

| Path | Role |
|---|---|
| `src/main/pipewire.ts` | `pactl` wrapper + parsers |
| `src/main/routing.ts` | virtual sink / loopback / default-sink lifecycle |
| `src/main/capture.ts` | supervised `parec` |
| `src/main/selftest.ts` | tone-exclusion proof |
| `src/preload/index.ts` | capture bridge |
| `src/patch/` | main-world `getDisplayMedia` patch |
| `docs/superpowers/` | design spec + implementation plan |
