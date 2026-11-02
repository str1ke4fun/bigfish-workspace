// 工作台用：stdin 读 wx.sh ocr/tree 的输出，stdout 吐结构化候选会话。
import { parseTree } from './tree.js'
import { pathToFileURL } from 'node:url'

export function chatsJson(input) {
  const buf = String(input ?? '')
  const t = parseTree(buf)
  let snapshot
  try { snapshot = JSON.parse(buf.trim()) } catch { snapshot = null }
  if (snapshot && Array.isArray(snapshot.rows)) {
    const chats = snapshot.rows
      .filter((c) => c && typeof c.name === 'string' && c.name.trim() &&
        Number(c.nameConfidence) >= 55 && !/^[\p{P}\p{S}\s]+$/u.test(c.name) &&
        !/^(?:Weixin|微信|Contacts|通讯录|Moments|朋友圈|Search|搜索)$/i.test(c.name.trim()))
      .map((c) => ({
        name: c.name.trim(), unread: Number(c.unread) || 0, mention: c.mention === true,
        draft: false, pinned: false, preview: String(c.preview || '').slice(0, 40), time: String(c.time || ''),
      }))
    return { ok: snapshot.ok === true && snapshot.reliable === true && chats.length > 0, current: '', chats }
  }
  return {
    ok: t.ok,
    current: t.current,
    chats: t.chats.map((c) => ({ name: c.name, unread: c.unread, mention: c.mention, draft: c.draft, pinned: c.pinned, preview: c.preview.slice(0, 40), time: c.time })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += chunk
  process.stdout.write(JSON.stringify(chatsJson(buf)) + '\n')
}
