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
| **Windows** | Native process-loopback capture: screen shares exclude Sharkord's process tree; window shares include only the selected application's process tree. Availability is determined by native activation, not a Windows-version gate. Windows audio measurements are still required; a successful build alone does not prove isolation. |
| macOS | Wrapper only, untested. No own capture: the share carries whatever the platform gives `getDisplayMedia`, after the same proof. |

- **Linux + AppImage**: camera can disappear (`NotFoundError: Requested device not found`) after a
  second-instance handoff; fixed by the launcher extracting each launch into its own directory.
  Install with `scripts/install-local.sh` to refresh the launcher — an AppImage update alone does
  not replace it.
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

On Windows the PCM comes from `native/windows/win-audio-capture.exe`. A screen selects WASAPI
process-loopback **exclude** mode for Sharkord's process tree; a window selects **include** mode for
the process owning the chosen HWND. Process loopback spans playback endpoints, rather than capturing
only the default device. A `READY` acknowledgement confirms startup even when the selected app is
silent. Missing or failed native capture leaves the share video-only: Windows never falls back to
Chromium's whole-system loopback or uses a short tone probe as a substitute for isolation.

Closing the window keeps the app in the tray (capture and voice stay connected) and says so once.
Quit from the **Quit Sharkord** tray item, the Server menu, or with Ctrl/Cmd+Q — all three paths are
verified in CI-less local tests via `SHARKORD_DEBUG_QUIT_AFTER` / `SHARKORD_DEBUG_APP_QUIT_AFTER`. A downloaded update is swapped in on
the way out **without** relaunching the app, so quitting really quits — set
`SHARKORD_UPDATE_NO_PROMPT=1` to skip the restart prompt entirely.

HTTP(S) links the client opens in a new window, and clicked cross-origin links, are opened in the
default system browser instead of Electron child windows. Same-origin in-app navigation is preserved,
and non-web schemes (`file:`, `javascript:` and the like) are never handed to the OS.

## Usage

```bash
bun install
bun run start          # build + launch
bun run test           # unit tests
bun run selftest       # Linux: real display-media patch, PCM injection and tone-exclusion check
bun run dist:linux     # packaged builds (dist:win, dist:mac on those hosts)
bun run build && electron . --cleanup   # remove the virtual sink an older version left behind
```

On Windows, install the Visual Studio C++ build tools and Windows SDK:

```powershell
bun run build:windows-audio
bun run test:windows-audio
bun run dist:win
```

`dist:win` builds the helper before packaging and fails if compilation fails, rather than silently
producing a Windows client without native audio capture.

`scripts/install-local.sh` installs the app for the current user without root: it takes the Linux
AppImage from the latest GitHub release into `~/.local/opt`, puts `sharkord-desktop` on `PATH` and
adds icon + desktop entry. `SHARKORD_LOCAL_BUILD=1` builds from the checkout instead of downloading.
Arch users can also `sudo pacman -U` the `.pacman` from Releases.

### Updates

