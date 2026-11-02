#!/usr/bin/env bash
# 在 Ubuntu 26.10 (x86_64) 里装 node + pnpm + dsh。
# 和卡上那套 arm64 的区别：这里不写 --os/--cpu，也不用 --ignore-scripts（原生模块要正常装）。
set -uo pipefail
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

NODE_VER=v24.21.0
DSH_VER=0.2.1-rc.5
PNPM_VER=11.28.5
STAGE=/opt/dsh-x64
PNPM="node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs"
PNPM_FLAGS="--prod --node-linker=hoisted --config.auto-install-peers=false --config.strict-peer-dependencies=false --reporter=append-only"

say "1/6 node $NODE_VER x64"
if [ -x /usr/local/bin/node ] && /usr/local/bin/node -v 2>/dev/null | grep -q "$NODE_VER"; then
  echo "已有: $(/usr/local/bin/node -v)"
else
  cd /tmp
  curl -fL --retry 3 -o node.tar.xz "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" || exit 1
  tar -xJf node.tar.xz -C /usr/local --strip-components=1
  rm -f node.tar.xz
  /usr/local/bin/node -v
fi

say "2/6 pnpm $PNPM_VER"
if /usr/local/bin/pnpm -v 2>/dev/null | grep -q "$PNPM_VER"; then
  echo "已有: $(/usr/local/bin/pnpm -v)"
else
  curl -fsSL --retry 3 -o /tmp/pnpm.tgz "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VER.tgz" || exit 1
  mkdir -p /usr/local/lib/node_modules/pnpm
  tar -xzf /tmp/pnpm.tgz -C /usr/local/lib/node_modules/pnpm --strip-components=1
  chmod +x /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs
  ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
  /usr/local/bin/pnpm -v
fi

say "3/6 dsh $DSH_VER + onebot"
mkdir -p "$STAGE"
cd "$STAGE"
[ -f package.json ] || printf '{"name":"dsh-x64","private":true}\n' > package.json
$PNPM add $PNPM_FLAGS "@deepseek-ai/dsh@$DSH_VER" "dsh-onebot-qq@0.9.6" 2>&1 | tail -6

say "4/6 补 peer 包"
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
    $PNPM add $PNPM_FLAGS "$p@$DSH_VER" >/dev/null 2>&1 && echo "  ok  $p" || echo "  !!  $p"
  else
    echo "  跳过 $p（无此版本）"
  fi
done

say "5/6 对齐到 $DSH_VER"
for f in node_modules/@deepseek-ai/*/package.json; do
  name=$(python3 -c "import json;print(json.load(open('$f'))['name'])" 2>/dev/null) || continue
  ver=$(python3 -c "import json;print(json.load(open('$f'))['version'])" 2>/dev/null) || continue
  case "$name" in *cordis*|*schemastery*|*cosmokit*|*libreoffice*|*node-addon*) continue ;; esac
  [ "$ver" = "$DSH_VER" ] && continue
  enc=$(printf '%s' "$name" | sed 's|/|%2F|')
  curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$enc/$DSH_VER" | grep -q 200 || continue
  echo "  $name $ver → $DSH_VER"
  $PNPM add $PNPM_FLAGS "$name@$DSH_VER" >/dev/null 2>&1 || true
done

say "6/6 dsh-environment 垫片 + 链接"
D=node_modules/@deepseek-ai/dsh-environment
mkdir -p "$D"
printf '{\n  "name": "@deepseek-ai/dsh-environment",\n  "version": "0.0.1-rc.1",\n  "type": "module",\n  "main": "index.js",\n  "exports": { ".": "./index.js" }\n}\n' > "$D/package.json"
printf 'export { launchEnvironmentOf as environmentOf } from "@deepseek-ai/dsh-launch-environment";\n' > "$D/index.js"
chmod +x node_modules/@deepseek-ai/dsh/lib/bin.js
ln -sf "$STAGE/node_modules/@deepseek-ai/dsh/lib/bin.js" /usr/local/bin/dsh
echo "dsh → $(readlink -f /usr/local/bin/dsh)"
/usr/local/bin/dsh --version
