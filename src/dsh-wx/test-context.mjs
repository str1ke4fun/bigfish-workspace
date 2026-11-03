// 任务内检索与范围约束：node test-context.mjs
// 只测纯逻辑（临时目录），不启动微信、不碰 CUA、不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createContextStore } from './lib/context.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-context-'))
const T = Date.UTC(2026, 10, 3, 4, 0, 0)

const make = (over = {}) => createContextStore({ dir: dir(), now: () => T, log: () => {}, ...over })

console.log('入池')
await t('侧栏预览只建任务，不把截断的预览写进台账', async () => {
  const c = make()
  const r = c.ingest({ chat: '测试群A', preview: '大白饭一天喂几顿', why: '@', requester: { name: '甲', kind: 'group-member', confidence: 'high' } })
  assert.equal(r.ok, true)
  assert.equal(r.task.status, 'new')
  assert.equal(r.captured.added, 0)
  assert.equal(c.ledger.recent(r.task.chatId, 5).length, 0)
})
await t('确实拿到整条入站消息时才落台账', async () => {
  const c = make()
  const r = c.ingest({
    chat: '测试群A', preview: '在吗', why: '@',
    inbound: [{ sender: '甲', senderConfidence: 'high', text: '在吗' }],
  })
  assert.equal(r.captured.added, 1)
  assert.equal(c.ledger.recent(r.task.chatId, 5).length, 1)
  assert.equal(c.ledger.recent(r.task.chatId, 5)[0].sender, '甲')
})
await t('同一预览再投一次：任务不重复，台账不重复', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  const b = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  assert.equal(b.task.taskId, a.task.taskId)
  assert.equal(b.captured.added, 0)
  assert.equal(c.board.stats().total, 1)
})

console.log('范围约束')
await t('只查任务自己的会话：另一个群命中更强也拿不到', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '随便说点', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '大白饭一天喂几顿', taskId: a.task.taskId }] })
  c.ingest({ chat: '测试群B', preview: '大白饭', why: '@' })
  c.capture({ chat: '测试群B', messages: [{ sender: '乙', text: '大白饭大白饭大白饭' }] })

  const r = await c.contextForTask({ taskId: a.task.taskId, query: '大白饭' })
  assert.equal(r.ok, true)
  assert.ok(r.shown > 0)
  assert.doesNotMatch(r.text, /测试群B/)
  assert.doesNotMatch(r.text, /乙/)
})
await t('硬塞别的 chatId → 拒绝，不返回任何卡片', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  const b = c.ingest({ chat: '测试群B', preview: '在吗', why: '@' })
  const r = await c.contextForTask({ taskId: a.task.taskId, query: '在吗', chatId: b.task.chatId })
  assert.equal(r.ok, false)
  assert.match(r.why, /自己的会话/)
  assert.equal(r.shown ?? 0, 0)
})
await t('没有这个任务 → 拒绝', async () => {
  const r = await make().contextForTask({ taskId: 't_nope', query: '在吗' })
  assert.equal(r.ok, false)
})

console.log('翻页与结果')
await t('不给 query 就按时间取最近几条', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '最早', why: '@' })
  c.capture({ chat: '测试群A', messages: [
    { sender: '甲', text: '第一条', at: '2026-11-03T01:00:00Z' },
    { sender: '乙', text: '第二条', at: '2026-11-03T02:00:00Z' },
  ] })
  const r = await c.contextForTask({ taskId: a.task.taskId, limit: 5 })
  assert.equal(r.ok, true)
  assert.match(r.text, /第一条|第二条/)
  assert.match(r.text, /最近/)
})
await t('before 翻页只取更早的', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '现在', why: '@' })
  c.capture({ chat: '测试群A', messages: [
    { sender: '甲', text: '很早的话', at: '2026-11-03T01:00:00Z' },
    { sender: '乙', text: '刚说的话', at: '2026-11-03T03:00:00Z' },
  ] })
  const r = await c.contextForTask({ taskId: a.task.taskId, before: '2026-11-03T03:00:00Z', limit: 5 })
  assert.match(r.text, /很早的话/)
  assert.doesNotMatch(r.text, /刚说的话/)
})
await t('查不到就如实说没有，不硬凑', async () => {
  const c = make()
  const task = c.board.create({ chatId: 'c_empty', chatName: '测试群A', inboundMsgId: '', text: '' }).task
  c.capture({ chat: '测试群A', chatId: 'c_empty', messages: [{ sender: '甲', text: '在聊别的事' }] })
  const r = await c.contextForTask({ taskId: task.taskId, query: '量子力学' })
  assert.equal(r.ok, true)
  assert.match(r.text, /没有找到/)
  assert.equal(r.shown, 0)
})

console.log('出站回执')
await t('发送成功挂到任务上：replying，不自动 done', async () => {
  const c = make()
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  const r = c.recordReply({ taskId: a.task.taskId, msgId: 'm_out' })
  assert.equal(r.ok, true)
  const t1 = c.board.get(a.task.taskId)
  assert.equal(t1.status, 'replying')
  assert.equal(t1.replyCount, 1)
  c.done({ taskId: a.task.taskId, note: '答完了' })
  assert.equal(c.board.get(a.task.taskId).status, 'done')
  assert.equal(c.summary(), '')
})

