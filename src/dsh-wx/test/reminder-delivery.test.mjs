import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  createPermitStore,
  createReminderDeliveryWorker,
  createReminderJobStore,
  mechanicalReminderDeliveryEnabled,
  pressReturnThenMark,
  PERMIT_TTL_MS,
} from '../lib/reminder.js'

const T = Date.UTC(2026, 10, 18, 4, 0, 0)
const temp = () => mkdtempSync(join(tmpdir(), 'dsh-wx-reminder-job-'))

test('机械提醒开关：缺省开启，只有显式 false 回滚到旧宿主调度', () => {
  assert.equal(mechanicalReminderDeliveryEnabled({}), true)
  assert.equal(mechanicalReminderDeliveryEnabled({ mechanicalReminderDelivery: true }), true)
  assert.equal(mechanicalReminderDeliveryEnabled({ mechanicalReminderDelivery: false }), false)
})

test('Return 标记只在回车之后写；标记写失败也不能当成还没回车', async () => {
  const order = []
  const ok = await pressReturnThenMark({
    pressReturn: async () => { order.push('return') },
    onReturn: async () => { order.push('mark'); throw new Error('disk full') },
    log: () => {},
  })
  assert.deepEqual(order, ['return', 'mark'])
  assert.equal(ok.returned, true)
  assert.equal(ok.marked, false)
})

test('提醒任务：到点前不领，到点后只领一次，重启仍能重放', () => {
  const file = join(temp(), 'reminder-jobs.jsonl')
  const store = createReminderJobStore({ file, now: () => T, log: () => {} })
  const created = store.create({
    id: 'rem-0001',
    permit: 'permit-0001',
    sessionId: 'session-wx',
    chat: '测试群A',
    text: '到点了，喝水',
    dueAt: T + 60_000,
  })

  assert.equal(created.ok, true)
  assert.deepEqual(
    {
      id: created.job.id,
      chat: created.job.chat,
      text: created.job.text,
      permit: created.job.permit,
      dueAt: created.job.dueAt,
      attempt: created.job.attempt,
      result: created.job.result,
    },
    {
      id: 'rem-0001',
      chat: '测试群A',
      text: '到点了，喝水',
      permit: 'permit-0001',
      dueAt: T + 60_000,
      attempt: 0,
      result: 'pending',
    },
  )

  assert.deepEqual(store.claimDue({ now: T }), [])
  const first = store.claimDue({ now: T + 60_000 })
  assert.equal(first.length, 1)
  assert.equal(first[0].attempt, 1)
  assert.equal(first[0].result, 'attempting')
  assert.deepEqual(store.claimDue({ now: T + 120_000 }), [], '同一条任务不能领两次')

  const reloaded = createReminderJobStore({ file, now: () => T + 120_000, log: () => {} })
  const [job] = reloaded.list()
  assert.equal(job.id, 'rem-0001')
  assert.equal(job.attempt, 1)
  assert.equal(job.result, 'attempting')
})

function runtimeFixture({ enabled = true, sendReminder } = {}) {
  const dir = temp()
  const jobs = createReminderJobStore({ file: join(dir, 'reminder-jobs.jsonl'), now: () => T, log: () => {} })
  const permits = createPermitStore({ file: join(dir, 'reminder-permits.json'), now: () => T, log: () => {} })
  const calls = []
  const worker = createReminderDeliveryWorker({
    jobs,
    permits,
    getEnabled: () => enabled,
    now: () => T,
    log: () => {},
    sendReminder: async (req) => {
      calls.push(req)
      return sendReminder(req)
    },
  })
  return { dir, jobs, permits, worker, calls }
}

test('机械投递：未确认也终态，重复 tick 不重发；世界声不含任务原文', async () => {
  let calls = 0
  const { jobs, worker } = runtimeFixture({
    sendReminder: async (req) => {
      calls += 1
      await req.onReturn()
      return { sent: 'unconfirmed' }
    },
  })
  assert.equal(worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 }).ok, true)

  const first = await worker.deliverDue({ now: T + 60_000 })
  assert.equal(first.processed, 1)
  assert.equal(calls, 1)
  assert.equal(jobs.list()[0].result, 'unconfirmed')
  await worker.deliverDue({ now: T + 120_000 })
  assert.equal(calls, 1, 'Return 之后就算未确认也不能重发')

  const notices = worker.takeNotices({ at: T + 120_000 })
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /没看清|可能|别再补发/)
  assert.doesNotMatch(notices[0].text, /测试群A|到点了，喝水|permit-|rem-/)
  assert.deepEqual(worker.takeNotices({ at: T + 180_000 }), [], '世界声只交下一次')
})