The app checks the [release page](https://github.com/RND332/sharkord-desktop/releases) shortly after
startup and every time you pick **Server → Check for updates…**:

- **Linux cameras can die when a second instance hands off**: the AppImage runtime extracts into one
  content-hashed directory shared by every launch and deletes it when that launch exits, so a
  second-instance handoff deleted the helpers a running client was using (e.g. the webcam). The
  launcher now extracts each launch into its own directory and cleans it up on exit. Existing
  installs must refresh the launcher (`scripts/install-local.sh`) — an AppImage update alone
  does not replace the launcher.

- **Windows installer (NSIS)** and **Linux AppImage** replace themselves in place; a downloaded update
  asks for a restart and is also applied on the next quit.
- **deb / pacman** installs are updated by their package manager — the app says so instead of failing.
- `SHARKORD_UPDATE_FEED=https://…` points the updater at another host (a mirror, or a local test feed).
- Development checkouts never update themselves (`app.isPackaged` gate).

### Secure connection defaults

The app enables application-wide strict DNS-over-HTTPS using
`https://1.1.1.1/dns-query`, with no plaintext DNS fallback. HTTPS DNS records let
Chromium negotiate Encrypted Client Hello (ECH) when the server publishes an ECH
configuration. ECH is not mandatory for arbitrary servers; an ECH-only server
enforces that requirement itself.

The client session connects directly instead of inheriting a system HTTP/SOCKS
proxy, so Chromium can resolve the server's HTTPS records locally. OS proxy
settings and VPN routing are not changed. The updater shares the app's DNS policy,
but its separate session is not forced into direct mode. Networks must allow the
DoH endpoint and direct access to the selected server; the client never falls back
to system DNS or an inherited proxy.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARKORD_URL` | — (asks on first run) | web client to load (`--url=` also works; both beat the stored server) |
| `SHARKORD_TAP_NAME` | `sharkord_capture` | name of the recording node other apps are linked into |
| `SHARKORD_WINDOWS_AUDIO` | — | Legacy `on` override for inconclusive browser-audio probes on non-Windows platforms. Ignored on Windows: native isolation cannot be bypassed. |
| `SHARKORD_DEBUG_PCM` | — | dump the recorded PCM to this WAV path while streaming |
| `SHARKORD_DEBUG_QUIT_AFTER` | — | seconds after startup, run the tray's quit path (regression test) |
| `SHARKORD_DEBUG_APP_QUIT_AFTER` | — | seconds after startup, call `app.quit()` like Ctrl+Q does |

## Verification

`bun run selftest` on Linux plays a 997 Hz tone *inside the app window* and a 1493 Hz tone from an
unrelated process, then measures the tap, the real patched `getDisplayMedia` audio track and a
hardware-monitor positive control (last run, 2026-09-13):

| signal | another app's tone (must be captured) | the client's own tone (must not leak) |
|---|---|---|
| the tap (`pw-record` node with linked streams) | `0.350` | `0.000` |
| injected track read back in the renderer | `0.350` | `0.000` |
| hardware monitor (control) | — | `0.350` |

The control proves the app tone really played. The middle row exercises the production display-media
patch over a local canvas video source, rather than a duplicate PCM writer. This is a Linux/renderer
regression check, **not Windows WASAPI or a remote viewer verification**.

`bun run test` covers the PipeWire graph parsing (node ids, port directions, `pw-dump` shapes), the
link planner (mono fan-out, own-process exclusion, idempotency, links forgotten when a stream
disappears), the PCM framing (byte-exact carry, per-channel RMS, Goertzel selectivity), patch
behaviour (passthrough, merge, fallback, backpressure, release), the server configuration (URL
normalisation, hostile configs, storage round-trip) and the platform mode.

`bun run test:windows-audio` is the separate real-Windows proof. Three independent application
windows own child processes playing 997, 1493 and 2137 Hz tones. The script measures both PCM
channels for screen exclusion, window inclusion, silent startup followed by resumed playback, and
refused own/dead window targets. No playback device or missing desired audio is a failure, not a
passing silent capture. It changes no playback-device routing and removes its temporary fixtures.
Run it on the affected Windows machine before treating isolation as verified.

The Windows CI artifact `windows-audio-verification` contains the compiled helper and this script,
so the sound check does not require Bun or Visual Studio: extract it and run
`powershell -NoProfile -File .\scripts\windows-audio-smoke.ps1` from the extracted directory.
CI itself runs `-CheckOnly` to compile the fixture and check rejected arguments without starting
audio. That check explicitly reports **audio not tested**.

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

- **Windows 10 window share can freeze Explorer**: Chromium's window capturer is always
  Windows.Graphics.Capture. On some Windows 10 + GPU driver combinations that wedges DWM —
  Alt+Tab, the Start menu and the taskbar stop responding — until `explorer.exe` is restarted
  (or the GPU is reset with Win+Ctrl+Shift+B). Screen shares use DXGI and do not hit this path.
  The picker on Windows does not snapshot live thumbnails of every window, which uses the same
  DWM APIs as Alt+Tab. See the Windows 10 notes in a bug report if it still happens after a
  graphics-driver update and with Game Bar / Hardware-accelerated GPU scheduling off.
- **Windows availability**: Microsoft's
  [application-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
  documents build 20348+, while [OBS documents application capture on Windows 10 version 2004+](https://obsproject.com/kb/application-audio-capture-guide)
  using the same process-loopback mechanism. The helper attempts the real API instead of declaring
  Windows 10 unsupported. If activation fails, diagnostics contain the native error and no broad
  system-audio fallback is allowed.
- **Window audio means application audio**: the owning process and its descendants are captured,
  not an individual browser tab. Windows or tabs that share an application's process tree may share
  its audio. Applications rendering audio outside that tree can be silent; their capture is never
  broadened to the entire desktop.
- **One Windows audio share at a time**: stop the active share before selecting a different source.
  Native stop, failed acquisition and page navigation release ownership; session identifiers reject
  delayed audio or stop events belonging to a previous share.
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
| `native/windows/win-audio-capture.cpp` | source-scoped WASAPI process loopback, include/exclude modes |
| `src/main/legacy.ts` | cleans up the virtual sink older versions created |
| `src/main/logger.ts` | console + `main.log` for bug reports |
| `src/main/updater.ts` | automatic updates from the release page |
| `src/main/picker.ts` | screen/window picker for platforms without one |
| `src/main/selftest.ts` | tone-exclusion proof |
| `scripts/windows-audio-smoke.ps1` | real Windows process-tree tone/isolation proof |
| `src/preload/index.ts` | capture bridge |
| `src/patch/` | main-world `getDisplayMedia` patch |
| `src/patch/echo-test.ts` | 16 kHz probe that decides whether a capture can hear us |
| `docs/superpowers/` | design spec + implementation plan |
