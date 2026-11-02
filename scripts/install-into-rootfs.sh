#!/usr/bin/env bash
# 把「大肥鱼」装进树莓派 SD 卡的根分区 —— 离线版，不依赖卡联网。
#
# 用法（WSL 里，root）：
#   sudo bash install-into-rootfs.sh /mnt/pi        # /mnt/pi = 卡的 / 分区
#
# 东西全部来自 ../offline（见 交接清单.md §1）。只有第 3 步「基础包」需要网，
# 卡没配网就自动跳过 —— 下面每一步都只用 offline/ 里的文件。
#
# 幂等：重复跑只补缺。
# 本脚本没有 rm -rf。要清的临时文件都只有一个文件，`rm -f` 且路径字面量。
set -euo pipefail

ROOT="${1:?用法: install-into-rootfs.sh <根分区挂载点>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$(cd "$HERE/../payload" && pwd)"
OFFLINE="$(cd "$HERE/../offline" && pwd)"
HOST_ARCH="$(uname -m)"
NODE_TGZ="$OFFLINE/node/node-v24.21.0-linux-arm64.tar.xz"
PNPM_TGZ="$OFFLINE/pnpm/pnpm-11.28.5.tgz"
DSH_TGZ="$OFFLINE/dsh/dsh-offline-arm64-0.2.1-rc.5.tar.gz"
PLUG_TGZ="$OFFLINE/plugins/dsh-plugins-2026-10-30.tar.gz"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
say "0/7 检查目标"
# 保命三条：ROOT 写错就是把东西灌进宿主自己的 WSL 根。
[ "$ROOT" != "/" ] || die "拒绝: ROOT 是 / —— 这里要的是 SD 卡的根分区，不是宿主"
case "$ROOT" in *..*) die "ROOT 里有 .. ，不认: $ROOT" ;; esac
[ -d "$ROOT" ] || die "ROOT 不存在: $ROOT"
mountpoint -q "$ROOT" || die "$ROOT 不是挂载点 —— 先把卡或镜像 mount 上去再跑"
[ -f "$ROOT/etc/os-release" ] || die "$ROOT 看起来不是 Linux 根分区"
. "$ROOT/etc/os-release"
echo "目标系统: ${PRETTY_NAME:-?}"

for f in "$NODE_TGZ" "$PNPM_TGZ" "$DSH_TGZ" "$PLUG_TGZ"; do
  [ -f "$f" ] || die "缺离线包: $f（先按 交接清单.md §1 拉齐）"
done
echo "离线包齐全"

TARGET_ARCH="$(chroot "$ROOT" /usr/bin/env LC_ALL=C uname -m 2>/dev/null || true)"
[ -n "$TARGET_ARCH" ] || TARGET_ARCH="aarch64（按树莓派假定）"
echo "宿主: $HOST_ARCH   目标: $TARGET_ARCH"

# ---------- 1. qemu（宿主不是 arm64 才需要） ----------
say "1/7 准备 qemu 用户态模拟"
if [ "$HOST_ARCH" != "aarch64" ]; then
  if ! command -v qemu-aarch64-static >/dev/null; then
    if ls "$OFFLINE"/host-wsl/qemu-user-static_*.deb >/dev/null 2>&1; then
      dpkg -i "$OFFLINE"/host-wsl/qemu-user-static_*.deb || apt-get install -f -y
    else
      apt-get install -y qemu-user-static
    fi
  fi
  cp -f /usr/bin/qemu-aarch64-static "$ROOT/usr/bin/qemu-aarch64-static"
  echo "已放置 qemu-aarch64-static"
else
  echo "宿主就是 arm64，不需要 qemu"
fi

# ---------- 2. chroot 环境 ----------
say "2/7 挂载 chroot 需要的伪文件系统"
if [ "${FISH_OFFLINE:-0}" != 1 ]; then
  if [ -L "$ROOT/etc/resolv.conf" ]; then
    cp -L /etc/resolv.conf "$ROOT/run/fish-resolv.conf"
  else
    cp -f /etc/resolv.conf "$ROOT/etc/resolv.conf"
  fi
fi
for d in dev proc sys; do
  mountpoint -q "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d"
done
cleanup() {
  for d in dev proc sys; do
    mountpoint -q "$ROOT/$d" && umount "$ROOT/$d" || true
  done
}
trap cleanup EXIT
echo ok

# ---------- 3. 基础包（有网才装） ----------
say "3/7 基础包（有网才装；没网直接跳过）"
if [ "${FISH_OFFLINE:-0}" = 1 ]; then
  echo "强制离线模式：不访问软件仓库"
elif chroot "$ROOT" /usr/bin/env curl -fsS -m 5 -o /dev/null http://archive.ubuntu.com 2>/dev/null; then
  chroot "$ROOT" /bin/bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q ca-certificates xz-utils
  ' || echo "（apt 这一步没成功，继续 —— 后面都不依赖它）"
else
  echo "卡上没网（第一次开机大概率没配网络）—— 跳过 apt，不影响后面。"
fi

