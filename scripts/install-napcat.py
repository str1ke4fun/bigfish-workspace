from pathlib import Path
import json,shutil,subprocess,zipfile
r=Path('/mnt/fish-pi');base=Path('/mnt/d/fish-handoff')
app=r/'opt/QQ/resources/app';target=app/'app_launcher/napcat'
target.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(base/'offline/napcat/NapCat.Shell-v4.18.42-verified.zip') as z:z.extractall(target)
p=app/'package.json'
backup=base/'sd/preinstall/linuxqq-package-original.json'
if not backup.exists():shutil.copy2(p,backup)
meta=json.loads(p.read_text());meta['main']='./loadNapCat.js';p.write_text(json.dumps(meta,indent=2))
(app/'loadNapCat.js').write_text("const path = require('node:path');\nconst { pathToFileURL } = require('node:url');\nimport(pathToFileURL(path.join(__dirname, 'app_launcher/napcat/napcat.mjs')).href);\n")
work=r/'home/str1k3/.local/share/napcat';cfg=work/'config';cfg.mkdir(parents=True,exist_ok=True)
token=(r/'home/str1k3/.config/fish/onebot-token').read_text().strip()
config={'network':{'httpServers':[],'httpSseServers':[],'httpClients':[],'websocketServers':[{'name':'fish-local','enable':True,'host':'127.0.0.1','port':3001,'messagePostFormat':'array','reportSelfMessage':False,'token':token,'enableForcePushEvent':True,'debug':False,'heartInterval':30000}],'websocketClients':[],'plugins':[]},'musicSignUrl':'','enableLocalFile2Url':False,'parseMultMsg':False}
for name in ('onebot11.json','onebot11_2051379788.json'):
    p=cfg/name;p.write_text(json.dumps(config,indent=2));p.chmod(0o600)
web={'host':'127.0.0.1','port':6099,'token':token,'loginRate':5}
(cfg/'webui.json').write_text(json.dumps(web,indent=2));(cfg/'webui.json').chmod(0o600)
unit=r/'etc/systemd/system/napcat-fish.service'
unit.write_text('''[Unit]
Description=NapCat QQ bridge for fish
After=xvfb-fish.service network-online.target
Requires=xvfb-fish.service
[Service]
User=str1k3
Environment=DISPLAY=:99
Environment=NAPCAT_WORKDIR=/home/str1k3/.local/share/napcat
Environment=XDG_RUNTIME_DIR=/run/fish-napcat
RuntimeDirectory=fish-napcat
RuntimeDirectoryMode=0700
ExecStart=/opt/QQ/qq --no-sandbox -q 2051379788
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
''')
subprocess.run(['chroot',str(r),'chown','-R','str1k3:str1k3','/home/str1k3/.local'],check=True)
subprocess.run(['systemctl','--root='+str(r),'enable','napcat-fish','ssh.socket'],check=True)
print('NapCat installed, token matched with DSH, local WS:3001, WebUI:6099; QQ requires fresh login')
