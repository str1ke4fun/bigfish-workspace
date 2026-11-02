#!/bin/bash
# 从镜像里把「删库之后被重建的屋子」的文件 dump 到 D 盘，只读
set -e
OUT=/mnt/d/fish-handoff/logs/wsl-rebuilt
mkdir -p "$OUT"
dump() {
  local src="$1" dst="$2"
  rm -f "$dst"
  debugfs -R "dump $src $dst" /dev/sdd >/dev/null 2>&1 || echo "skip $src"
}
dump /home/str1k3/.dsh-fish/events.jsonl            "$OUT/events.jsonl.rebuilt-22-16"
dump /home/str1k3/.dsh-fish/logs/dsh-fish.log      "$OUT/dsh-fish.log.rebuilt"
dump /home/str1k3/.dsh-fish/home/她的身份.md          "$OUT/她的身份.md.rebuilt"
dump /home/str1k3/dsh-web.log                      "$OUT/dsh-web.log"
dump /home/str1k3/.dsh-fish/config.json            "$OUT/config.json.rebuilt"
ls -l "$OUT"
