#!/bin/bash
set -euo pipefail
ROOT=/mnt/fish-pi
BASE=/mnt/d/fish-handoff
ip link set lo up
for d in dev proc sys; do mountpoint -q "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d"; done
chroot "$ROOT" /bin/su - str1k3 -c 'dsh web --no-open --port 18713' > "$BASE/logs/ssd-web-smoke.log" 2>&1 &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for attempt in $(seq 1 90); do
  if python3 "$BASE/scripts/check-smoke.py"; then exit 0; fi
  kill -0 "$PID" 2>/dev/null || { echo 'DSH exited; inspect log'; exit 1; }
  sleep 1
done
echo 'DSH startup timeout'
exit 1
