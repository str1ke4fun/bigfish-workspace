// 工作台用：stdin 读 wx.sh tree 的输出，stdout 吐 JSON（候选会话名只来自会话列表）。
import { parseTree } from './tree.js'

let buf = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) buf += chunk
const t = parseTree(buf)
console.log(JSON.stringify({
  ok: t.ok,
  current: t.current,
  chats: t.chats.map((c) => ({ name: c.name, unread: c.unread, mention: c.mention, draft: c.draft, pinned: c.pinned, preview: c.preview.slice(0, 40), time: c.time })),
}))
