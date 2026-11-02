#!/bin/bash
set -euo pipefail
ROOT=/mnt/fish-pi
BASE=/mnt/d/fish-handoff
mountpoint -q "$ROOT"
test "$(findmnt -n -o SOURCE "$ROOT")" = /dev/sde2
grep -q 'VERSION_ID="26.10"' "$ROOT/etc/os-release"
mkdir -p "$BASE/sd/preinstall" "$BASE/offline/apt-stonking-arm64"
if [ ! -f "$BASE/sd/preinstall/ssd-config-before-install.tar.gz" ]; then
  tar -czf "$BASE/sd/preinstall/ssd-config-before-install.tar.gz" -C "$ROOT" etc var/lib/dpkg/status
fi
mount -o remount,rw "$ROOT"
cp /usr/bin/qemu-aarch64-static "$ROOT/usr/bin/"
if [ -L "$ROOT/etc/resolv.conf" ]; then mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.before-fish"; fi
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
for d in dev proc sys; do mountpoint -q "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d"; done
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"
chmod 755 "$ROOT/usr/sbin/policy-rc.d"
chroot "$ROOT" /usr/bin/dpkg --print-architecture
chroot "$ROOT" apt-get update
mkdir -p "$ROOT/var/cache/apt/archives/partial"
chroot "$ROOT" apt-get install --download-only -y --no-install-recommends ca-certificates xz-utils curl git ffmpeg tesseract-ocr tesseract-ocr-chi-sim xvfb xauth xdotool x11-utils imagemagick dbus-x11 fonts-noto-cjk
cp "$ROOT"/var/cache/apt/archives/*.deb "$BASE/offline/apt-stonking-arm64/"
cd "$BASE/offline/apt-stonking-arm64"
sha256sum *.deb > SHA256SUMS.txt
