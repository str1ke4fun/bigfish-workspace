import test from 'node:test'
import assert from 'node:assert/strict'
import { localDateKey, normalizeSpeechPolicy, normalizeWxProactive, wxSpeakingState } from '../server.mjs'

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
    { proactivePerDay: 3, proactiveChats: { 群A: 5 }, hardBreaker: 50 },
  )
  assert.deepEqual(
    normalizeWxProactive({ proactivePerDay: 99, proactiveChats: { 群A: 0, 群B: -2, 群C: 7 } }),
    { proactivePerDay: 50, proactiveChats: { 群A: 0, 群B: 0, 群C: 7 }, hardBreaker: 50 },
  )
})

test('主动额度：body 里没带就用 before，带空对象则清空', () => {
  assert.equal(normalizeWxProactive({}, { proactivePerDay: 4 }).proactivePerDay, 4)
  assert.deepEqual(normalizeWxProactive({ proactiveChats: {} }, { proactiveChats: { 群A: 5 } }).proactiveChats, {})
})

test('主动额度：兼容 softLimit 输入并保留/归一 hardBreaker', () => {
  assert.deepEqual(
    normalizeWxProactive({ softLimit: 4, hardBreaker: 99 }),
    { proactivePerDay: 4, proactiveChats: {}, hardBreaker: 50 },
  )
  assert.equal(normalizeWxProactive({}, { proactivePerDay: 3, hardBreaker: 12 }).hardBreaker, 12)
  assert.equal(normalizeWxProactive({ hardBreaker: -1 }).hardBreaker, 0)
})

test('微信状态卡：软上限后仍可主动，硬熔断才拦', () => {
  const now = new Date(2026, 10, 18, 10, 0, 0).getTime()
  const policy = {
    enabled: true,
    allowChats: ['群A'],
    noMentionChats: [],
    requireMention: true,
    mentionWindowMinutes: 3,
    proactivePerDay: 2,
    proactiveChats: {},
    hardBreaker: 4,
  }
  assert.equal(wxSpeakingState({ policy, current: '群A', used: 2, now }).ok, true)
  assert.match(wxSpeakingState({ policy, current: '群A', used: 2, now }).why, /软上限/)
  assert.equal(wxSpeakingState({ policy, current: '群A', used: 4, now }).ok, false)
  assert.match(wxSpeakingState({ policy, current: '群A', used: 4, now }).why, /熔断/)
  assert.equal(wxSpeakingState({ policy, current: '群A', used: 0, now, lastMention: now }).ok, true)
  assert.equal(wxSpeakingState({
    policy: { ...policy, proactivePerDay: 0 },
    current: '群A',
    used: 0,
    now,
  }).ok, false)
})

test('微信状态卡：主动账本读不出时失败关闭，免 @ 路径仍可展示', () => {
  const now = new Date(2026, 10, 18, 10, 0, 0).getTime()
  const policy = {
    enabled: true,
    allowChats: ['群A'],
    noMentionChats: ['私聊B'],
    requireMention: true,
    mentionWindowMinutes: 3,
    proactivePerDay: 3,
    proactiveChats: {},
    hardBreaker: 10,
  }
  assert.equal(wxSpeakingState({ policy, current: '群A', used: 0, stateOk: false, now }).ok, false)
  assert.match(wxSpeakingState({ policy, current: '群A', used: 0, stateOk: false, now }).why, /状态/)
  assert.equal(wxSpeakingState({ policy, current: '私聊B', stateOk: false, now }).ok, true)
})

test('localDateKey 用本地日期', () => {
  assert.equal(localDateKey(new Date(2026, 10, 13, 23, 59).getTime()), '2026-11-13')
  assert.equal(localDateKey(new Date(2026, 10, 14, 0, 1).getTime()), '2026-11-14')
})
