#!/bin/bash
set -euo pipefail
ROOT=/mnt/fish-pi
BASE=/mnt/d/fish-handoff
for d in dev proc sys; do mountpoint -q "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d"; done
echo '=== packages ==='
chroot "$ROOT" dpkg --audit
chroot "$ROOT" dpkg-query -W nodejs wechat linuxqq openssh-server ffmpeg tesseract-ocr-chi-sim xvfb 2>/dev/null || true
echo '=== runtime ==='
chroot "$ROOT" /usr/local/bin/node -v
chroot "$ROOT" /usr/local/bin/pnpm -v
chroot "$ROOT" /usr/local/bin/dsh --version
chroot "$ROOT" /usr/local/bin/node -e 'const base="/opt/dsh-offline-arm64/node_modules/"; for(const name of ["node-pty","sharp","koffi"]) {require(base+name); console.log(name+": loaded");}'
echo '=== services enabled ==='
for unit in dsh-web xvfb-fish wechat-fish napcat-fish ssh.socket; do
  systemctl --root="$ROOT" is-enabled "$unit"
done
echo '=== executable dependencies ==='
chroot "$ROOT" ldd /opt/wechat/wechat > "$BASE/logs/ssd-wechat-ldd.txt"
chroot "$ROOT" ldd /opt/QQ/qq > "$BASE/logs/ssd-qq-ldd.txt"
if grep 'not found' "$BASE/logs/ssd-wechat-ldd.txt" "$BASE/logs/ssd-qq-ldd.txt"; then exit 1; fi
echo 'WeChat and QQ shared libraries: all found'
mkdir -p "$ROOT/run/sshd"
chroot "$ROOT" /usr/sbin/sshd -t
echo 'SSH configuration: valid'
python3 "$BASE/scripts/verify-ssd-data.py"
