// 任务板：node test-tasks.mjs
// 只测纯逻辑（临时文件），不启动微信、不碰 CUA。
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const remind = (b, taskId, over = {}) => {
  const task = b.get(taskId)
  return b.markReminded(taskId, {
    expectedVersion: task.version,
    expectedOverdueCount: task.overdueCount,
    ...over,
  })
}

console.log('建任务')
t('新建 → new，摘要里有会话、谁、最后一句', () => {
  const b = make()
  const r = seed(b, { text: '甲: @你 在吗' })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.task.status, 'new')
  assert.equal(r.task.inboundCount, 1)
  const s = b.summary({ at: T + 5 * 60_000 })
  assert.equal(s, [
    '「测试群A」里，甲说：在吗',
    '还没回。',
    `〔${r.task.taskId}〕`,
  ].join('\n'))
  assert.doesNotMatch(s, /测试群A｜甲|未回（|状态：|已等|（@）/)
  assert.equal(s.split('\n').at(-1), `〔${r.task.taskId}〕`, '任务记号只在末行')
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
t('同一 reply msgId 重放不重复计数，也不覆盖最新出站消息', () => {
  const b = make()
  const { task } = seed(b)
  const first = b.reply(task.taskId, { msgId: 'out1', at: at(2) })
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, undefined)
  const replay = b.reply(task.taskId, { msgId: 'out1', at: at(3) })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(b.get(task.taskId).replyCount, 1)
  assert.equal(b.get(task.taskId).lastOutboundMsgId, 'out1')

  b.reply(task.taskId, { msgId: 'out2', at: at(4) })
  const olderReplay = b.reply(task.taskId, { msgId: 'out1', at: at(5) })
  assert.equal(olderReplay.duplicate, true)
  assert.equal(b.get(task.taskId).replyCount, 2)
  assert.equal(b.get(task.taskId).lastOutboundMsgId, 'out2')
})
t('没有稳定 msgId 的 reply 不推进任务', () => {
  const b = make()
  const { task } = seed(b)
  const r = b.reply(task.taskId, { msgId: '', at: at(2) })
  assert.equal(r.ok, false)
  assert.match(r.why, /消息记号/)
  assert.equal(b.get(task.taskId).replyCount, 0)
  assert.equal(b.get(task.taskId).updatedAt, at(0))
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
  assert.match(b.summary({ at: at(1) }), /这件事先放着/)
  assert.doesNotMatch(b.summary({ at: at(1) }), /卡住|全名没解析|状态：/)
  b.unblock(task.taskId, { at: at(2) })
  assert.equal(b.get(task.taskId).status, 'new')
  assert.equal(b.get(task.taskId).blockedWhy, '')
})

