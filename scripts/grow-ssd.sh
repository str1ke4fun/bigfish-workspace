#!/bin/bash
set -euo pipefail
test "$(blockdev --getsize64 /dev/sde)" = 256060514304
test "$(blkid -s LABEL -o value /dev/sde2)" = writable
test "$(findmnt -n -o SOURCE --target /mnt/fish-pi | head -1)" = /dev/sde2
sfdisk --dump /dev/sde > /mnt/d/fish-handoff/sd/preinstall/ssd-partitions-before-grow.sfdisk
dd if=/dev/sde of=/mnt/d/fish-handoff/sd/preinstall/ssd-first-1MiB.bin bs=1M count=1 status=none
growpart /dev/sde 2
resize2fs /dev/sde2
df -h /mnt/fish-pi
