import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browseBudget, scheduledAtFrom, RESERVE_GRACE_MS } from '../lib/browsejob.js'

const DK = '2026-11-13'
const T0 = Date.parse('2026-11-13T17:38:00.000Z')
const cfg = { browse: { perDay: 3 }, wakesPerDay: 2, daily: { events: 3 } }
const sched = (at) => ({ type: 'meta', text: `sched:${DK} ${new Date(at).toISOString()}` })
const wake = () => ({ type: 'meta', text: `wake:${DK} test_first` })

test('scheduledAtFrom 解析 sched:<dk> <ISO>', () => {
  assert.equal(scheduledAtFrom([sched(T0)], DK), T0)
  assert.equal(scheduledAtFrom([], DK), 0)
})

test('唤醒点前、wake=0 → reserve=2、free=1', () => {
  const b = browseBudget(cfg, [sched(T0)], DK, { now: T0 - 60_000 })
  assert.deepEqual({ reserve: b.reserve, free: b.free }, { reserve: 2, free: 1 })
})

test('唤醒点后 10 分钟、wake=0 → 仍预留', () => {
  const b = browseBudget(cfg, [sched(T0)], DK, { now: T0 + 10 * 60_000 })
  assert.deepEqual({ reserve: b.reserve, free: b.free }, { reserve: 2, free: 1 })
})

test('唤醒点后 40 分钟、wake=0 → 释放 reserve', () => {
  const b = browseBudget(cfg, [sched(T0)], DK, { now: T0 + 40 * 60_000 })
  assert.deepEqual({ reserve: b.reserve, free: b.free }, { reserve: 0, free: 3 })
})

test('唤醒点后 40 分钟、wake=1 → 继续为剩余唤醒预留', () => {
  const b = browseBudget(cfg, [sched(T0), wake()], DK, { now: T0 + 40 * 60_000 })
  assert.deepEqual({ reserve: b.reserve, free: b.free }, { reserve: 1, free: 2 })
})

test('没有 sched 退回旧行为；宽限期常量是 30 分钟', () => {
  const b = browseBudget(cfg, [wake()], DK, { now: T0 + 40 * 60_000 })
  assert.equal(b.reserve, 1)
  assert.equal(RESERVE_GRACE_MS, 30 * 60_000)
})