console.log('B 档失败与越界')
await t('向量侧车抛错 → 退回 A 档，照常出结果', async () => {
  const c = make({ vectorProvider: async () => { throw new Error('sidecar down') } })
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '大白饭怎么算' }] })
  const r = await c.contextForTask({ taskId: a.task.taskId, query: '大白饭' })
  assert.equal(r.ok, true)
  assert.equal(r.semantic, false)
  assert.match(r.text, /大白饭/)
})
await t('向量侧车返回别的会话的文档 → 过滤掉', async () => {
  let c
  const provider = async ({ docs }) => {
    const other = { msgId: 'm_other', chatId: 'c_other', chatName: '别的群', text: '大白饭', sender: '丙' }
    return [{ doc: docs[0], score: 1, reasons: ['语义近邻'] }, { doc: other, score: 0.99, reasons: ['语义近邻'] }]
  }
  c = make({ vectorProvider: provider })
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '大白饭怎么算' }] })
  const r = await c.contextForTask({ taskId: a.task.taskId, query: '大白饭' })
  assert.doesNotMatch(r.text, /别的群/)
  assert.doesNotMatch(r.text, /丙/)
})

console.log('查询不等于记忆')
await t('调试记录只有查询摘要和命中 id，不含消息正文；不写 events.jsonl', async () => {
  const d = dir()
  const c = createContextStore({ dir: d, now: () => T, log: () => {} })
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '一句不想被写进日志的正文' }] })
  await c.contextForTask({ taskId: a.task.taskId, query: '日志' })
  const raw = readFileSync(join(d, 'context-queries.jsonl'), 'utf8')
  assert.doesNotMatch(raw, /不想被写进日志的正文/)
  assert.match(raw, /qhash/)
  let events = ''
  try { events = readFileSync(join(d, 'events.jsonl'), 'utf8') } catch { events = '' }
  assert.equal(events, '')
})

console.log('目录与最近上下文')
await t('目录给了 chatId 就用目录的；私聊消息归到会话名', async () => {
  const c = make({
    resolveChat: (name) => (name === '大白饭' ? { chatId: 'c_dir_dm', isDM: true, displayName: '大白饭' } : null),
  })
  const r = c.ingest({
    chat: '大白饭', preview: '在吗', why: 'dm',
    inbound: [{ text: '在吗' }],
  })
  assert.equal(r.task.chatId, 'c_dir_dm')
  assert.equal(c.ledger.recent('c_dir_dm', 5)[0].sender, '大白饭')
  assert.equal(c.ledger.recent('c_dir_dm', 5)[0].senderConfidence, 'high')
})
await t('群聊：预览能读出谁说的，只给最后一条，medium', async () => {
  const c = make()
  c.capture({
    chat: '测试群A',
    preview: '甲: 明天几点出发',
    messages: [{ text: '别的话' }, { text: '明天几点出发' }],
  })
  const docs = c.ledger.recent(c.ledger.chats()[0], 5)
  assert.equal(docs[0].sender, null)
  assert.equal(docs[1].sender, '甲')
  assert.equal(docs[1].senderConfidence, 'medium')
})
await t('recentContext 只取当前会话、按时间正序，并过 sanitize', async () => {
  const c = make({ sanitize: (t) => (String(t).includes('秘密') ? { text: '', dropped: 1 } : { text: String(t), dropped: 0 }) })
  c.capture({ chat: '测试群A', chatId: 'c_a', messages: [
    { sender: '甲', text: '第一句', at: '2026-11-03T01:00:00Z' },
    { sender: '乙', text: '第二句', at: '2026-11-03T02:00:00Z' },
    { sender: null, direction: 'out', text: '我回的', at: '2026-11-03T03:00:00Z' },
  ] })
  c.capture({ chat: '测试群B', chatId: 'c_b', messages: [{ sender: '丙', text: '别的群', at: '2026-11-03T03:30:00Z' }] })
  const r = c.recentContext({ chat: '测试群A', chatId: 'c_a', limit: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.lines.length, 3)
  assert.match(r.lines[0], /甲：第一句/)
  assert.match(r.lines[2], /大肥鱼：我回的/)
  assert.doesNotMatch(r.text, /别的群/)
})
await t('摘要进检索：只命中本会话的摘要卡，来源标成摘要', async () => {
  const d = dir()
  const c = createContextStore({ dir: d, now: () => T, log: () => {} })
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '别的话' }] })
  const { writeDailySummaries } = await import('./lib/summaries.js')
  writeDailySummaries({
    dir: join(d, 'summaries'),
    now: () => T,
    chats: [{
      chatId: a.task.chatId, chatName: '测试群A',
      docs: [{ msgId: 'm_s1', chatId: a.task.chatId, sender: '甲', kind: 'text', direction: 'in', text: '量子力学讨论', at: '2026-11-02T10:00:00Z' }],
    }],
  })
  const r = await c.contextForTask({ taskId: a.task.taskId, query: '量子力学' })
  assert.equal(r.ok, true)
  assert.equal(r.shown, 1)
  assert.match(r.text, /摘要/)
  assert.match(r.text, /量子力学讨论/)
})
await t('维护：过期台账归档，旧天写摘要，归档后还能查', async () => {
  const d = dir()
  const c = createContextStore({ dir: d, now: () => T, retentionDays: 30, log: () => {} })
  const a = c.ingest({ chat: '测试群A', preview: '在吗', why: '@' })
  c.capture({ chat: '测试群A', messages: [{ sender: '甲', text: '很久以前的话', at: '2026-07-01T10:00:00Z' }] })
  const r = c.maintain()
  assert.equal(r.archive.archived.length, 1)
  assert.ok(r.summaries.written.some((x) => x.day === '2026-07-01'))
  const again = await c.contextForTask({ taskId: a.task.taskId, query: '很久以前' })
  assert.match(again.text, /很久以前的话/)
})

console.log(`\n${n} 项通过`)
