#!/usr/bin/env bash
# Installs the packaged app for the current user — no root, no AppImage/FUSE needed.
# Binary goes to ~/.local/opt, plus a launcher, an icon and a desktop entry.
# Re-run after an update to replace the installed copy.
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
opt="$HOME/.local/opt/sharkord-desktop"
bin="$HOME/.local/bin/sharkord-desktop"

cd "$repo"
echo "building…"
node build.mjs >/dev/null
npx electron-builder --linux dir --publish never >/dev/null

rm -rf "$opt"
mkdir -p "$opt" "$(dirname "$bin")" "$data/applications" "$data/icons/hicolor/512x512/apps"
cp -a release/linux-unpacked/. "$opt/"

cat > "$bin" <<EOF
#!/usr/bin/env bash
exec "$opt/sharkord-desktop" "\$@"
EOF
chmod +x "$bin"

install -m 644 build/icon.png "$data/icons/hicolor/512x512/apps/sharkord-desktop.png"

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