console.log('逾期提醒')
t('到点才提醒；提醒后 overdueCount+1、下次检查时间推后', () => {
  const b = make()
  const { task } = seed(b)
  assert.equal(b.overdueReminders({ at: T + 14 * 60_000 }).length, 0)
  assert.equal(b.overdueReminders({ at: T + 16 * 60_000 }).length, 1)
  const r = remind(b, task.taskId, { level: 1, nextCheckAt: at(61), note: '第一次' })
  assert.equal(r.ok, true)
  assert.equal(b.get(task.taskId).overdueCount, 1)
  assert.equal(b.get(task.taskId).lastRemindedAt, new Date(T).toISOString())
  assert.equal(b.overdueReminders({ at: T + 30 * 60_000 }).length, 0, '推迟后不再催')
  assert.equal(b.overdueReminders({ at: T + 62 * 60_000 }).length, 1)
})
t('第三次提醒后直接 block，不再返回第四次', () => {
  const b = make()
  const { task } = seed(b)
  remind(b, task.taskId, { level: 1, nextCheckAt: at(30) })
  remind(b, task.taskId, { level: 2, nextCheckAt: at(60) })
  const third = remind(b, task.taskId, { level: 3, nextCheckAt: at(90) })
  assert.equal(third.ok, true)
  assert.equal(b.get(task.taskId).overdueCount, 3)
  assert.equal(b.get(task.taskId).status, 'blocked')
  assert.match(b.get(task.taskId).blockedWhy, /连续多次逾期/)
  assert.equal(b.overdueReminders({ at: T + 200 * 60_000 }).length, 0)

  const fourth = remind(b, task.taskId, { level: 4, nextCheckAt: at(120) })
  assert.equal(fourth.ok, false)
  assert.match(fourth.why, /不再自动提醒/)
  assert.equal(b.get(task.taskId).overdueCount, 3)
  assert.equal(b.get(task.taskId).lastRemindedAt, new Date(T).toISOString())
})
t('blocked 任务收到新入站：保留 blocked、记下新消息，但不重开催办', () => {
  const b = make()
  const { task } = seed(b)
  remind(b, task.taskId, { level: 1, nextCheckAt: at(30) })
  b.block(task.taskId, { why: '等人工处理', at: at(31) })
  const r = b.create({
    chatId: 'c1', chatName: '测试群A', inboundMsgId: 'm_blocked_new',
    text: '补充一句', at: at(40),
  })
  assert.equal(r.ok, true)
  assert.equal(r.added, true)
  const now = b.get(task.taskId)
  assert.equal(now.status, 'blocked')
  assert.equal(now.inboundCount, 2)
  assert.equal(now.lastText, '补充一句')
  assert.equal(now.overdueCount, 0)
  assert.equal(now.lastRemindedAt, '')
  assert.equal(b.overdueReminders({ at: T + 60 * 60_000 }).length, 0)

  const reopened = b.unblock(task.taskId, { at: at(61) })
  assert.equal(reopened.ok, true)
  assert.equal(b.get(task.taskId).status, 'new')
  assert.equal(b.get(task.taskId).lastText, '补充一句')
  assert.equal(b.get(task.taskId).nextCheckAt, at(76))
})
t('提醒缺少版本/计数前置条件时拒绝落盘', () => {
  const b = make()
  const { task } = seed(b)
  const r = b.markReminded(task.taskId, { level: 1, nextCheckAt: at(30) })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'precondition-required')
  assert.equal(b.get(task.taskId).overdueCount, 0)
})
t('旧提醒快照不能覆盖投递期间的新入站', () => {
  const b = make()
  const { task } = seed(b)
  const snapshot = b.get(task.taskId)
  const inbound = b.create({ chatId: 'c1', inboundMsgId: 'm_race', text: '新消息', at: at(1) })
  assert.equal(inbound.ok, true)
  const r = b.markReminded(task.taskId, {
    level: 1,
    nextCheckAt: at(30),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'stale')
  const now = b.get(task.taskId)
  assert.equal(now.overdueCount, 0)
  assert.equal(now.lastRemindedAt, '')
  assert.equal(now.lastText, '新消息')
})
t('旧快照 block 返回 stale，状态和版本都不变', () => {
  const b = make()
  const { task } = seed(b)
  const staleSnapshot = b.get(task.taskId)
  b.create({ chatId: 'c1', inboundMsgId: 'm_block_race', text: '新消息', at: at(1) })
  const before = b.get(task.taskId)

  const r = b.block(task.taskId, {
    why: '旧快照的最终 block',
    expectedVersion: staleSnapshot.version,
    expectedOverdueCount: staleSnapshot.overdueCount,
    at: at(2),
  })

  assert.equal(r.ok, false)
  assert.equal(r.code, 'stale')
  assert.deepEqual(b.get(task.taskId), before)
})
t('提醒落盘失败时返回失败，失败期间状态不变，恢复后可重试', () => {
  const filePath = file()
  let failWrites = false
  const b = createTaskBoard({
    file: filePath,
    now: () => T,
    log: () => {},
    append: (...args) => {
      if (failWrites) throw new Error('disk full')
      return appendFileSync(...args)
    },
  })
  const { task } = seed(b)
  const snapshot = b.get(task.taskId)
  failWrites = true
  const failed = b.markReminded(task.taskId, {
    level: 1,
    nextCheckAt: at(30),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'persistence')
  assert.equal(b.get(task.taskId).overdueCount, 0)
  assert.equal(b.get(task.taskId).lastRemindedAt, '')

  failWrites = false
  const retried = b.markReminded(task.taskId, {
    level: 1,
    nextCheckAt: at(30),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  })
  assert.equal(retried.ok, true)
  assert.equal(b.get(task.taskId).overdueCount, 1)
})
t('第三次提醒和 block 一次落盘，不再依赖第二次 block 写盘', () => {
  const filePath = file()
  const records = []
  const b = createTaskBoard({
    file: filePath,
    now: () => T,
    log: () => {},
    append: (target, data, opts) => {
      const rec = JSON.parse(data)
      records.push(rec)
      if (rec.type === 'block') throw new Error('block write failed')
      return appendFileSync(target, data, opts)
    },
  })
  const { task } = seed(b)
  let snapshot = b.get(task.taskId)
  assert.equal(b.markReminded(task.taskId, {
    level: 1,
    nextCheckAt: at(30),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  }).ok, true)
  snapshot = b.get(task.taskId)
  assert.equal(b.markReminded(task.taskId, {
    level: 2,
    nextCheckAt: at(60),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  }).ok, true)
  snapshot = b.get(task.taskId)
  const third = b.markReminded(task.taskId, {
    level: 3,
    nextCheckAt: at(90),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  })
  assert.equal(third.ok, true)
  assert.equal(third.task.status, 'blocked')
  assert.equal(records.filter((r) => r.type === 'block').length, 0)
})
t('blocked / done 不催；对方又说话会重置提醒计数', () => {
  const b = make()
  const a = seed(b)
  b.block(a.task.taskId, { why: '等人工', at: at(1) })
  assert.equal(b.overdueReminders({ at: T + 60 * 60_000 }).length, 0)
  b.unblock(a.task.taskId, { at: at(2) })
  remind(b, a.task.taskId, { level: 2, nextCheckAt: at(3) })
  assert.equal(b.get(a.task.taskId).overdueCount, 2)
  b.create({ chatId: 'c1', inboundMsgId: 'm5', text: '我又来了', at: at(4) })
  assert.equal(b.get(a.task.taskId).overdueCount, 0)
  assert.equal(b.get(a.task.taskId).lastRemindedAt, '')
})
t('摘要里用世界声说还搁着', () => {
  const b = make()
  seed(b)
  assert.match(b.summary({ at: T + 16 * 60_000 }), /还搁着/)
  assert.doesNotMatch(b.summary({ at: T + 5 * 60_000 }), /还搁着/)
})

console.log('持久化')
t('重放同一 reply msgId 的两条旧记录也只算一次', () => {
  const f = file()
  const events = [
    { v: 1, type: 'create', taskId: 't_replay', chatId: 'c1', chatName: '测试群A', at: at(0) },
    { v: 1, type: 'reply', taskId: 't_replay', msgId: 'out1', at: at(1) },
    { v: 1, type: 'reply', taskId: 't_replay', msgId: 'out1', at: at(2) },
    { v: 1, type: 'reply', taskId: 't_replay', msgId: '', at: at(3) },
  ]
  writeFileSync(f, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  const board = createTaskBoard({ file: f, now: () => T, log: () => {} })
  assert.equal(board.get('t_replay').replyCount, 1)
  assert.deepEqual(board.get('t_replay').outboundMsgIds, ['out1'])
  assert.equal(board.get('t_replay').updatedAt, at(1), '重复回执不能推进 updatedAt')
})

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
