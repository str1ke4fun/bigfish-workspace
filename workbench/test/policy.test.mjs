import test from 'node:test'
import assert from 'node:assert/strict'
import { localDateKey, normalizeSpeechPolicy, normalizeWxProactive } from '../server.mjs'

test('speech 覆盖层：缺省 wx=8/4/40，QQ 仍是 base', () => {
  const p = normalizeSpeechPolicy({})
  assert.deepEqual(p.wx, { minGapSeconds: 8, maxPerMinute: 4, maxPerHour: 40 })
  assert.equal(p.minGapSeconds, 25)
  assert.equal(p.maxPerMinute, 2)
  assert.equal(p.maxPerHour, 15)
})

test('speech 覆盖层：自定义 wx 只改微信，离谱值落回上下限', () => {
  const p = normalizeSpeechPolicy({ wx: { minGapSeconds: 2, maxPerMinute: 9999, maxPerHour: 99999 } })
  assert.equal(p.wx.minGapSeconds, 2)
  assert.equal(p.wx.maxPerMinute, 1000)
  assert.equal(p.wx.maxPerHour, 10000)
  assert.equal(p.minGapSeconds, 25)
})

test('主动额度：缺省保留旧值、clamp 0..50、显式 0 保留', () => {
  assert.deepEqual(
    normalizeWxProactive({}, { proactivePerDay: 3, proactiveChats: { 群A: 5 } }),
    { proactivePerDay: 3, proactiveChats: { 群A: 5 } },
  )
  assert.deepEqual(
    normalizeWxProactive({ proactivePerDay: 99, proactiveChats: { 群A: 0, 群B: -2, 群C: 7 } }),
    { proactivePerDay: 50, proactiveChats: { 群A: 0, 群B: 0, 群C: 7 } },
  )
})

test('主动额度：body 里没带就用 before，带空对象则清空', () => {
  assert.equal(normalizeWxProactive({}, { proactivePerDay: 4 }).proactivePerDay, 4)
  assert.deepEqual(normalizeWxProactive({ proactiveChats: {} }, { proactiveChats: { 群A: 5 } }).proactiveChats, {})
})

test('localDateKey 用本地日期', () => {
  assert.equal(localDateKey(new Date(2026, 10, 13, 23, 59).getTime()), '2026-11-13')
  assert.equal(localDateKey(new Date(2026, 10, 14, 0, 1).getTime()), '2026-11-14')
})
