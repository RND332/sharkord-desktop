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
# Extract-and-run shares a content-hashed directory and deletes it on every exit.
# A second-instance handoff must not delete the running client's camera helpers.
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/sharkord-runtime.XXXXXXXX") || exit 1
trap 'rm -rf -- "$runtime_dir"' EXIT
TMPDIR="$runtime_dir" "$image" --appimage-extract-and-run "$@"
