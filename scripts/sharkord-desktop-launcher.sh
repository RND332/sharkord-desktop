#!/usr/bin/env bash
# Launcher template: the install script substitutes the image and install paths below.
# Recovers from a self-update that was interrupted between removing and replacing the image,
# and falls back to the unpacked copy when there is no image at all.
image="@IMAGE@"
fallback="@OPT@/app/sharkord-desktop"

# An update that was interrupted between removing and replacing the image leaves only the backup.
if [ ! -x "$image" ] && [ -x "$image.bak" ]; then mv "$image.bak" "$image"; fi

if [ ! -x "$image" ]; then
  if [ -x "$fallback" ]; then exec "$fallback" "$@"; fi
  echo 'sharkord-desktop: no binary found — re-run scripts/install-local.sh' >&2
  exit 1
fi

if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec "$image" "$@"
fi
exec "$image" --appimage-extract-and-run "$@"
