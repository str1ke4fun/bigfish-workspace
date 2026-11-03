// 任务板：node test-tasks.mjs
// 只测纯逻辑（临时文件），不启动微信、不碰 CUA。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTaskBoard, inboundKey } from './lib/tasks.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const file = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-tasks-')), 'tasks.jsonl')
const T = Date.UTC(2026, 10, 3, 4, 0, 0)
const at = (min) => new Date(T + min * 60_000).toISOString()

const make = () => createTaskBoard({ file: file(), now: () => T, log: () => {} })
const seed = (b, over = {}) => b.create({
  chatId: 'c1', chatName: '测试群A', requester: { name: '甲', kind: 'group-member', confidence: 'high' },
  reason: '@', inboundMsgId: 'm1', text: '@你 在吗', at: at(0), ...over,
})

console.log('建任务')
t('新建 → new，摘要里有会话、谁、最后一句', () => {
  const b = make()
  const r = seed(b)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.task.status, 'new')
  assert.equal(r.task.inboundCount, 1)
  const s = b.summary({ at: T + 5 * 60_000 })
  assert.match(s, /测试群A/)
  assert.match(s, /甲（@）/)
  assert.match(s, /在吗/)
  assert.match(s, /未回/)
})
t('同一个 dedupeKey → duplicate，不新建', () => {
  const b = make()
  const a = seed(b)
  const c = seed(b)
  assert.equal(c.duplicate, true)
  assert.equal(c.task.taskId, a.task.taskId)
  assert.equal(b.stats().total, 1)
})
t('同一会话又来消息 → 追加到原任务，不另开', () => {
  const b = make()
  const a = seed(b)
  const c = b.create({ chatId: 'c1', chatName: '测试群A', inboundMsgId: 'm2', text: '补充一句', at: at(1) })
  assert.equal(c.added, true)
  assert.equal(c.task.taskId, a.task.taskId)
  assert.equal(c.task.inboundCount, 2)
  assert.equal(c.task.lastText, '补充一句')
})
t('不同会话各开一个任务', () => {
  const b = make()
  seed(b)
  const r = b.create({ chatId: 'c2', chatName: '测试群B', inboundMsgId: 'm9', text: '另一个群', at: at(1) })
  assert.equal(r.created, true)
  assert.equal(b.active().length, 2)
})

console.log('状态机')
t('claim → reading，租约挡住第二个 owner', () => {
  const b = make()
  const { task } = seed(b)
  assert.equal(b.claim(task.taskId, { owner: 'a' }).ok, true)
  assert.equal(b.get(task.taskId).status, 'reading')
  assert.equal(b.get(task.taskId).attempts, 1)
  const second = b.claim(task.taskId, { owner: 'b' })
  assert.equal(second.ok, false)
  assert.match(second.why, /正在被处理/)
  assert.equal(b.claim(task.taskId, { owner: 'a' }).ok, true, '同一个 owner 可以重领')
})
t('reply → replying、replyCount+1；final 不等于 done', () => {
  const b = make()
  const { task } = seed(b)
  b.reply(task.taskId, { msgId: 'out1', final: true, at: at(2) })
  const t1 = b.get(task.taskId)
  assert.equal(t1.status, 'replying')
  assert.equal(t1.replyCount, 1)
  assert.equal(t1.final, true)
  assert.equal(t1.status === 'done', false)
})
t('done → 结束；之后同会话新消息会开新任务', () => {
  const b = make()
  const a = seed(b)
  b.done(a.task.taskId, { note: '答完了' })
  assert.equal(b.get(a.task.taskId).status, 'done')
  assert.equal(b.active().length, 0)
  const c = b.create({ chatId: 'c1', chatName: '测试群A', inboundMsgId: 'm3', text: '又来了', at: at(3) })
  assert.equal(c.created, true)
  assert.notEqual(c.task.taskId, a.task.taskId)
})
t('snooze → waiting，未到点不算逾期；到点算', () => {
  const b = make()
  const { task } = seed(b)
  b.snooze(task.taskId, { minutes: 30, at: at(1) })
  assert.equal(b.get(task.taskId).status, 'waiting')
  assert.equal(b.overdue(T + 20 * 60_000).length, 0)
  assert.equal(b.overdue(T + 32 * 60_000).length, 1)
})
t('waiting 时对方又说话 → 重新变 new', () => {
  const b = make()
  const { task } = seed(b)
  b.snooze(task.taskId, { minutes: 30, at: at(1) })
  b.create({ chatId: 'c1', inboundMsgId: 'm4', text: '人呢', at: at(2) })
  assert.equal(b.get(task.taskId).status, 'new')
})
t('blocked 记录原因；unblock 回到 new', () => {
  const b = make()
  const { task } = seed(b)
  b.block(task.taskId, { why: '全名没解析', at: at(1) })
  assert.equal(b.get(task.taskId).status, 'blocked')
  assert.match(b.summary({ at: at(1) }), /卡住/)
  b.unblock(task.taskId, { at: at(2) })
  assert.equal(b.get(task.taskId).status, 'new')
  assert.equal(b.get(task.taskId).blockedWhy, '')
})

console.log('持久化')
t('重开一个实例 → 状态原样重放', () => {
  const f = file()
  const b1 = createTaskBoard({ file: f, now: () => T, log: () => {} })
  const { task } = seed(b1)
  b1.claim(task.taskId, { owner: 'a' })
  b1.reply(task.taskId, { msgId: 'out1', at: at(1) })

  const b2 = createTaskBoard({ file: f, now: () => T, log: () => {} })
  const t2 = b2.get(task.taskId)
  assert.equal(t2.status, 'replying')
  assert.equal(t2.replyCount, 1)
  assert.equal(t2.lastOutboundMsgId, 'out1')
  assert.equal(b2.stats().total, 1)
})
t('坏行跳过，其余任务照读', () => {
  const f = file()
  const b1 = createTaskBoard({ file: f, now: () => T, log: () => {} })
  seed(b1)
  const raw = readFileSync(f, 'utf8') + '{坏行\n'
  writeFileSync(f, raw, 'utf8')
  const b2 = createTaskBoard({ file: f, now: () => T, log: () => {} })
  assert.equal(b2.stats().total, 1)
})
t('没有任务时摘要返回空串', () => {
  assert.equal(make().summary(), '')
})
t('inboundKey 随会话和消息变', () => {
  assert.equal(inboundKey('c1', 'm1'), 'in:c1:m1')
  assert.notEqual(inboundKey('c1', 'm1'), inboundKey('c2', 'm1'))
})

console.log(`\n${n} 项通过`)
