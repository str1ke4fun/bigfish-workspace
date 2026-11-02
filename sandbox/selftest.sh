#!/usr/bin/env bash
# agentbox 自测：在 WSL 里以当前用户身份跑
set -u
BASE=$(cd "$(dirname "$0")" && pwd)
export AGENT_WORK=${AGENT_WORK:-$HOME/work}
export AGENT_HOME=${AGENT_HOME:-$HOME/.agent}
mkdir -p "$AGENT_WORK" "$AGENT_HOME"
cp "$BASE/ll_sandbox.py" "$AGENT_HOME/" 2>/dev/null
BOX="bash $BASE/agentbox.sh"

echo "== 1) 基本可用 / 工作区写入 =="
$BOX 'id -un; pwd; echo hello > t1.txt; ls | head -3'
echo "   宿主机侧: $(ls -l "$AGENT_WORK/t1.txt" 2>&1)"

echo "== 2) rm -rf /* =="
$BOX 'rm -rf /* 2>&1 | head -2; echo "rm 执行完毕"; ls | head -3'
echo "   宿主机家目录仍在: $(ls "$HOME" | head -3 | tr '\n' ' ')"

echo "== 3) 越界写 / 读私钥 / 看 /root =="
$BOX 'touch /etc/pwn 2>&1; head -1 ~/.bashrc 2>&1; ls /root 2>&1'

echo "== 4) 外联 =="
$BOX 'curl -sS -m 4 https://example.com 2>&1 | head -1; getent hosts example.com 2>&1 | head -1'

echo "== 5) 退出码 =="
$BOX 'exit 7'; echo "   exit=$?"

echo "== 6) 中文 / 引号 / 管道 =="
$BOX 'echo "中文 正常 | 管道 | $HOME"; printf "%s\n" "带 空格 参数"'

echo "== 7) 资源与身份 =="
$BOX 'grep -E "^(CapEff|NoNewPrivs):" /proc/self/status; ls /mnt 2>&1'
true