test('机械投递：按下 Return 后抛错只记 unknown，不重发', async () => {
  let calls = 0
  const { jobs, worker } = runtimeFixture({
    sendReminder: async (req) => {
      calls += 1
      await req.onReturn()
      throw new Error('post-return timeout')
    },
  })
  worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  await worker.deliverDue({ now: T + 60_000 })
  assert.equal(jobs.list()[0].result, 'unknown')
  await worker.deliverDue({ now: T + 120_000 })
  assert.equal(calls, 1)
})

test('机械投递：Return 前失败记 failed，并由下一次唤醒拿到一次世界声', async () => {
  let calls = 0
  const { jobs, permits, worker } = runtimeFixture({
    sendReminder: async () => {
      calls += 1
      throw new Error('window busy')
    },
  })
  worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  await worker.deliverDue({ now: T + 60_000 })
  assert.equal(jobs.list()[0].result, 'failed')
  assert.equal(calls, 1)
  assert.equal(permits.check({ id: jobs.list()[0].permit, chat: '测试群A', text: '到点了，喝水' }).ok, false)
  const notices = worker.takeNotices({ at: T + 90_000 })
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /没发出去/)
  assert.doesNotMatch(notices[0].text, /测试群A|到点了，喝水|permit-|rem-/)
})

test('机械投递：sendReminder 返回 ok:false 时按失败终态结算，不再读取 sent', async () => {
  const { jobs, permits, worker } = runtimeFixture({
    sendReminder: async () => ({ ok: false, code: 'WX_TREE_STALE', message: '[没看清]' }),
  })
  const created = worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  assert.equal(created.ok, true)
  await worker.deliverDue({ now: T + 60_000 })
  assert.equal(jobs.list()[0].result, 'failed')
  assert.equal(permits.check({ id: jobs.list()[0].permit, chat: '测试群A', text: '到点了，喝水' }).ok, false)
  assert.match(worker.takeNotices()[0].text, /没发出去/)
})

test('重启恢复：上次已领取但没结果的提醒记 unknown，不再发送', async () => {
  const dir = temp()
  const file = join(dir, 'reminder-jobs.jsonl')
  const permitFile = join(dir, 'reminder-permits.json')
  const before = createReminderJobStore({ file, now: () => T, log: () => {} })
  const permits = createPermitStore({ file: permitFile, now: () => T, log: () => {} })
  assert.equal(permits.grant({ id: 'permit-0002', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 }).ok, true)
  before.create({ id: 'rem-0002', permit: 'permit-0002', sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  assert.equal(before.claimDue({ now: T + 60_000 }).length, 1)

  const after = createReminderJobStore({ file, now: () => T + 120_000, log: () => {} })
  let calls = 0
  const worker = createReminderDeliveryWorker({
    jobs: after,
    permits,
    getEnabled: () => true,
    now: () => T + 120_000,
    log: () => {},
    sendReminder: async () => { calls += 1; return { sent: 'confirmed' } },
  })
  worker.recover()
  assert.equal(after.list()[0].result, 'unknown')
  assert.equal(permits.check({ id: 'permit-0002', chat: '测试群A', text: '到点了，喝水' }).ok, false)
  await worker.deliverDue({ now: T + 120_000 })
  assert.equal(calls, 0)
  assert.match(worker.takeNotices()[0].text, /可能发出去了，也可能没有/)
})

test('撤销：取消后任务不再领取，许可也不能再用', async () => {
  const { jobs, permits, worker, calls } = runtimeFixture({
    sendReminder: async () => ({ sent: 'confirmed' }),
  })
  const created = worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  assert.equal(created.ok, true)
  const permit = jobs.list()[0].permit
  assert.equal(worker.cancel(created.job.id, { sessionId: 'session-wx' }).ok, true)
  assert.equal(jobs.list()[0].result, 'revoked')
  assert.equal(permits.check({ id: permit, chat: '测试群A', text: '到点了，喝水' }).ok, false)
  await worker.deliverDue({ now: T + 60_000 })
  assert.equal(calls.length, 0)
})

test('功能开关关闭：不新建、不领取、不投递，任务保持在盘上等回滚', async () => {
  let enabled = false
  let calls = 0
  const dir = temp()
  const jobs = createReminderJobStore({ file: join(dir, 'reminder-jobs.jsonl'), now: () => T, log: () => {} })
  const permits = createPermitStore({ file: join(dir, 'reminder-permits.json'), now: () => T, log: () => {} })
  const worker = createReminderDeliveryWorker({
    jobs,
    permits,
    getEnabled: () => enabled,
    now: () => T,
    log: () => {},
    sendReminder: async () => { calls += 1; return { sent: 'confirmed' } },
  })
  assert.equal(worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 }).disabled, true)

  // 模拟开关从开启回滚到关闭时，已经落盘的任务不能被后台偷偷领取。
  enabled = true
  const created = worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  enabled = false
  assert.equal(created.ok, true)
  await worker.deliverDue({ now: T + 60_000 })
  assert.equal(calls, 0)
  assert.equal(jobs.list()[0].result, 'pending')
})

