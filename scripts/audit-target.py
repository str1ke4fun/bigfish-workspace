from pathlib import Path
import json
r=Path('/mnt/fish-pi')
for p in ('boot/firmware/user-data','boot/firmware/meta-data'):
    print(p)
    for line in (r/p).read_text().splitlines():
        if any(k in line for k in ('name:', 'users:', 'ssh_pwauth', 'lock_passwd', 'growpart', 'resize_rootfs')):
            print(line)
status=(r/'var/lib/dpkg/status').read_text()
print('wechat/qq packages:')
for block in status.split('\n\n'):
    name=next((l for l in block.splitlines() if l.startswith('Package: ')),'')
    if any(k in name.lower() for k in ('wechat','weixin','qq','napcat')):print(name)
print('house files',len(list(Path('/mnt/d/fish-handoff/payload/house').rglob('*'))))
