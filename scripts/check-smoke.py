from pathlib import Path
import re,urllib.request,sys,http.cookiejar
p=Path('/mnt/d/fish-handoff/logs/ssd-web-smoke.log')
s=p.read_text(errors='replace') if p.exists() else ''
m=re.search(r'http://(?:127\.0\.0\.1|localhost):18713/\?token=[^\s\x1b]+',s)
if not m:sys.exit(1)
try:
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    with opener.open(m[0],timeout=2) as response:
        data=response.read()
        if response.status==200 and len(data)>1000:
            print('Authenticated UI: HTTP 200; bytes:',len(data))
            Path('/mnt/d/fish-handoff/logs/ssd-smoke-result.txt').write_text('Authenticated UI HTTP 200; bytes='+str(len(data)))
            sys.exit(0)
except Exception as e:
    Path('/mnt/d/fish-handoff/.tmp/smoke-error.txt').write_text(type(e).__name__+': '+str(getattr(e,'code','')))
sys.exit(1)
