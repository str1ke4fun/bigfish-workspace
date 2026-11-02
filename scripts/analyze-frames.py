#!/usr/bin/env python3
# 复现清单里的数字：她这条 system prompt 的构成、轮次/中途插话统计
# 用法：python analyze-frames.py [session_frames.ndjson]
import json, re, sys, io

P = sys.argv[1] if len(sys.argv) > 1 else r'D:\fish-handoff\payload\recovered\session_frames.ndjson'
rows = [json.loads(l) for l in io.open(P, encoding='utf-8') if l.strip()]
rows.sort(key=lambda r: r.get('seq', 10 ** 9))

# 1) system prompt 构成
best = ''
for r in rows:
    if r.get('type') == 'system/message':
        t = ''.join(c.get('text', '') for c in (r['data'].get('message', {}).get('content') or []))
        if len(t) > len(best):
            best = t
i = best.find('## 你是谁')
print('system prompt 总长:', len(best))
print('宿主前缀:', i if i > 0 else -1, ' 身份段:', len(best) - i if i > 0 else -1,
      ' 占比: %.1f%%' % (100 * (len(best) - i) / len(best) if i > 0 else 0))
for s in re.split(r'\n## ', best[i:] if i > 0 else best):
    print('  - %-28s %5d 字' % (s.split('\n')[0][:28], len(s)))

# 2) 轮次与中途插话
turns, cur = [], None
for r in rows:
    t = r.get('type')
    if t == 'turn/start':
        cur = {'start': r['seq'], 'end': None}
    elif t == 'turn/end' and cur:
        cur['end'] = r['seq']; turns.append(cur); cur = None
spliced = [r['seq'] for r in rows if r.get('type') == 'agent/inbox/spliced']
mid = [s for s in spliced if any(t['start'] < s < (t['end'] or 10 ** 9) for t in turns)]
print('\nturn 数:', len(turns), ' spliced:', len(spliced), ' 落在轮次进行中:', len(mid))

# 3) 工具调用分布（看她手上有什么）
calls = [r for r in rows if r.get('type') == 'tool/call']
from collections import Counter
print('\n工具调用:', Counter(r['data'].get('name') for r in calls).most_common())
