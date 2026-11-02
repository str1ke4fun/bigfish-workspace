from pathlib import Path
import json,os,secrets,subprocess
r=Path('/mnt/fish-pi');base=Path('/mnt/d/fish-handoff')
def write(path,text,mode=0o644):
    p=r/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);p.chmod(mode)
profile='home/str1k3/.dsh/profiles/web'
tokenfile=r/'home/str1k3/.config/fish/onebot-token'
token=tokenfile.read_text().strip() if tokenfile.exists() else secrets.token_urlsafe(32)
write('home/str1k3/.config/fish/onebot-token',token+'\n',0o600)
config={'mode':'forward','url':'ws://127.0.0.1:3001','accessToken':token,'workspacePath':'/home/str1k3/.dsh-fish/home','requireMention':True,'dmPolicy':'allowlist','allowFrom':['859581746'],'adminUsers':['859581746'],'groupPolicy':'allowlist','groupAllowFrom':[],'reconnectMaxAttempts':0}
# JSON is also valid YAML and preserves QQ identifiers as strings.
write(profile+'/cordis.patch.yml',json.dumps([{'id':'dsh-onebot','config':config}],ensure_ascii=False,indent=2)+'\n',0o600)
write(profile+'/pnpm-workspace.yaml','packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
login=json.loads((base/'.tmp/sd-login.json').read_text())
subprocess.run(['chroot',str(r),'chpasswd','-e'],input='str1k3:'+login['passwd']+'\n',text=True,check=True)
write('etc/ssh/sshd_config.d/70-fish.conf','PasswordAuthentication yes\nPermitRootLogin no\n')
write('etc/netplan/90-fish-ethernet.yaml','network:\n  version: 2\n  renderer: NetworkManager\n  ethernets:\n    fish-ethernet:\n      match:\n        name: "e*"\n      dhcp4: true\n      optional: true\n',0o600)
write('etc/systemd/system/xvfb-fish.service','''[Unit]
Description=Virtual display for fish channels
After=local-fs.target
[Service]
User=str1k3
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
''')
write('etc/systemd/system/wechat-fish.service','''[Unit]
Description=WeChat for fish
After=xvfb-fish.service network-online.target
Requires=xvfb-fish.service
[Service]
User=str1k3
Environment=DISPLAY=:99
Environment=XDG_RUNTIME_DIR=/run/fish-wechat
RuntimeDirectory=fish-wechat
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/wechat
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
''')
write('etc/systemd/system/dsh-web.service.d/display.conf','[Service]\nEnvironment=DISPLAY=:99\nEnvironment=WX_DISPLAY=:99\nEnvironment=XDG_RUNTIME_DIR=/run/fish-dsh\nRuntimeDirectory=fish-dsh\nRuntimeDirectoryMode=0700\n')
subprocess.run(['chroot',str(r),'chown','-R','str1k3:str1k3','/home/str1k3'],check=True)
subprocess.run(['systemctl','--root='+str(r),'enable','xvfb-fish','wechat-fish'],check=True)
print('Profile configured; old SD login hash reused; Ethernet DHCP configured; no secrets printed')
