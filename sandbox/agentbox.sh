#!/usr/bin/env bash
# agentbox —— 无 root 的 AI agent 执行器
#   用法: agentbox '要执行的 shell 命令'
#   工作区: $AGENT_WORK (默认 ~/work)，agent 自己的屋子: $AGENT_HOME (默认 ~/.agent)
set -euo pipefail

WORK=${AGENT_WORK:-$HOME/work}
AHOME=${AGENT_HOME:-$HOME/.agent}
LL_HOST=${AGENT_LANDLOCK:-$AHOME/ll_sandbox.py}
LL_SANDBOX=/home/agent/.agent/$(basename "$LL_HOST")
mkdir -p "$WORK" "$AHOME"

BWRAP_ARGS=(
  --ro-bind /usr /usr
  --ro-bind-try /usr/local /usr/local
  --ro-bind /etc /etc
  --symlink usr/bin /bin
  --symlink usr/sbin /sbin
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /home
  --dir /home/agent
  --bind "$WORK" /home/agent/work
  --bind "$AHOME" /home/agent/.agent
  --chdir /home/agent/work
  --unshare-all
  --die-with-parent
  --new-session
  --cap-drop ALL
  --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  --setenv HOME /home/agent
  --setenv LANG C.UTF-8
  --setenv LC_ALL C.UTF-8
  --setenv TERM dumb
  --setenv AGENT_SANDBOX 1
)

CMD=("$@")
if [ $# -eq 1 ]; then
  CMD=(/bin/bash -c "$1")
fi

if [ -f "$LL_HOST" ]; then
  exec bwrap "${BWRAP_ARGS[@]}" \
    prlimit --nproc=512 -- \
    /usr/bin/python3 "$LL_SANDBOX" \
      --rw /home/agent/work --rw /home/agent/.agent \
      --ro /usr --ro /usr/local --ro /etc --ro /bin --ro /sbin --ro /lib --ro /lib64 \
      --rw /tmp --ro /proc --rw /dev -- "${CMD[@]}"
else
  exec bwrap "${BWRAP_ARGS[@]}" \
    prlimit --nproc=512 -- "${CMD[@]}"
fi
