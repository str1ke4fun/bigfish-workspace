// 逾期泵：node --test test-overdue.mjs
// 只测任务板与投递编排，不启动微信。
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createTaskBoard,
  overdueVisibilityEnabled,
} from './lib/tasks.js'
import {
  createReminderBackoff,
  runOverdueReminderPass,
} from './lib/overdue.js'

const T = Date.UTC(2026, 10, 3, 4, 0, 0)
const at = (min) => new Date(T + min * 60_000).toISOString()
const file = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-overdue-')), 'tasks.jsonl')
const seed = (board) => board.create({
  chatId: 'c1',
  chatName: '测试群A',
  requester: { name: '甲', kind: 'group-member', confidence: 'high' },
  reason: '@',
  inboundMsgId: 'm1',
  text: '@你 在吗',
  at: at(0),
})

test('开关缺省开启，显式 false 才回滚', () => {
  assert.equal(overdueVisibilityEnabled({}), true)
  assert.equal(overdueVisibilityEnabled({ overdueVisibility: true }), true)
  assert.equal(overdueVisibilityEnabled({ overdueVisibility: false }), false)
})

test('投递期间的新入站让旧提醒变成 stale，不覆盖新计数', async () => {
  const board = createTaskBoard({ file: file(), now: () => T, log: () => {} })
  const { task } = seed(board)
  let deliveries = 0
  const result = await runOverdueReminderPass({
    board,
    at: T + 16 * 60_000,
    deliver: async () => {
      deliveries += 1
      board.create({ chatId: 'c1', inboundMsgId: 'm_race', text: '新消息', at: at(16) })
      return '测试群A'
    },
    nextCheckAt: () => at(60),
  })
  assert.equal(deliveries, 1)
  assert.equal(result.stale, 1)
  assert.equal(board.get(task.taskId).overdueCount, 0)
  assert.equal(board.get(task.taskId).lastRemindedAt, '')
  assert.equal(board.get(task.taskId).lastText, '新消息')
})

test('deliver 返回 ok:false 时不记已投递，也不推进逾期计数', async () => {
  const board = createTaskBoard({ file: file(), now: () => T, log: () => {} })
  const { task } = seed(board)
  let deliveries = 0
  const result = await runOverdueReminderPass({
    board,
    at: T + 16 * 60_000,
    deliver: async () => {
      deliveries += 1
      return { ok: false, code: 'WX_WINDOW_UNAVAILABLE', message: '[没看清]' }
    },
    nextCheckAt: () => at(60),
  })
  assert.equal(deliveries, 1)
  assert.equal(result.delivered, 0)
  assert.equal(result.failed, 1)
  assert.equal(board.get(task.taskId).overdueCount, 0)
  assert.equal(board.get(task.taskId).lastRemindedAt, '')
})

test('落盘失败后进入退避，不再重复投递；恢复后才继续', async () => {
  const target = file()
  let failWrites = false
  let probeOk = true
  const board = createTaskBoard({
    file: target,
    now: () => T,
    log: () => {},
    append: (...args) => {
      if (failWrites) throw new Error('disk full')
      return appendFileSync(...args)
    },
    probe: () => probeOk,
  })
  const { task } = seed(board)
  const backoff = createReminderBackoff({ baseMs: 5 * 60_000, maxMs: 5 * 60_000 })
  let deliveries = 0
  const deliver = async () => { deliveries += 1; return '测试群A' }
  const opts = {
    board,
    backoff,
    deliver,
    nextCheckAt: () => at(60),
  }

  failWrites = true
  const first = await runOverdueReminderPass({ ...opts, at: T + 16 * 60_000 })
  assert.equal(first.delivered, 1)
  assert.equal(first.failed, 1)
  assert.equal(board.get(task.taskId).overdueCount, 0)

  probeOk = false
  const duringBackoff = await runOverdueReminderPass({ ...opts, at: T + 17 * 60_000 })
  assert.equal(duringBackoff.delivered, 0)
  assert.equal(deliveries, 1)

  const stillDown = await runOverdueReminderPass({ ...opts, at: T + 30 * 60_000 })
  assert.equal(stillDown.delivered, 0)
  assert.equal(deliveries, 1)

  failWrites = false
  probeOk = true
  const recovered = await runOverdueReminderPass({ ...opts, at: T + 40 * 60_000 })
  assert.equal(recovered.delivered, 1)
  assert.equal(deliveries, 2)
  assert.equal(board.get(task.taskId).overdueCount, 1)
})

