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
| **Windows 11 / Server 2022 (build 20348+)** | Full feature — `native/windows/win-audio-capture.cpp` captures the default output in WASAPI exclude mode for our own process tree, bypassing Chromium's build-22000 gate. Built and shipped in the Windows package; verified by CI build + the runtime probe. |
| **Windows 10 (≤19045)** | Video, plus system audio only when the app can *prove* the capture does not contain its own playback (see Known limits). The supported way to get audio: point Sharkord at a second output device and share the other one. |
| macOS | Wrapper only, untested. No own capture: the share carries whatever the platform gives `getDisplayMedia`, after the same proof. |

Builds for all three platforms are produced by CI.

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

On Windows the same patch runs, but the PCM comes from `native/windows/win-audio-capture.exe` (WASAPI
process loopback, exclude mode, our process tree) where the OS offers it; where it does not, the share
falls back to Chromium's system audio and is only kept if a 16 kHz probe proves this app's playback is
not in it. Either way the client publishes the track exactly as on Linux.

Closing the window keeps the app in the tray (capture and voice stay connected) and says so once.
Quit from the **Quit Sharkord** tray item, the Server menu, or with Ctrl/Cmd+Q — all three paths are
verified in CI-less local tests via `SHARKORD_DEBUG_QUIT_AFTER` / `SHARKORD_DEBUG_APP_QUIT_AFTER`. A downloaded update is swapped in on
the way out **without** relaunching the app, so quitting really quits — set
`SHARKORD_UPDATE_NO_PROMPT=1` to skip the restart prompt entirely.

## Usage

```bash
bun install
bun run start          # build + launch
bun run test           # unit tests
bun run selftest       # proves the app's own audio is excluded from the capture
bun run dist:linux     # packaged builds (dist:win, dist:mac on those hosts)
bun run build && electron . --cleanup   # remove the virtual sink an older version left behind
```

`scripts/install-local.sh` installs the app for the current user without root: it takes the Linux
AppImage from the latest GitHub release into `~/.local/opt`, puts `sharkord-desktop` on `PATH` and
adds icon + desktop entry. `SHARKORD_LOCAL_BUILD=1` builds from the checkout instead of downloading.
Arch users can also `sudo pacman -U` the `.pacman` from Releases.

### Updates

The app checks the [release page](https://github.com/RND332/sharkord-desktop/releases) shortly after
startup and every time you pick **Server → Check for updates…**:

- **Windows installer (NSIS)** and **Linux AppImage** replace themselves in place; a downloaded update
  asks for a restart and is also applied on the next quit.
- **deb / pacman** installs are updated by their package manager — the app says so instead of failing.
- `SHARKORD_UPDATE_FEED=https://…` points the updater at another host (a mirror, or a local test feed).
- Development checkouts never update themselves (`app.isPackaged` gate).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARKORD_URL` | — (asks on first run) | web client to load (`--url=` also works; both beat the stored server) |
| `SHARKORD_TAP_NAME` | `sharkord_capture` | name of the recording node other apps are linked into |
| `SHARKORD_WINDOWS_AUDIO` | — | `on`: share system audio even when the echo probe was inconclusive (never when it heard this app); `off`: never use the browser's system audio |
| `SHARKORD_DEBUG_PCM` | — | dump the recorded PCM to this WAV path while streaming |
| `SHARKORD_DEBUG_QUIT_AFTER` | — | seconds after startup, run the tray's quit path (regression test) |
| `SHARKORD_DEBUG_APP_QUIT_AFTER` | — | seconds after startup, call `app.quit()` like Ctrl+Q does |

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

- **Windows audio, precisely**: per Microsoft, WASAPI *process loopback in exclude mode*
  ([`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode))
  needs **Windows 10 build 20348**, and Microsoft's own
  [Application loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
  repeats that floor ("requires Windows 10 build 20348 or later"). Windows 10 *clients* stop at 19045,
  so no Windows 10 machine can capture "everything except one app" — not through Chromium, whose
  `IsRestrictOwnAudioSupported()` additionally gates it at build 22000
  (`services/audio/loopback_mixin.cc`), and not through native code either. Discord has no such
  feature: their community's answer to "filter out voice call audio when screen sharing" is *"the only
  solution would be to set up a virtual audio cable"*, and users report that sharing system audio
  "also shares the audio of discord".

  So the app does two things instead:
  1. **Windows 11 / Server 2022 (build 20348+)**: `native/windows/win-audio-capture.cpp` calls
     `ActivateAudioInterfaceAsync` with exclude mode for our own process tree, bypassing Chromium's
     version gate, and its PCM is what the share carries. Echo-free by construction, zero setup.
  2. **Anything else**: system audio is only shared if it is *proven* not to contain this app. The app
     plays a 16 kHz tone at −24 dBFS through the same device your voice plays on and listens for it in
     the capture. Heard, or not provably absent → the share stays video-only and says why. Measured on
     real hardware: idle band −115 dB, tone −24 dB, against an 8 dB threshold.
     `SHARKORD_WINDOWS_AUDIO=on` lets *unproven* audio through — never audio the probe heard.

  **The fix that makes audio work on any Windows**: give Sharkord its own output device, which the
  client already supports (`Settings → Devices → playback device` → `applyAudioOutputDevice` →
  `HTMLMediaElement.setSinkId`). Point Sharkord at your headphones and leave everything else on the
  speakers, then share the speakers: the capture carries games and music, not the voices in your
  headphones. This is the same split Discord users achieve by setting Discord's output device to their
  headphones.
- macOS gets video through the picker, no system audio.
- Another instance of this app on the same machine is a separate application: its playback is captured
  by design, which is why the self test notes it and skips the tone-based leak check while it runs.
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
| `src/main/windows-capture.ts` | runs `win-audio-capture.exe` and streams its PCM |
| `native/windows/win-audio-capture.cpp` | WASAPI process loopback in exclude mode (build 20348+) |
| `src/main/legacy.ts` | cleans up the virtual sink older versions created |
| `src/main/logger.ts` | console + `main.log` for bug reports |
| `src/main/updater.ts` | automatic updates from the release page |
| `src/main/picker.ts` | screen/window picker for platforms without one |
| `src/main/selftest.ts` | tone-exclusion proof |
| `src/preload/index.ts` | capture bridge |
| `src/patch/` | main-world `getDisplayMedia` patch |
| `src/patch/echo-test.ts` | 16 kHz probe that decides whether a capture can hear us |
| `docs/superpowers/` | design spec + implementation plan |
