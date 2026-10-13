#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_root="${TMPDIR:-${HOME}/.hermes/cache/scratch}"
mkdir -p "$tmp_root"
test_dir="$(mktemp -d "$tmp_root/portal-metadata-private-bus.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

read -r -a systemd_cflags <<< "$(pkg-config --cflags libsystemd)"
read -r -a systemd_libs <<< "$(pkg-config --libs libsystemd)"
cc -std=c11 -Wall -Wextra -Werror -O2 -DPORTAL_TEST_COUNTERS \
  "${systemd_cflags[@]}" \
  "$repo_root/native/linux/portal-metadata.c" \
  -o "$test_dir/portal-metadata" "${systemd_libs[@]}"
cc -std=c11 -Wall -Wextra -Werror -O2 \
  "${systemd_cflags[@]}" \
  "$repo_root/test/portal-metadata-private-bus.c" \
  -o "$test_dir/private-bus-test" "${systemd_libs[@]}"
for scenario in happy malformed duplicate owner-change no-pid cancel; do
  dbus-run-session -- "$test_dir/private-bus-test" "$test_dir/portal-metadata" "$scenario"
done