# ---------- 4. Node 24（离线） ----------
say "4/7 装 Node 24"
mkdir -p "$ROOT/usr/local"
tar -xJf "$NODE_TGZ" -C "$ROOT/usr/local" --strip-components=1
cp -f "$NODE_TGZ" "$ROOT/tmp/_node.tar.xz"
chroot "$ROOT" /bin/bash -c '
  set -e
  if [ -x /usr/local/bin/node ] && /usr/local/bin/node -v | grep -q "^v24"; then
    echo -n "已有 node: "; /usr/local/bin/node -v
  else
    tar -xJf /tmp/_node.tar.xz -C /usr/local --strip-components=1
    /usr/local/bin/node -v
  fi
  /usr/local/bin/npm -v 2>/dev/null || echo "（npm 11 在 node 24 上有 bug，装着但别用它装包）"
'
rm -f -- "$ROOT/tmp/_node.tar.xz"

# ---------- 4.5 pnpm（离线，绕开 npm 的 bug） ----------
say "4.5/7 装 pnpm 11.28.5"
mkdir -p "$ROOT/usr/local/lib/node_modules/pnpm"
tar -xzf "$PNPM_TGZ" -C "$ROOT/usr/local/lib/node_modules/pnpm" --strip-components=1
chmod +x "$ROOT/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs"
ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs "$ROOT/usr/local/bin/pnpm"
chroot "$ROOT" /usr/local/bin/pnpm -v

# ---------- 5. DSH 本体（离线，含 QQ 通道依赖） ----------
say "5/7 装 dsh（离线包，含 onebot 依赖与 arm64 原生模块）"
mkdir -p "$ROOT/opt"
tar -xzf "$DSH_TGZ" -C "$ROOT/opt"
chmod +x "$ROOT/opt/dsh-offline-arm64/node_modules/@deepseek-ai/dsh/lib/bin.js"
ln -sf /opt/dsh-offline-arm64/node_modules/@deepseek-ai/dsh/lib/bin.js "$ROOT/usr/local/bin/dsh"
chroot "$ROOT" /usr/local/bin/dsh --version

# ---------- 6. 她的屋子与插件 ----------
say "6/7 拷贝屋子、插件"
install -d -o 1000 -g 1000 "$ROOT/home/str1k3/dsh-plugins"
if [ -d "$PAYLOAD/house" ]; then
  install -d -o 1000 -g 1000 "$ROOT/home/str1k3/.dsh-fish"
  cp -an "$PAYLOAD/house/." "$ROOT/home/str1k3/.dsh-fish/"
  chown -R 1000:1000 "$ROOT/home/str1k3/.dsh-fish"
  echo "屋子: $(find "$ROOT/home/str1k3/.dsh-fish" -type f | wc -l) 个文件"
fi
tar -xzf "$PLUG_TGZ" -C "$ROOT/home/str1k3/dsh-plugins"
chown -R 1000:1000 "$ROOT/home/str1k3/dsh-plugins"
echo "插件: $(ls "$ROOT/home/str1k3/dsh-plugins")"

# 注册插件（以 str1k3 身份跑；失败不中断，留给开机后手动补）
if [ "${FISH_MANUAL_PROFILE:-0}" != 1 ]; then
for p in dsh-fish-0.6.0 dsh-wx; do
  chroot "$ROOT" /bin/su - str1k3 -c \
    "dsh plugin --profile web add link:/home/str1k3/dsh-plugins/$p" 2>&1 | tail -2 \
    || echo "（$p 注册失败，开机后手动：dsh plugin --profile web add link:/home/str1k3/dsh-plugins/$p）"
done
fi

# ---------- 7. 服务 ----------
say "7/7 systemd 单元与 sudoers"
cat > "$ROOT/etc/systemd/system/dsh-web.service" <<'UNIT'
[Unit]
Description=DSH web (大肥鱼)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=str1k3
WorkingDirectory=/home/str1k3
ExecStartPre=/bin/sh -c 'rm -f /home/str1k3/dsh-web.log'
ExecStart=/usr/local/bin/dsh web --no-open --port 8710
Restart=always
RestartSec=5
StandardOutput=append:/home/str1k3/dsh-web.log
StandardError=append:/home/str1k3/dsh-web.log

[Install]
WantedBy=multi-user.target
UNIT
install -d -m 755 "$ROOT/etc/sudoers.d"
cat > "$ROOT/etc/sudoers.d/fish-ctl" <<'SUDO'
str1k3 ALL=(root) NOPASSWD: /bin/systemctl start dsh-web, /bin/systemctl stop dsh-web, /bin/systemctl restart dsh-web, /bin/systemctl status dsh-web
SUDO
chmod 440 "$ROOT/etc/sudoers.d/fish-ctl"
chroot "$ROOT" /bin/bash -c 'systemctl enable dsh-web.service 2>/dev/null || true'

say "装完"
cat <<'TIP'
剩下要确认的：
  1. 上电后：systemctl status dsh-web；curl -sS localhost:8710 | head -c 200
  2. workspacePath 必须是 /home/str1k3/.dsh-fish/home（不是 .dsh-fish）
  3. QQ 通道要 NapCat（arm64）跑在 0.0.0.0:3001，插件侧 mode=forward
  4. 微信：先看卡上原来是什么形态（dpkg -l | grep -iE 'wechat|weixin'）
TIP
