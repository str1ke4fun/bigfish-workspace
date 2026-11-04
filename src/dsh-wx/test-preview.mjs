// 预览入账与只读历史查询：node test-preview.mjs
// 只测纯逻辑（临时目录），不启动微信、不碰 CUA、不联网。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createContextStore } from './lib/context.js'
import { DEFAULT_IGNORE_CHATS } from './lib/capture.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-preview-'))
const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime()
const atLocal = (h, m) => new Date(2026, 10, 4, h, m, 0).toISOString()

const make = (over = {}) => createContextStore({ dir: dir(), now: () => NOW, log: () => {}, ...over })

// 生产环境用目录判断单聊/群聊；这里用一个只认识测试会话的小目录。
const withDirectory = (over = {}) => make({
  resolveChat: (name) => {
    if (name === '张三') return { chatId: 'c_dm_zhangsan', isDM: true, displayName: '张三' }
    if (name === '群A') return { chatId: 'c_group_a', isDM: false, displayName: '群A' }
    if (name === '群B') return { chatId: 'c_group_b', isDM: false, displayName: '群B' }
    return null
  },
  ...over,
})

console.log('预览入账')
await t('群预览：名字: 内容 解析发言人，重复预览不重复入账', async () => {
  const c = make()
  const r = c.capturePreview({ chat: '群A', preview: '计科4223薛长顺: 那里润', time: '14:02' })
  assert.equal(r.ok, true)
  assert.equal(r.added, 1)
  assert.equal(r.sender, '计科4223薛长顺')
  assert.equal(r.kind, 'text')

  const again = c.capturePreview({ chat: '群A', preview: '计科4223薛长顺: 那里润', time: '14:02' })
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 1)

  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.text, '那里润')
  assert.equal(doc.sender, '计科4223薛长顺')
  assert.equal(doc.senderConfidence, 'medium')
  assert.equal(doc.source, 'preview')
  assert.equal(doc.at, atLocal(14, 2))
  assert.equal(doc.atConfidence, 'medium')
})
await t('时间前缀不认发言人', async () => {
  const c = make()
  const r = c.capturePreview({ chat: '群B', preview: '14:02 开会' })
  assert.equal(r.ok, true)
  assert.equal(r.sender, null)
  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.text, '14:02 开会')
  assert.equal(doc.sender, null)
})
await t('贴纸：保留占位符，标成 sticker，不进可检索正文', async () => {
  const c = make()
  const r = c.capturePreview({ chat: '群A', preview: '张三: [Sticker]', time: '14:03' })
  assert.equal(r.kind, 'sticker')
  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.kind, 'sticker')
  assert.equal(doc.text, '[Sticker]')
  assert.equal(doc.sender, '张三')
  assert.equal(c.ledger.searchDocs(r.chatId).length, 0)
})
await t('单聊：发言人用会话名，置信度 high', async () => {
  const c = withDirectory()
  const r = c.capturePreview({ chat: '张三', preview: '在吗' })
  assert.equal(r.ok, true)
  assert.equal(r.sender, '张三')
  assert.equal(r.chatId, 'c_dm_zhangsan')
  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.sender, '张三')
  assert.equal(doc.senderConfidence, 'high')
  assert.equal(doc.text, '在吗')
  assert.equal(doc.at, new Date(NOW).toISOString())
  assert.equal(doc.atConfidence, 'low')
})
await t('显式 isDM 优先于目录；unread 带进台账', async () => {
  const c = make()
  const r = c.capturePreview({ chat: '李四', preview: '在吗', isDM: true, unread: 3 })
  assert.equal(r.sender, '李四')
  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.unreadBefore, 3)
  assert.equal(doc.atConfidence, 'low')
})
await t('at 参数优先于侧栏时间，置信度 medium', async () => {
  const c = make()
  const r = c.capturePreview({ chat: '群A', preview: '甲: 带时间', time: '14:02', at: '2026-11-04T03:00:00Z' })
  const doc = c.ledger.recent(r.chatId, 1)[0]
  assert.equal(doc.at, '2026-11-04T03:00:00Z')
  assert.equal(doc.atConfidence, 'medium')
})
await t('服务号预览不入账，旧记录不动', async () => {
  const c = make()
  const old = c.capturePreview({ chat: 'Tencent News', preview: '旧新闻', at: '2026-11-03T09:00:00Z' })
  assert.equal(old.added, 1)

  const r = c.capturePreview({ chat: 'Tencent News', preview: '今日头条', ignoreChats: DEFAULT_IGNORE_CHATS })
  assert.equal(r.ok, true)
  assert.equal(r.added, 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.sender, null)
  assert.equal(r.kind, 'text')
  assert.equal(r.why, 'ignored')
  assert.equal(c.ledger.stats(old.chatId).count, 1)
})

