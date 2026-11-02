#!/usr/bin/env bash
# 删一个 dsh 会话 —— 可回滚、不拼路径、不出现 rm -rf。
#
# 背景：2026-10-31 那次事故，是一条命令里的变量没展开，成了 rm -rf /* ，
# 屋子、记忆、老哥一块 100G 的盘一起没了。之后定的规矩：
#   1. 给 WSL 的命令里，删除路径一律写死绝对字面量，不拼变量、不拼通配符；
#   2. 能用 mv 就不 rm，删掉的东西先进回收站，坏了还能捞回来。
#
# 所以这个脚本只做一件事：把一个会话目录挪进回收站。
#
# 用法（WSL 里，root；顺序不能反）：
#   sudo systemctl stop dsh-web
#   sudo bash /mnt/d/fish-handoff/scripts/rm-session.sh /home/str1k3/.dsh/profiles/web/sessions/<id>
#   sudo systemctl start dsh-web
#
# 恢复：把打印出来的那条 mv 反过来跑。
set -euo pipefail

TRASH="/home/str1k3/.dsh-trash"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || die "用法: rm-session.sh <会话目录的绝对路径>（一次只删一个）"
TARGET="$1"

# ---------- 形状校验：不认识的路径一律不碰 ----------
case "$TARGET" in
  /*) ;;
  *)         die "不是绝对路径: $TARGET" ;;
esac
case "$TARGET" in
  *..*)        die "路径里不许有 .. : $TARGET" ;;
  *'*'*|*'?'*) die "路径里不许有通配符: $TARGET" ;;
  *'$'*|*'`'*) die "路径里不许有变量/命令替换: $TARGET" ;;
esac
case "$TARGET" in
  *[[:space:]]*) die "路径里有空白: $TARGET" ;;
esac

NAME="$(basename -- "$TARGET")"
printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' \
  || die "目录名不像会话 id（字母数字._-）: $NAME"

# 容器目录不能当会话删
for bad in sessions profiles web dsh .dsh home .dsh-fish home.json config.json; do
  [ "$NAME" != "$bad" ] || die "拒绝: $NAME 是容器/配置文件，不是会话"
done

[ -e "$TARGET" ] || die "不存在: $TARGET"
[ -d "$TARGET" ] || die "不是目录: $TARGET"
[ -L "$TARGET" ] && die "是符号链接，先人工看一眼它指向哪: $(readlink -f -- "$TARGET")"
[ "$TARGET" != "/" ] || die "拒绝: /"

# 必须是 sessions 的下一层：父目录名就叫 sessions
PARENT="$(basename -- "$(dirname -- "$TARGET")")"
[ "$PARENT" = "sessions" ] \
  || die "父目录不叫 sessions（$PARENT），看着不像会话目录，停手"

# ---------- 挪，不删 ----------
say "会话: $NAME"
say "回收站: $TRASH"
install -d -m 700 -- "$TRASH"
DEST="$TRASH/$NAME.$(date +%Y%m%d-%H%M%S)"
[ ! -e "$DEST" ] || die "回收站里已有同名: $DEST"
mv -- "$TARGET" "$DEST"

echo
echo "已移走。确认宿主起得来、没再点名这个会话，再自己清回收站。"
echo "要撤销： mv -- '$DEST' '$TARGET'"
