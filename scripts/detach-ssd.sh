#!/bin/bash
set -euo pipefail
ROOT=/mnt/fish-pi
BASE=/mnt/d/fish-handoff
test "$(findmnt -n -o SOURCE --target "$ROOT" | head -1)" = /dev/sde2
cp "$ROOT"/var/cache/apt/archives/*.deb "$BASE/offline/apt-stonking-arm64/"
cd "$BASE/offline/apt-stonking-arm64"
sha256sum *.deb > SHA256SUMS.txt
cd "$BASE/offline"
find . -type f ! -path ./SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt > "$BASE/logs/ssd-offline-hashes.txt"
if [ -L "$ROOT/etc/resolv.conf.before-fish" ]; then
  mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.install-dns"
  mv "$ROOT/etc/resolv.conf.before-fish" "$ROOT/etc/resolv.conf"
fi
# This policy was created for offline installation only; real boot must start services normally.
if [ -f "$ROOT/usr/sbin/policy-rc.d" ]; then
  mv "$ROOT/usr/sbin/policy-rc.d" "$ROOT/usr/sbin/policy-rc.d.fish-install-disabled"
fi
sync
for d in dev proc sys boot/firmware; do
  if mountpoint -q "$ROOT/$d"; then umount "$ROOT/$d"; fi
done
umount "$ROOT"
echo 'SSD filesystems synced and unmounted. Ready for WSL disk detach.'
