from pathlib import Path
import hashlib,json
r=Path('/mnt/fish-pi');base=Path('/mnt/d/fish-handoff')
original=base/'payload/house/events.jsonl';target=r/'home/str1k3/.dsh-fish/events.jsonl'
a=original.read_bytes();b=target.read_bytes()
assert b.startswith(a),'Original memory events changed'
print('Original memory events: byte-identical prefix; original lines:',len(a.splitlines()),'current lines:',len(b.splitlines()))
profile=r/'home/str1k3/.dsh/profiles/web'
meta=json.loads((profile/'package.json').read_text())
print('Profile bundles:',', '.join(meta['dsh']['profile']['bundles']))
cfg=json.loads((profile/'cordis.patch.yml').read_text())[0]['config']
assert cfg['workspacePath']=='/home/str1k3/.dsh-fish/home'
assert cfg['accessToken']==json.loads((r/'home/str1k3/.local/share/napcat/config/onebot11.json').read_text())['network']['websocketServers'][0]['token']
print('Workspace and OneBot tokens: valid')
for f in ('boot/firmware/current/vmlinuz','boot/firmware/current/initrd.img','boot/firmware/current/bcm2712-rpi-5-b.dtb'):
    assert (r/f).stat().st_size>0
print('Pi 5 boot artifacts: present')
