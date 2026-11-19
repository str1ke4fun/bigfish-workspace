#!/usr/bin/env bash
set -euo pipefail
repo="${1:-$(git rev-parse --show-toplevel)}"
sha="36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5"
blob="67b4832588e9a170159fdae121bfc66d7364d62f"

test "$(git -C "$repo" cat-file -t "$blob")" = "blob"
test "$(git -C "$repo" cat-file blob "$blob" | wc -c | tr -d ' ')" = "295442"
test "$(git -C "$repo" cat-file blob "$blob" | sha256sum | cut -d' ' -f1)" = "$sha"
test "$(git -C "$repo" show archive-2026-11-19:memorial/xiaohei/01_git/dog_photo.jpg | sha256sum | cut -d' ' -f1)" = "$sha"
git -C "$repo" tag -n99 archive-2026-11-19-payload | grep -q "MEMORIAL_SHA256="
test -z "$(git -C "$repo" diff origin/main..HEAD -- . ':(exclude)memorial')"
echo "PASS verify_git"
