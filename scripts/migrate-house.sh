#!/usr/bin/env bash
# 把她的屋子、插件、旧会话搬到 26.10。
set -uo pipefail
U=1000
H=/home/str1k3/.dsh-fish
D=/home/str1k3/.dsh

echo '== 1. 屋子（payload/house 完整备份） =='
install -d -o $U -g $U "$H"
cp -an /mnt/d/fish-handoff/payload/house/. "$H/"
echo "文件数: $(find "$H" -type f | wc -l)，大小: $(du -sh "$H" | cut -f1)"
echo "events.jsonl: $(wc -l < "$H/events.jsonl") 行"

echo '== 2. 插件 =='
install -d -o $U -g $U /home/str1k3/dsh-plugins
tar -xzf /mnt/d/fish-handoff/offline/plugins/dsh-plugins-2026-10-30.tar.gz -C /home/str1k3/dsh-plugins
echo "解出: $(ls /home/str1k3/dsh-plugins | tr '\n' ' ')"

echo '== 3. 旧会话和媒体 =='
if [ -d /mnt/d/fish-handoff/.tmp/recover-dsh ]; then
  cp -an /mnt/d/fish-handoff/.tmp/recover-dsh/. "$D/"
  echo "合并: $(find "$D" -maxdepth 2 -type d | wc -l) 个目录"
else
  echo "（还没打包过来，跳过）"
fi

echo '== 4. 所有权 =='
chown -R $U:$U "$H" "$D" /home/str1k3/dsh-plugins
ls -ld "$H" "$D" /home/str1k3/dsh-plugins
