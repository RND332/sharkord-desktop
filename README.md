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

Nothing about your audio setup is touched: no sink is created, no default device changes, no stream is
moved. The app opens a plain PipeWire **recording node** and links every *other* application's playback
into it:

```text
game ─┐
music ├─► (their own devices, unchanged) ──► you hear everything as before
browser┘         │
                 └────────► [sharkord_capture]  (a pw-record node, not a device)
                                      │
                                      ▼
                          injected audio track ──► Sharkord SCREEN_AUDIO producer

this app's own playback is never linked ──► viewers never hear themselves
```

1. When a screen share starts, the app runs `pw-record` with `node.autoconnect=false` — no device
   appears anywhere, only a recording stream while you share.
2. Every other application's output ports are linked into that node (`pw-link`), mono fanned out to
   both sides; links are re-checked once a second so apps that start later are picked up.
3. The client's own playback is excluded by process tree, so the voice channel is audible to you and
   absent from the capture.
4. The captured PCM is injected as a real audio track into a main-world patch of `getDisplayMedia`,
   and the stock Sharkord client publishes it as its usual `SCREEN_AUDIO` producer.

Closing the window keeps the app in the tray (capture and voice stay connected); quit from the tray
menu or with Ctrl/Cmd+Q.

## Usage

```bash
bun install
bun run start          # build + launch
bun run test           # unit tests
bun run selftest       # proves the app's own audio is excluded from the capture
bun run dist:linux     # packaged builds (dist:win, dist:mac on those hosts)
bun run build && electron . --cleanup   # remove the virtual sink an older version left behind
```

`scripts/install-local.sh` installs the packaged app for the current user without root: binary in
`~/.local/opt`, `sharkord-desktop` on `PATH`, plus icon and desktop entry. Re-run it after an update.
Arch users can also `sudo pacman -U` the `.pacman` from Releases.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARKORD_URL` | — (asks on first run) | web client to load (`--url=` also works; both beat the stored server) |
| `SHARKORD_TAP_NAME` | `sharkord_capture` | name of the recording node other apps are linked into |
| `SHARKORD_DEBUG_PCM` | — | dump the recorded PCM to this WAV path while streaming |

## Verification

`bun run selftest` plays a 997 Hz tone *inside the app window* and a 1493 Hz tone from an unrelated
process (launched with `setsid`, so it looks like any other application), then measures three signals
(last run, 2026-09-12):

| signal | another app's tone (must be captured) | the client's own tone (must not leak) |
|---|---|---|
| the tap (`pw-record` node with linked streams) | `0.350` | `0.000` |
| injected track read back in the renderer | `0.350` | `0.001` |
| hardware monitor (control) | — | `0.350` |

The third row proves the tone really played; the middle row proves the track handed to the client
carries it. Both tone levels are exactly the amplitude that was played (0.35), and the same run
asserts that the default sink, the module list and the sink list are untouched.

`bun run test` covers the PipeWire graph parsing (node ids, port directions, `pw-dump` shapes), the
link planner (mono fan-out, own-process exclusion, idempotency, links forgotten when a stream
disappears), the PCM framing (byte-exact carry, per-channel RMS, Goertzel selectivity), patch
behaviour (passthrough, merge, fallback, backpressure, release), the server configuration (URL
normalisation, hostile configs, storage round-trip) and the platform mode.

Electron has no screen picker of its own — `getDisplayMedia` rejects with `NotSupportedError` unless
the app installs `setDisplayMediaRequestHandler`, and that handler must name the source. So the app
asks the user:

- **Wayland** — `desktopCapturer.getSources()` raises the desktop's own dialog (Hyprland's
  `hyprland-preview-share-picker`, the portal on other compositors) and the source the user picked
  there is used. Electron's `useSystemPicker` option is macOS-only and unused.
- **Windows, macOS, X11** — those have no such dialog, so the app shows its own picker window:
  thumbnails of every screen and window, Screens/Windows/All tabs, first entry pre-selected,
  Enter shares, Esc cancels. Until 0.4.0 this case silently took the first source, which on Windows
  was usually the Sharkord window itself — that is fixed by the picker.

`SHARKORD_PICKER=inapp|system` forces either picker (useful when a compositor's portal misbehaves).

## Known limits

- The audio exclusion is Linux/PipeWire only. Windows and macOS get video through the picker and no
  injected audio: Electron can loop the whole system output back on Windows, but that would also send
  the voice channel you hear to the viewers, which is the thing this app exists to avoid.
- Applications that bypass the PipeWire graph (raw ALSA exclusive mode) are not captured.
- Per-application volume and mute are honoured (the tap is taken after them); a sink's own volume or
  mute is not, because the tap never passes through the device.
- Any *other* Sharkord client on the machine (a browser tab) is a separate application, so it *is*
  captured — use this app as your client while streaming.

## Layout

| Path | Role |
|---|---|
| `src/main/server-config.ts` | server URL validation + storage |
| `src/connect/connect.html` | first-run / change-server picker |
| `src/main/tap.ts` | recording node + per-application link management |
| `src/main/legacy.ts` | cleans up the virtual sink older versions created |
| `src/main/selftest.ts` | tone-exclusion proof |
| `src/preload/index.ts` | capture bridge |
| `src/patch/` | main-world `getDisplayMedia` patch |
| `docs/superpowers/` | design spec + implementation plan |
