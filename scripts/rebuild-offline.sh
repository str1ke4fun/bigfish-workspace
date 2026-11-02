#!/usr/bin/env bash
# 重新生成 offline/ 里的离线依赖（dsh 升版本时改 DSH_VER 再跑）。
#
# 在 x64 的 WSL 里跑（root），需要网。产物是给 arm64 树莓派用的，原生模块靠 --os/--cpu 指定。
#
# 为什么这么绕：npm 上的 @deepseek-ai/dsh 把一大批 dsh-* 包放在 peerDependencies 之外，
# 直接 pnpm add 拿不全；还有个别包（dsh-environment）压根没发布。下面是踩出来的固定套路。
set -euo pipefail

OUT=${OUT:-/mnt/d/fish-handoff/offline}
NODE_VER=${NODE_VER:-v24.21.0}
DSH_VER=${DSH_VER:-0.2.1-rc.5}
ONEBOT_VER=${ONEBOT_VER:-0.9.6}
PNPM_VER=${PNPM_VER:-11.28.5}
ARCH_FLAGS="--os=linux --cpu=arm64 --libc=glibc"

mkdir -p "$OUT"/node "$OUT"/dsh "$OUT"/pnpm "$OUT"/plugins "$OUT"/host-wsl

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# ---------- 1. Node ----------
say "1. node $NODE_VER arm64"
cd "$OUT/node"
[ -s "node-$NODE_VER-linux-arm64.tar.xz" ] || \
  curl -fL --retry 3 -o "node-$NODE_VER-linux-arm64.tar.xz" \
    "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.xz"
curl -fsL -o SHASUMS256.txt "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt"
grep 'linux-arm64.tar.xz' SHASUMS256.txt | sha256sum -c

# ---------- 2. pnpm / onebot tgz ----------
say "2. pnpm $PNPM_VER 和 onebot $ONEBOT_VER"
curl -fsSL --retry 3 -o "$OUT/pnpm/pnpm-$PNPM_VER.tgz" "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VER.tgz"
curl -fsSL --retry 3 -o "$OUT/plugins/dsh-onebot-qq-$ONEBOT_VER.tgz" \
  "https://registry.npmjs.org/dsh-onebot-qq/-/dsh-onebot-qq-$ONEBOT_VER.tgz"

# ---------- 3. 解开 pnpm ----------
say "3. 解 pnpm"
P=/opt/pnpm-$PNPM_VER
if [ ! -f "$P/bin/pnpm.cjs" ]; then
  mkdir -p "$P"
  tar xzf "$OUT/pnpm/pnpm-$PNPM_VER.tgz" -C "$P" --strip-components=1
fi
PNPM="node $P/bin/pnpm.cjs"

# ---------- 4. 主包 ----------
say "4. 装 dsh + onebot（arm64）"
STAGE=/opt/dsh-offline-arm64
if [ -d "$STAGE" ]; then mv "$STAGE" "$STAGE.old.$(date +%H%M%S)"; fi
mkdir -p "$STAGE"
cd "$STAGE"
printf '{"name":"dsh-offline-arm64","private":true}\n' > package.json
$PNPM add --prod --node-linker=hoisted --ignore-scripts $ARCH_FLAGS \
  --config.auto-install-peers=false --config.strict-peer-dependencies=false \
  --reporter=append-only "@deepseek-ai/dsh@$DSH_VER" "dsh-onebot-qq@$ONEBOT_VER"

# ---------- 5. 补 peer（dsh 的包互相 import，pnpm 不装这些） ----------
say "5. 补 peer 包"
PEERS="
@deepseek-ai/cordis-plugin-group
@deepseek-ai/dsh-anonymous-user-id
@deepseek-ai/dsh-attachment
@deepseek-ai/dsh-bash-local
@deepseek-ai/dsh-compaction
@deepseek-ai/dsh-deepseek-account
@deepseek-ai/dsh-fs
@deepseek-ai/dsh-jobs
@deepseek-ai/dsh-llm-deepseek
@deepseek-ai/dsh-output-retention
@deepseek-ai/dsh-ptc-runtime
@deepseek-ai/dsh-sandbox
@deepseek-ai/dsh-scope
@deepseek-ai/dsh-session-persistence
@deepseek-ai/dsh-session-query
@deepseek-ai/dsh-session-telemetry
@deepseek-ai/dsh-session-title-llm
@deepseek-ai/dsh-shell
@deepseek-ai/dsh-spill
@deepseek-ai/dsh-util-time
"
for p in $PEERS; do
  enc=$(printf '%s' "$p" | sed 's|/|%2F|')
  if curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$enc/$DSH_VER" | grep -q 200; then
    $PNPM add --prod --node-linker=hoisted --ignore-scripts $ARCH_FLAGS \
      --config.auto-install-peers=false --config.strict-peer-dependencies=false \
      --reporter=append-only "$p@$DSH_VER" 2>&1 | grep -E '^\s*\+' | head -1 || true
  else
    echo "跳过 $p（npm 上没有 $DSH_VER）"
  fi
done

# ---------- 6. 版本对齐（pnpm 有时会留老版本，启动时 export 对不上） ----------
say "6. 对齐到 $DSH_VER"
for f in node_modules/@deepseek-ai/*/package.json; do
  name=$(python3 -c "import json;print(json.load(open('$f'))['name'])" 2>/dev/null) || continue
  ver=$(python3 -c "import json;print(json.load(open('$f'))['version'])" 2>/dev/null) || continue
  case "$name" in *cordis*|*schemastery*|*cosmokit*|*libreoffice*|*node-addon*) continue ;; esac
  [ "$ver" = "$DSH_VER" ] && continue
  enc=$(printf '%s' "$name" | sed 's|/|%2F|')
  curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$enc/$DSH_VER" | grep -q 200 || continue
  echo "  $name $ver → $DSH_VER"
  $PNPM add --prod --node-linker=hoisted --ignore-scripts $ARCH_FLAGS \
    --config.auto-install-peers=false --config.strict-peer-dependencies=false \
    --reporter=append-only "$name@$DSH_VER" >/dev/null 2>&1 || true
done

# ---------- 7. 垫片：dsh-environment 没发布 ----------
say "7. 造 dsh-environment 垫片"
D=node_modules/@deepseek-ai/dsh-environment
mkdir -p "$D"
cat > "$D/package.json" <<'EOF'
{
  "name": "@deepseek-ai/dsh-environment",
  "version": "0.0.1-rc.1",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" }
}
EOF
cat > "$D/index.js" <<'EOF'
export { launchEnvironmentOf as environmentOf } from "@deepseek-ai/dsh-launch-environment";
EOF

# ---------- 8. 打包 ----------
say "8. 打包"
echo "  .node 总数: $(find node_modules -name '*.node' | wc -l)"
echo "  非 arm64 的: $(find node_modules -name '*.node' | grep -v arm64 | grep -v 'node-pty/prebuilds' | wc -l)（应为 0）"
tar -czf "$OUT/dsh/dsh-offline-arm64-$DSH_VER.tar.gz" -C /opt dsh-offline-arm64
cd "$OUT"
find . -type f ! -name 'SHA256SUMS.txt' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
ls -lh "$OUT"/dsh/
