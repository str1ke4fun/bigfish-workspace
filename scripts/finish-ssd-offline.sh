#!/bin/bash
set -euo pipefail
ROOT=/mnt/fish-pi
BASE=/mnt/d/fish-handoff
mountpoint -q "$ROOT"
test "$(findmnt -n -o SOURCE --target "$ROOT" | head -1)" = /dev/sde2
test "$(blockdev --getsize64 /dev/sde)" = 256060514304
mkdir -p "$BASE/offline/apt-stonking-arm64"
cp "$ROOT"/var/cache/apt/archives/*.deb "$BASE/offline/apt-stonking-arm64/"
cd "$BASE/offline/apt-stonking-arm64"
sha256sum *.deb > SHA256SUMS.txt
# --no-download guarantees that installation uses only previously cached packages.
chroot "$ROOT" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install --no-download -y --no-install-recommends ca-certificates xz-utils curl git ffmpeg tesseract-ocr tesseract-ocr-chi-sim xvfb xauth xdotool x11-utils imagemagick dbus-x11 fonts-noto-cjk
if ! chroot "$ROOT" id str1k3 >/dev/null 2>&1; then
  chroot "$ROOT" useradd --create-home --uid 1000 --shell /bin/bash --groups sudo str1k3
fi
chroot "$ROOT" /usr/bin/env FISH_OFFLINE=1 true
FISH_OFFLINE=1 FISH_MANUAL_PROFILE=1 bash "$BASE/scripts/install-into-rootfs.sh" "$ROOT"
tar -xzf "$BASE/offline/plugins/speech-2026-10-30.tar.gz" -C "$ROOT/home/str1k3/dsh-plugins"
mkdir -p "$ROOT/home/str1k3/.dsh/profiles/web/node_modules/@deepseek-ai"
PROFILE="$ROOT/home/str1k3/.dsh/profiles/web"
cat > "$PROFILE/package.json" <<'JSON'
{"name":"dsh-profile-web","private":true,"dependencies":{"dsh-fish":"link:/home/str1k3/dsh-plugins/dsh-fish-0.6.0","dsh-wx":"link:/home/str1k3/dsh-plugins/dsh-wx","dsh-onebot-qq":"link:/opt/dsh-offline-arm64/node_modules/dsh-onebot-qq"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-fish","dsh-wx","dsh-onebot-qq"]}}}
JSON
for package in dsh-fish dsh-wx; do
  target="$package"
  [ "$package" != dsh-fish ] || target=dsh-fish-0.6.0
  ln -sfn "/home/str1k3/dsh-plugins/$target" "$PROFILE/node_modules/$package"
done
ln -sfn /opt/dsh-offline-arm64/node_modules/dsh-onebot-qq "$PROFILE/node_modules/dsh-onebot-qq"
for package in "$ROOT"/opt/dsh-offline-arm64/node_modules/@deepseek-ai/*; do
  ln -sfn "/opt/dsh-offline-arm64/node_modules/@deepseek-ai/$(basename "$package")" "$PROFILE/node_modules/@deepseek-ai/$(basename "$package")"
done
chroot "$ROOT" chown -R str1k3:str1k3 /home/str1k3
chroot "$ROOT" /usr/local/bin/node -v
chroot "$ROOT" /usr/local/bin/pnpm -v
chroot "$ROOT" /usr/local/bin/dsh --version
chroot "$ROOT" systemctl is-enabled dsh-web
sync
