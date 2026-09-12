#!/usr/bin/env bash
# Installs the app for the current user from the latest GitHub release, without root.
# The AppImage lands in ~/.local/opt and keeps itself up to date; a launcher, icon and desktop
# entry are installed too. FUSE is used when present, otherwise the runtime extracts itself.
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
opt="$HOME/.local/opt/sharkord-desktop"
bin="$HOME/.local/bin/sharkord-desktop"

cd "$repo"
mkdir -p "$opt" "$(dirname "$bin")" "$data/applications" "$data/icons/hicolor/512x512/apps"

if [ -n "${SHARKORD_LOCAL_BUILD:-}" ]; then
  echo "building locally…"
  node build.mjs >/dev/null
  npx electron-builder --linux dir --publish never >/dev/null
  rm -rf "$opt/app"
  cp -a release/linux-unpacked "$opt/app"
  target="$opt/app/sharkord-desktop"
  exec_line="exec \"$target\" \"\$@\""
else
  echo "fetching the latest release…"
  image="$opt/Sharkord.AppImage"
  url="$(curl -fsSL https://api.github.com/repos/RND332/sharkord-desktop/releases/latest \
    | grep -o 'https://[^"]*linux-x86_64.AppImage' | head -1)"
  [ -n "$url" ] || { echo "could not find a Linux AppImage in the latest release" >&2; exit 1; }
  curl -fL "$url" -o "$image.tmp"
  chmod +x "$image.tmp"
  mv "$image.tmp" "$image"
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    echo "note: without fuse2 (e.g. sudo pacman -S fuse2) the launcher extracts the image on each start"
  fi
  # decide at launch time, so installing fuse2 later needs no reinstall
  exec_line="if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec \"$image\" \"\$@\"
fi
exec \"$image\" --appimage-extract-and-run \"\$@\""
  rm -rf "$opt/app"
fi

cat > "$bin" <<EOF
#!/usr/bin/env bash
$exec_line
EOF
chmod +x "$bin"
install -m 644 "$repo/build/icon.png" "$data/icons/hicolor/512x512/apps/sharkord-desktop.png"

cat > "$data/applications/sharkord-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Sharkord
Comment=Sharkord client whose screen share carries all PC audio except Sharkord
Exec=$bin
Icon=sharkord-desktop
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=sharkord-desktop
EOF

if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$data/applications" || true
fi
if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f -t "$data/icons/hicolor" >/dev/null || true
fi

echo "installed: $bin"
echo "launcher:  $data/applications/sharkord-desktop.desktop"