test('并发重复 tick 只发一次', async () => {
  let release
  let calls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const { worker } = runtimeFixture({
    sendReminder: async (req) => {
      calls += 1
      await gate
      await req.onReturn()
      return { sent: 'confirmed' }
    },
  })
  worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '到点了，喝水', dueAt: T + 60_000 })
  const first = worker.deliverDue({ now: T + 60_000 })
  const second = worker.deliverDue({ now: T + 60_000 })
  release()
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('逐条投递：每个任务前重读开关，首条成功后关闭就留下第二条', async () => {
  let enabled = true
  let calls = 0
  const dir = temp()
  const jobs = createReminderJobStore({ file: join(dir, 'reminder-jobs.jsonl'), now: () => T, log: () => {} })
  const permits = createPermitStore({ file: join(dir, 'reminder-permits.json'), now: () => T, log: () => {} })
  const worker = createReminderDeliveryWorker({
    jobs,
    permits,
    getEnabled: () => enabled,
    now: () => T,
    log: () => {},
    sendReminder: async (req) => {
      calls += 1
      enabled = false
      await req.onReturn()
      return { sent: 'confirmed' }
    },
  })
  worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '第一条', dueAt: T + 60_000 })
  worker.create({ sessionId: 'session-wx', chat: '测试群A', text: '第二条', dueAt: T + 60_000 })

  const result = await worker.deliverDue({ now: T + 60_000 })
  assert.equal(result.processed, 1)
  assert.equal(calls, 1)
  const results = jobs.list().map((job) => job.result).sort()
  assert.deepEqual(results, ['confirmed', 'pending'])
})

