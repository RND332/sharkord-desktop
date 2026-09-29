# Windows: local cursor disappears while sharing

## Experimental workaround

Install Sharkord Desktop 0.6.9 or later, then **quit it from its tray menu**
(closing the window is not enough). Start the Windows app with:

```powershell
& 'C:\path\to\Sharkord Desktop.exe' --software-rendering
```

Replace the example path with your installed or portable executable. Alternatively,
append ` --software-rendering` after the quoted executable path in a Windows
shortcut's Target. This option was introduced in 0.6.9; it is not present in
version 0.6.8's published binaries.

The option disables Electron hardware acceleration before startup, on Windows
only. It may help with GPU/driver-related local cursor rendering failures, but
can increase CPU use and reduce video/rendering performance. It does **not**
disable Windows Graphics Capture (WGC), change the capture source, change audio
isolation, or alter Windows pointer settings. No registry changes are made.

The session's `main.log` contains `software rendering requested: hardware
acceleration disabled` when the option takes effect. To undo it, fully quit and
restart without the option. Launching a second instance with the option does not
reconfigure an already-running instance.

## Evidence and limits

- [OBS issue 12192](https://github.com/obsproject/obs-studio/issues/12192): an OBS
  maintainer explains that WGC forces a software cursor and can break local custom
  cursors. This is a plausible cause, not a reproduction of this user's machine.
- [Zoom's Windows 11 report and support response](https://community.zoom.com/meetings-2/mouse-cursor-disappears-while-sharing-screen-79805):
  the sharer's cursor disappears locally while viewers still see it. Support
  suggests testing hardware acceleration; subsequent reports say the listed
  workarounds do not always resolve it.
- [Electron's supported API](https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration)
  requires `disableHardwareAcceleration()` before `ready`.
- [Electron 44.3.0's DEPS](https://github.com/electron/electron/blob/v44.3.0/DEPS)
  pins Chromium 152.0.7977.78. Its
  [desktop capture implementation](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/media/capture/desktop_capture_device.cc)
  enables WGC for windows and for screens on Windows 11 24H2+. The old WGC
  enable/disable feature flags are not a viable way to select a legacy capturer
  in this path. Software rendering is **not** a workaround for all WGC bugs.

## Windows verification still required

Compare a normal launch against a fresh `--software-rendering` launch on the
same machine. Share both a display and a window, move the pointer across desktop
and application surfaces, type, switch applications, then stop and restart the
share. Check local visibility, the remote viewer's cursor, video smoothness,
CPU use, and audio. Record the Windows build, GPU/driver, and cursor scheme if it
still fails. The automated tests cover startup opt-in/platform gating, not actual
Windows pointer visibility.
