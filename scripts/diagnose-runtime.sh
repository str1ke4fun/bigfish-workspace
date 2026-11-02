#!/usr/bin/env bash
# Read-only: no log/config contents, model calls or outbound messages.
set -uo pipefail
printf 'time_utc=%s\n' "$(date -u +%FT%TZ)"
printf 'user=%s\n' "$(id -un)"
for command in node dsh; do
  if command -v "$command" >/dev/null 2>&1; then
    "$command" --version
  else
    printf 'missing_command=%s\n' "$command"
  fi
done
for service in dsh-web xvfb-fish wechat-fish napcat-fish; do
  printf 'service=%s state=' "$service"
  systemctl is-active "$service" 2>/dev/null || true
done
for relative in \
  '.dsh-fish/home' \
  'dsh-plugins/dsh-fish/lib/restrict.js' \
  'dsh-plugins/dsh-wx/lib/index.js' \
  'dsh-plugins/dsh-mem/lib/livewx.js' \
  'cu-test/peek-wx.mjs' \
  'cu-test/wx-elements.mjs' \
  'cu-test/wx-click-label.mjs'; do
  if test -e "$HOME/$relative"; then
    printf 'present=%s\n' "$relative"
  else
    printf 'missing=%s\n' "$relative"
  fi
done