test('两任务重启：第一条结算后进程崩溃，第二条仍未领取并在重启后送达', async () => {
  const dir = temp()
  const file = join(dir, 'reminder-jobs.jsonl')
  const permitFile = join(dir, 'reminder-permits.json')
  const jobs = createReminderJobStore({ file, now: () => T, log: () => {} })
  const permits = createPermitStore({ file: permitFile, now: () => T, log: () => {} })
  for (const [id, text] of [['rem-crash-a', '第一条'], ['rem-crash-b', '第二条']]) {
    assert.equal(permits.grant({ id: `permit-${id}`, chat: '测试群A', text, dueAt: T + 60_000 }).ok, true)
    assert.equal(jobs.create({ id, permit: `permit-${id}`, sessionId: 'session-wx', chat: '测试群A', text, dueAt: T + 60_000 }).ok, true)
  }

  const moduleUrl = new URL('../lib/reminder.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createPermitStore, createReminderJobStore, createReminderDeliveryWorker } from ${JSON.stringify(moduleUrl)}
    const now = Number(process.env.TASK3_NOW)
    const jobs = createReminderJobStore({ file: process.env.TASK3_JOBS, now: () => now, log: () => {} })
    const settleThenCrash = {
      ...jobs,
      settle(id, result, opts) {
        const out = jobs.settle(id, result, opts)
        if (out.ok) process.exit(23)
        return out
      },
    }
    const worker = createReminderDeliveryWorker({
      jobs: settleThenCrash,
      permits: createPermitStore({ file: process.env.TASK3_PERMITS, now: () => now, log: () => {} }),
      getEnabled: () => true,
      now: () => now,
      log: () => {},
      sendReminder: async (req) => {
        console.log('sent:' + req.reminderId)
        await req.onReturn()
        return { sent: 'confirmed' }
      },
    })
    await worker.deliverDue({ now })
    process.exit(24)
  `], {
    env: { ...process.env, TASK3_JOBS: file, TASK3_PERMITS: permitFile, TASK3_NOW: String(T + 60_000) },
    encoding: 'utf8',
  })
  assert.equal(child.status, 23, child.stderr || child.stdout)

  const afterCrash = createReminderJobStore({ file, now: () => T + 60_000, log: () => {} })
  const crashed = Object.fromEntries(afterCrash.list().map((job) => [job.id, job.result]))
  assert.deepEqual(crashed, { 'rem-crash-a': 'confirmed', 'rem-crash-b': 'pending' })

  let calls = 0
  const restarted = createReminderDeliveryWorker({
    jobs: afterCrash,
    permits: createPermitStore({ file: permitFile, now: () => T + 60_000, log: () => {} }),
    getEnabled: () => true,
    now: () => T + 60_000,
    log: () => {},
    sendReminder: async (req) => {
      calls += 1
      await req.onReturn()
      return { sent: 'confirmed' }
    },
  })
  restarted.recover()
  await restarted.deliverDue({ now: T + 60_000 })
  assert.equal(calls, 1)
  assert.equal(afterCrash.get('rem-crash-b').result, 'confirmed')
})

test('过期许可：已领取的到期任务落为失败终态，重启后不再发', async () => {
  const dir = temp()
  const file = join(dir, 'reminder-jobs.jsonl')
  const at = T + 60_000 + PERMIT_TTL_MS + 1
  const jobs = createReminderJobStore({ file, now: () => T, log: () => {} })
  const permits = createPermitStore({ file: join(dir, 'reminder-permits.json'), now: () => T, log: () => {} })
  assert.equal(permits.grant({ id: 'permit-expired', chat: '测试群A', text: '到期了', dueAt: T + 60_000 }).ok, true)
  assert.equal(jobs.create({ id: 'rem-expired', permit: 'permit-expired', sessionId: 'session-wx', chat: '测试群A', text: '到期了', dueAt: T + 60_000 }).ok, true)

  let calls = 0
  const worker = createReminderDeliveryWorker({
    jobs,
    permits: createPermitStore({ file: join(dir, 'reminder-permits.json'), now: () => at, log: () => {} }),
    getEnabled: () => true,
    now: () => at,
    log: () => {},
    sendReminder: async () => { calls += 1; return { sent: 'confirmed' } },
  })
  await worker.deliverDue({ now: at })
  assert.equal(calls, 0)
  assert.equal(jobs.get('rem-expired').result, 'failed')

  const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(records.at(-1), {
    v: 1,
    type: 'result',
    id: 'rem-expired',
    result: 'failed',
    error: '没有这条提醒许可（可能已经用过、过期，或没存下来）。',
    at: new Date(at).toISOString(),
  })
  const reloaded = createReminderJobStore({ file, now: () => at, log: () => {} })
  assert.equal(reloaded.get('rem-expired').result, 'failed')
})

test('任务日志只追加：后续状态不会重写已有行', () => {
  const file = join(temp(), 'reminder-jobs.jsonl')
  const store = createReminderJobStore({ file, now: () => T, log: () => {} })
  store.create({ id: 'rem-0001', permit: 'permit-0001', sessionId: 's', chat: '测试群A', text: '喝水', dueAt: T + 60_000 })
  const before = readFileSync(file, 'utf8')
  store.create({ id: 'rem-0002', permit: 'permit-0002', sessionId: 's', chat: '测试群B', text: '吃饭', dueAt: T + 120_000 })
  store.claimDue({ now: T + 120_000 })
  const after = readFileSync(file, 'utf8')
  assert.equal(after.startsWith(before), true)
})