test('探测可写不等于落盘成功，连续 append 失败仍累加退避', async () => {
  const target = file()
  let failWrites = false
  const board = createTaskBoard({
    file: target,
    now: () => T,
    log: () => {},
    append: (dest, data, opts) => {
      if (failWrites) throw new Error('disk full')
      return appendFileSync(dest, data, opts)
    },
    probe: () => true,
  })
  const { task } = seed(board)
  const backoff = createReminderBackoff({ baseMs: 5 * 60_000, maxMs: 20 * 60_000 })
  let deliveries = 0
  const opts = {
    board,
    backoff,
    deliver: async () => { deliveries += 1; return '测试群A' },
    nextCheckAt: () => at(60),
  }

  failWrites = true
  const first = await runOverdueReminderPass({ ...opts, at: T + 16 * 60_000 })
  assert.equal(first.failed, 1)
  assert.equal(backoff.get(task.taskId).attempts, 1)

  const second = await runOverdueReminderPass({ ...opts, at: T + 17 * 60_000 })
  assert.equal(second.failed, 1)
  assert.equal(backoff.get(task.taskId).attempts, 2)

  const third = await runOverdueReminderPass({ ...opts, at: T + 18 * 60_000 })
  assert.equal(third.failed, 1)
  assert.deepEqual(backoff.get(task.taskId), {
    attempts: 3,
    until: T + 38 * 60_000,
  })
  assert.equal(deliveries, 3)
})

test('回滚路径的最终 block 写失败会在下一轮补上，不重投第三次提醒', async () => {
  const target = file()
  let failBlock = false
  const board = createTaskBoard({
    file: target,
    now: () => T,
    log: () => {},
    append: (dest, data, opts) => {
      const rec = JSON.parse(data)
      if (failBlock && rec.type === 'block') throw new Error('block disk full')
      return appendFileSync(dest, data, opts)
    },
    probe: () => true,
  })
  const { task } = seed(board)
  let snapshot = board.get(task.taskId)
  assert.equal(board.markReminded(task.taskId, {
    level: 1,
    nextCheckAt: at(30),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  }).ok, true)
  snapshot = board.get(task.taskId)
  assert.equal(board.markReminded(task.taskId, {
    level: 2,
    nextCheckAt: at(60),
    expectedVersion: snapshot.version,
    expectedOverdueCount: snapshot.overdueCount,
  }).ok, true)

  let deliveries = 0
  const deliver = async () => { deliveries += 1; return '测试群A' }
  const backoff = createReminderBackoff({ baseMs: 5 * 60_000, maxMs: 5 * 60_000 })
  failBlock = true
  const partial = await runOverdueReminderPass({
    board,
    at: T + 61 * 60_000,
    finalBlock: false,
    backoff,
    deliver,
    nextCheckAt: () => at(120),
  })
  assert.equal(partial.delivered, 1)
  assert.equal(partial.failed, 1)
  assert.equal(deliveries, 1)
  assert.equal(board.get(task.taskId).status, 'new')
  assert.equal(board.get(task.taskId).overdueCount, 3)

  failBlock = false
  const repaired = await runOverdueReminderPass({
    board,
    at: T + 70 * 60_000,
    finalBlock: false,
    backoff,
    deliver,
    nextCheckAt: () => at(120),
  })
  assert.equal(repaired.delivered, 0)
  assert.equal(repaired.repaired, 1)
  assert.equal(deliveries, 1)
  assert.equal(board.get(task.taskId).status, 'blocked')
  assert.match(board.get(task.taskId).blockedWhy, /连续多次逾期/)
})