console.log('只读历史')
await t('无 query 取最近；有 query 走词法；hours 按采集时间截断', async () => {
  const c = make()
  c.capturePreview({ chat: '群A', preview: '张三: 明天九点开会', time: '10:00' })
  c.capturePreview({ chat: '群A', preview: '李四: 收到', time: '14:30' })

  let h = c.historyForChat({ chat: '群A' })
  assert.equal(h.ok, true)
  assert.equal(h.shown, 2)
  assert.equal(h.cards.length, 2)
  assert.match(h.text, /明天九点开会/)
  assert.match(h.text, /收到/)

  h = c.historyForChat({ chat: '群A', query: '开会' })
  assert.equal(h.ok, true)
  assert.equal(h.shown, 1)
  assert.match(h.text, /明天九点开会/)
  assert.doesNotMatch(h.text, /收到/)

  h = c.historyForChat({ chat: '群A', hours: 2 })
  assert.equal(h.ok, true)
  assert.equal(h.shown, 1)
  assert.match(h.text, /收到/)
  assert.doesNotMatch(h.text, /明天九点开会/)
})
await t('limit 切最近几条，1–20 截断', async () => {
  const c = make()
  c.capturePreview({ chat: '群A', preview: '甲: 第一条', time: '10:00' })
  c.capturePreview({ chat: '群A', preview: '甲: 第二条', time: '11:00' })
  c.capturePreview({ chat: '群A', preview: '甲: 第三条', time: '12:00' })
  const h = c.historyForChat({ chat: '群A', limit: 2 })
  assert.equal(h.shown, 2)
  assert.match(h.text, /第三条/)
  assert.doesNotMatch(h.text, /第一条/)
})
await t('没有记录 / 没有命中：如实说，不硬凑', async () => {
  const c = make()
  const empty = c.historyForChat({ chat: '空群' })
  assert.equal(empty.ok, true)
  assert.equal(empty.shown, 0)
  assert.equal(empty.text, '这个会话还没有可查的记录。')

  c.capturePreview({ chat: '群A', preview: '甲: 在聊别的事' })
  const miss = c.historyForChat({ chat: '群A', query: '量子力学' })
  assert.equal(miss.ok, true)
  assert.equal(miss.shown, 0)
  assert.equal(miss.text, '没有找到相关的上下文。')
})
await t('服务号查询直接拒绝，即使盘上还有旧记录', async () => {
  const c = make()
  const old = c.capturePreview({ chat: 'Tencent News', preview: '旧新闻', at: '2026-11-03T09:00:00Z' })
  const h = c.historyForChat({ chat: 'Tencent News', ignoreChats: DEFAULT_IGNORE_CHATS })
  assert.equal(h.ok, false)
  assert.match(h.why, /不记录服务号/)
  assert.equal(h.shown, 0)
  assert.equal(c.ledger.stats(old.chatId).count, 1)
})
await t('结果正文过注入的 sanitize', async () => {
  const c = make({
    sanitize: (text) => (String(text).includes('SECRET') ? { text: '[已拦截]', dropped: 1 } : { text: String(text), dropped: 0 }),
  })
  c.capturePreview({ chat: '群A', preview: '张三: SECRET 计划', time: '14:00' })
  const h = c.historyForChat({ chat: '群A', query: 'SECRET' })
  assert.equal(h.ok, true)
  assert.equal(h.shown, 1)
  assert.match(h.text, /\[已拦截\]/)
  assert.doesNotMatch(h.text, /SECRET 计划/)
  assert.equal(h.dropped, 1)
})

console.log('已记录会话列表')
await t('按 lastAt 倒序，跳过服务号，旧记录仍留在盘上', async () => {
  const c = make()
  c.capturePreview({ chat: '群A', preview: '甲: 第一条', at: '2026-11-04T10:00:00Z' })
  c.capturePreview({ chat: '群A', preview: '乙: 第二条', at: '2026-11-04T11:00:00Z' })
  c.capturePreview({ chat: '群B', preview: '丙: 别的群', at: '2026-11-04T12:00:00Z' })
  c.capturePreview({ chat: '张三', preview: '在吗', at: '2026-11-04T14:00:00Z' })
  const old = c.capturePreview({ chat: 'Tencent News', preview: '旧新闻', at: '2026-11-03T09:00:00Z' })

  const list = c.listRecordedChats({ ignoreChats: DEFAULT_IGNORE_CHATS })
  assert.equal(list.ok, true)
  assert.equal(list.shown, 3)
  assert.deepEqual(list.chats.map((x) => x.chat), ['张三', '群B', '群A'])
  assert.equal(list.chats.find((x) => x.chat === '群A').count, 2)
  assert.match(list.text, /- 群A｜[^｜]+｜2 条/)
  assert.doesNotMatch(list.text, /Tencent News/)
  assert.equal(c.ledger.stats(old.chatId).count, 1)
})
await t('limit 截断列表；空列表给固定文案', async () => {
  const c = make()
  c.capturePreview({ chat: '群A', preview: '甲: 第一条', at: '2026-11-04T10:00:00Z' })
  c.capturePreview({ chat: '群B', preview: '乙: 第二条', at: '2026-11-04T12:00:00Z' })
  const list = c.listRecordedChats({ limit: 1 })
  assert.equal(list.shown, 1)
  assert.equal(list.chats[0].chat, '群B')

  const empty = make().listRecordedChats()
  assert.equal(empty.ok, true)
  assert.equal(empty.shown, 0)
  assert.deepEqual(empty.chats, [])
  assert.equal(empty.text, '还没有任何会话记录。')
})

console.log(`\n${n} 项通过`)
