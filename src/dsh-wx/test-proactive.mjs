// 每群主动额度：纯账本 + 闸门判定。不连微信。
// 跑：node --test test-proactive.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_PER_DAY,
  consume,
  dateKey,
  decideProactive,
  loadState,
  normalizeProactive,
  parseQuota,
  quotaFor,
  remaining,
  saveState,
  softLimitFor,
} from './lib/proactive.js'

const dir = mkdtempSync(join(tmpdir(), 'proactive-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime()
const TODAY = '2026-11-13'

test('dateKey 用本地日期', () => {
  assert.equal(dateKey(NOW), TODAY)
  assert.equal(dateKey(new Date(2026, 10, 13, 23, 59).getTime()), TODAY)
})

test('parseQuota 把离谱值收进 0..50', () => {
  assert.equal(parseQuota(-1), 0)
  assert.equal(parseQuota('abc'), 0)
  assert.equal(parseQuota(3.6), 4)
  assert.equal(parseQuota(999), MAX_PER_DAY)
})

test('quotaFor：群覆盖优先，否则用默认；0 也是有效覆盖', () => {
  assert.equal(quotaFor({ proactivePerDay: 2 }, '群B'), 2)
  assert.equal(quotaFor({ proactivePerDay: 2, proactiveChats: { 群A: 5 } }, '群A'), 5)
  assert.equal(quotaFor({ proactivePerDay: 2, proactiveChats: { 群A: 0 } }, '群A'), 0)
  assert.equal(softLimitFor({ softLimit: 4 }, '群B'), 4)
})

test('normalizeProactive：显式 0 必须保留，否则默认额度会漏进静音的群', () => {
  assert.deepEqual(
    normalizeProactive({ proactivePerDay: 5, proactiveChats: { 工作群: 0, 群A: 3 } }),
    { proactivePerDay: 5, proactiveChats: { 工作群: 0, 群A: 3 }, softLimit: 5, hardBreaker: MAX_PER_DAY },
  )
  assert.deepEqual(normalizeProactive({ proactiveChats: { '': 3, ' 群B ': 7 } }), {
    proactivePerDay: 0,
    proactiveChats: { 群B: 7 },
    softLimit: 0,
    hardBreaker: MAX_PER_DAY,
  })
})

test('normalizeProactive：旧键继续兼容，新键暴露 softLimit/hardBreaker', () => {
  assert.deepEqual(
    normalizeProactive({ softLimit: 3, hardBreaker: 12, proactiveChats: { 群A: 4, 工作群: 0 } }),
    { proactivePerDay: 3, proactiveChats: { 群A: 4, 工作群: 0 }, softLimit: 3, hardBreaker: 12 },
  )
  assert.deepEqual(
    normalizeProactive({ proactivePerDay: 5, proactiveChats: { 群A: 3 } }),
    { proactivePerDay: 5, proactiveChats: { 群A: 3 }, softLimit: 5, hardBreaker: MAX_PER_DAY },
  )
})

test('remaining 与 consume 是纯函数，跨天重置', () => {
  const state = { day: TODAY, used: { 群A: 2 } }
  assert.equal(remaining({ proactiveChats: { 群A: 5 } }, state, '群A', TODAY), 3)
  const c = consume({ proactiveChats: { 群A: 5 } }, state, '群A', TODAY)
  assert.equal(c.left, 2)
  assert.equal(c.state.used['群A'], 3)
  assert.equal(state.used['群A'], 2, 'consume 不能改传入的 state')
  assert.equal(remaining({ proactiveChats: { 群A: 5 } }, { day: '2000-01-01', used: { 群A: 5 } }, '群A', TODAY), 5)
  assert.equal(consume({ proactiveChats: { 群A: 0 } }, state, '群A', TODAY).left, 0)
})

test('consume：软上限之后仍记一条，直到硬熔断', () => {
  const policy = { proactiveChats: { 群A: 2 }, hardBreaker: 4 }
  const result = consume(policy, { day: TODAY, used: { 群A: 2 } }, '群A', TODAY)
  assert.equal(result.state.used['群A'], 3)
  assert.deepEqual(Object.keys(result.state).sort(), ['day', 'ok', 'used'])
  assert.equal(result.left, 0)
  assert.equal(result.overSoftLimit, true)
  assert.equal(result.atHardBreaker, false)
  const stopped = consume(policy, { day: TODAY, used: { 群A: 4 } }, '群A', TODAY)
  assert.equal(stopped.state.used['群A'], 4)
  assert.equal(stopped.atHardBreaker, true)
})

test('decideProactive：@ 窗口/免 @/不要求 @ 都不消耗额度', () => {
  const state = { day: TODAY, used: { 群A: 2 } }
  const policy = { requireMention: true, proactiveChats: { 群A: 5 } }
  assert.deepEqual(decideProactive({ policy, state, chat: '群A', mention: { ok: true }, exempt: false, now: NOW }), { ok: true, proactive: false, left: 3 })
  assert.deepEqual(decideProactive({ policy, state, chat: '群A', mention: { ok: false }, exempt: true, now: NOW }), { ok: true, proactive: false, left: 3 })
  assert.deepEqual(decideProactive({ policy: { ...policy, requireMention: false }, state, chat: '群A', mention: { ok: false }, exempt: false, now: NOW }), { ok: true, proactive: false, left: 3 })
})

test('decideProactive：没 @ 但有额度才主动；额度 0 必须拒绝', () => {
  const state = { day: TODAY, used: { 群A: 2 } }
  assert.deepEqual(
    decideProactive({ policy: { requireMention: true, proactiveChats: { 群A: 5 } }, state, chat: '群A', mention: { ok: false, reason: '最近没人 @ 你' }, exempt: false, now: NOW }),
    { ok: true, proactive: true, left: 3 },
  )
  const denied = decideProactive({ policy: { requireMention: true, proactiveChats: { 群A: 2 }, hardBreaker: 2 }, state, chat: '群A', mention: { ok: false, reason: '最近没人 @ 你' }, exempt: false, now: NOW })
  assert.equal(denied.ok, false)
  assert.equal(denied.left, 0)
  assert.match(denied.why, /熔断/)
})

test('decideProactive：超过软上限但未到硬熔断时仍允许，并标记审计', () => {
  const result = decideProactive({
    policy: {
      requireMention: true,
      proactiveChats: { 群A: 2 },
      hardBreaker: 5,
    },
    state: { ok: true, day: TODAY, used: { 群A: 2 } },
    chat: '群A',
    mention: { ok: false, reason: '最近没人 @ 你' },
    exempt: false,
    now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.proactive, true)
  assert.equal(result.used, 2)
  assert.equal(result.softLimit, 2)
  assert.equal(result.hardBreaker, 5)
  assert.equal(result.overSoftLimit, true)
  assert.equal(result.atHardBreaker, false)
})

test('decideProactive：到达硬熔断后拒绝主动发言并带完整审计数字', () => {
  const result = decideProactive({
    policy: {
      requireMention: true,
      proactiveChats: { 群A: 2 },
      hardBreaker: 4,
    },
    state: { ok: true, day: TODAY, used: { 群A: 4 } },
    chat: '群A',
    mention: { ok: false, reason: '最近没人 @ 你' },
    exempt: false,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.proactive, false)
  assert.equal(result.used, 4)
  assert.equal(result.softLimit, 2)
  assert.equal(result.hardBreaker, 4)
  assert.equal(result.overSoftLimit, true)
  assert.equal(result.atHardBreaker, true)
  assert.match(result.why, /熔断/)
})

test('decideProactive：硬熔断低于软上限时也先按熔断拒绝', () => {
  const result = decideProactive({
    policy: { requireMention: true, proactiveChats: { 群A: 5 }, hardBreaker: 2 },
    state: { ok: true, day: TODAY, used: { 群A: 2 } },
    chat: '群A',
    mention: { ok: false, reason: '最近没人 @ 你' },
    exempt: false,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'breaker')
  assert.equal(result.atHardBreaker, true)
})

test('decideProactive：软上限显式为 0 时，不能借硬熔断空白放行', () => {
  const result = decideProactive({
    policy: { requireMention: true, proactivePerDay: 0, hardBreaker: 10 },
    state: { ok: true, day: TODAY, used: {} },
    chat: '群A',
    mention: { ok: false, reason: '最近没人 @ 你' },
    exempt: false,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.proactive, false)
  assert.match(result.why, /最近没人 @ 你/)
})

test('状态文件：坏 JSON/负数不可信，跨天重置', () => {
  const file = join(dir, 'state.json')
  writeFileSync(file, '{not json')
  assert.equal(loadState(file, NOW).ok, false)
  writeFileSync(file, JSON.stringify({ day: '2000-01-01', used: { 群A: 9 } }))
  assert.deepEqual(loadState(file, NOW), { ok: true, day: TODAY, used: {} })
  writeFileSync(file, JSON.stringify({ day: TODAY, used: { 群A: -3, 群B: 2 } }))
  assert.equal(loadState(file, NOW).ok, false)
})

test('状态文件：当天形状或计数坏掉都失败关闭，不重置成空白额度', () => {
  const file = join(dir, 'state-bad-shape.json')
  for (const bad of [
    { day: TODAY, used: [] },
    { day: TODAY, used: { 群A: 'abc' } },
    { day: TODAY, used: { 群A: -1 } },
    { day: TODAY, used: { '': 1 } },
    { day: TODAY },
  ]) {
    writeFileSync(file, JSON.stringify(bad))
    assert.equal(loadState(file, NOW).ok, false, JSON.stringify(bad))
  }
})

test('状态不可信时拒绝主动发言，但不影响 @ 窗口/免 @ 路径', () => {
  const state = { ok: false, day: TODAY, used: {} }
  const policy = { requireMention: true, proactiveChats: { 群A: 5 } }
  const denied = decideProactive({ policy, state, chat: '群A', mention: { ok: false, reason: '最近没人 @ 你' }, exempt: false, now: NOW })
  assert.equal(denied.ok, false)
  assert.match(denied.why, /状态读不出来/)
  assert.equal(decideProactive({ policy, state, chat: '群A', mention: { ok: true }, exempt: false, now: NOW }).ok, true)
  assert.equal(decideProactive({ policy, state, chat: '群A', mention: { ok: false }, exempt: true, now: NOW }).ok, true)
})

test('saveState 写回后可读，目录不存在也能建；不可写时返回 false', () => {
  const file = join(dir, 'nested', 'state.json')
  assert.equal(saveState({ day: TODAY, used: { 群A: 3 } }, file), true)
  assert.deepEqual(loadState(file, NOW), { ok: true, day: TODAY, used: { 群A: 3 } })
  assert.equal(saveState({ day: TODAY, used: {} }, dir), false)
})
