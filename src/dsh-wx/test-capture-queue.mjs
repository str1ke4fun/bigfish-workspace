// 采集队列（冷却、去重、上限、退避）：node --test test-capture-queue.mjs
// 只测纯函数；不启动微信、不读屏、不写台账。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createCaptureQueue } from './lib/capture-queue.js'

test('brief 场景：冷却、去重、上限与退避', () => {
  let t = 1000
  const q = createCaptureQueue({ now: () => t, queueMax: 2, cooldownMs: 60_000 })

  assert.equal(q.offer({ chat: 'A', reason: 'changed' }), true)
  assert.equal(q.due(t).chat, 'A')
  assert.equal(q.offer({ chat: 'A', reason: 'unread', unread: 2 }), false) // 同一会话不重复入队
  assert.equal(q.size(), 1)
  assert.equal(q.jobs()[0].reason, 'unread')
  assert.equal(q.jobs()[0].unread, 2)

  q.done('A') // 删除 job，lastDoneAt('A')=1000
  assert.equal(q.lastDoneAt('A'), 1000)
  assert.equal(q.offer({ chat: 'A' }), true) // 冷却期内的更新不丢，排到冷却结束
  assert.equal(q.due(t + 59_000), null)
  assert.equal(q.due(t + 60_000).chat, 'A')
  q.done('A')

  q.offer({ chat: 'B' }); q.offer({ chat: 'C' }); q.offer({ chat: 'D' })
  assert.equal(q.size(), 2) // queueMax=2，丢最早入队的 B
  assert.equal(q.jobs().map((j) => j.chat).join(','), 'C,D')

  t = 200_000
  q.done('D')
  q.fail('C', { backoffMs: 120_000 })
  assert.equal(q.lastDoneAt('C'), 0) // 失败不算成功完成
  q.offer({ chat: 'C' })
  assert.equal(q.due(200_001), null) // 退避期内不取
  assert.equal(q.due(320_000).chat, 'C')
})

test('空队列：due 返回 null，jobs 为空，未知会话 lastDoneAt 为 0', () => {
  const q = createCaptureQueue({ now: () => 1000 })
  assert.equal(q.due(), null)
  assert.equal(q.size(), 0)
  assert.deepEqual(q.jobs(), [])
  assert.equal(q.lastDoneAt('不存在'), 0)
})

test('due 不消费：重复调用返回同一个 job，仍留在队列', () => {
  const q = createCaptureQueue({ now: () => 1000, queueMax: 10, cooldownMs: 0 })
  q.offer({ chat: 'A', reason: 'changed' })
  const first = q.due(1000)
  const second = q.due(1000)
  assert.equal(first.chat, 'A')
  assert.equal(second.chat, 'A')
  assert.equal(q.size(), 1)
  assert.equal(q.due(1000).tries, second.tries + 1) // 每次取出记一次尝试
})

test('jobs 返回副本：外部修改不影响内部状态', () => {
  const q = createCaptureQueue({ now: () => 1000, queueMax: 10, cooldownMs: 0 })
  q.offer({ chat: 'A', reason: 'changed', unread: 1 })
  const list = q.jobs()
  list[0].chat = '被改'
  list.push({ chat: '伪造' })
  list.length = 0
  assert.deepEqual(q.jobs().map((j) => j.chat), ['A'])
  assert.equal(q.size(), 1)
})

test('显式 dueAt 生效，早于到期时间不取', () => {
  const q = createCaptureQueue({ now: () => 1000, queueMax: 10, cooldownMs: 0 })
  q.offer({ chat: 'A', dueAt: 5000 })
  assert.equal(q.due(4999), null)
  assert.equal(q.due(5000).chat, 'A')
})

test('fail 缺省退避 120000；退避后再 offer 不叠加冷却', () => {
  const t = 1000
  const q = createCaptureQueue({ now: () => t, queueMax: 10, cooldownMs: 60_000 })
  q.offer({ chat: 'A' })
  q.fail('A')
  assert.equal(q.lastDoneAt('A'), 0)
  assert.equal(q.offer({ chat: 'A' }), true)
  assert.equal(q.due(120_999), null)
  assert.equal(q.due(121_000).chat, 'A') // 120s 可重试，不是 180s
})

test('冷却期内变化入队后，别的设备读了也不再丢这次采集', () => {
  let t = 0
  const q = createCaptureQueue({ now: () => t, queueMax: 10, cooldownMs: 60_000 })
  q.done('A') // 上次成功完成在 t=0
  t = 10_000
  // 有变化：shouldEnqueue 给出 dueAt = 0 + 60_000。
  assert.equal(q.offer({ chat: 'A', reason: 'cooldown', unread: 2, dueAt: 60_000 }), true)
  t = 20_000
  // 别的设备读完了，未读归零、指纹不再变化；这一轮没有新信号，但队列里的 job 还在。
  assert.equal(q.due(59_999), null)
  assert.equal(q.due(60_000).chat, 'A')
})

test('clear 清空队列与冷却/退避记录', () => {
  const q = createCaptureQueue({ now: () => 1000, queueMax: 10, cooldownMs: 60_000 })
  q.offer({ chat: 'A' })
  q.done('A')
  q.offer({ chat: 'B' })
  q.clear()
  assert.equal(q.size(), 0)
  assert.deepEqual(q.jobs(), [])
  assert.equal(q.lastDoneAt('A'), 0)
  assert.equal(q.offer({ chat: 'B' }), true) // 清空后不再受冷却影响
})

test('空会话名不进入队列', () => {
  const q = createCaptureQueue({ now: () => 1000, queueMax: 10, cooldownMs: 0 })
  assert.equal(q.offer({ chat: '' }), false)
  assert.equal(q.offer({ chat: '   ' }), false)
  assert.equal(q.offer({}), false)
  assert.equal(q.size(), 0)
})
