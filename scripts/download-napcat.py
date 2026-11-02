import concurrent.futures,hashlib,json,time,urllib.request
from pathlib import Path
base=Path('/mnt/d/fish-handoff')
meta=json.loads((base/'.tmp/napcat-release.json').read_text())
asset=next(a for a in meta['assets'] if a['name']=='NapCat.Shell.zip')
size=asset['size']; workers=16; chunk=(size+workers-1)//workers
out=base/'offline/napcat'; parts=base/'.tmp/napcat-parts';parts.mkdir(exist_ok=True)
def get(i):
    start=i*chunk; end=min(size,start+chunk)-1; p=parts/str(i)
    if p.exists() and p.stat().st_size==end-start+1:return p
    for retry in range(3):
        try:
            req=urllib.request.Request(asset['browser_download_url'],headers={'Range':f'bytes={start}-{end}'})
            with urllib.request.urlopen(req,timeout=90) as response:
                data=response.read()
                if response.status!=206 or len(data)!=end-start+1:raise ValueError('Range response invalid')
            p.write_bytes(data);print('part',i,'OK',flush=True);return p
        except Exception as e:
            if retry==2:raise
            time.sleep(1)
with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
    paths=list(pool.map(get,range(workers)))
data=b''.join(p.read_bytes() for p in paths)
assert len(data)==size
assert 'sha256:'+hashlib.sha256(data).hexdigest()==asset['digest']
(out/'NapCat.Shell-v4.18.42-verified.zip').write_bytes(data)
print('NapCat GitHub SHA256 verified',flush=True)
