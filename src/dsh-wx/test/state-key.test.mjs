// 状态键改 chatId 与一次性迁移：合成数据，不读 ~/.dsh-wx。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateMentions, migrateProactive, migrateRecent } from '../lib/state-key.js'
import { grant, canSpeak } from '../lib/mention.js'
import { quotaFor, consume, remaining } from '../lib/proactive.js'

test('mentions 旧名字键迁到 chatId，撞键取最大时间戳', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : 'c_' + n)
  assert.deepEqual(migrateMentions({ '❤️读书群': 10, '❤读书群': 20 }, keyOf), { c_heart: 20 })
})

test('proactive 旧名字键迁到 chatId，撞键取较大计数', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateProactive({ day: '2026-11-25', used: { A: 2, B: 5 } }, keyOf).used, { c_heart: 5 })
})

test('recent 旧数组迁到 chatId，按 key 去重取最大 at', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateRecent([{ chat: 'A', at: 1 }, { chat: 'B', at: 9 }], keyOf), [{ chatId: 'c_heart', chat: 'B', at: 9 }])
})

test('mention 两种 VS 写法共享同一个 @ 窗口', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : '')
  const state = grant({}, '❤️读书群', 1000, keyOf)
  assert.deepEqual(canSpeak(state, '❤读书群', 1000, 3, keyOf), { ok: true, leftMs: 180000 })
})

test('proactive 的 used 以 chatId 记账，额度按名字折叠查', () => {
  const policy = { proactivePerDay: 0, proactiveChats: { '❤️读书群': 2 }, hardBreaker: 50 }
  assert.equal(quotaFor(policy, 'c_heart', '❤读书群'), 2)
  const state = { ok: true, day: '2026-11-25', used: {} }
  const next = consume(policy, state, 'c_heart', '2026-11-25', '❤读书群')
  assert.deepEqual(next.state.used, { c_heart: 1 })
  assert.equal(remaining(policy, next.state, 'c_heart', '2026-11-25', '❤读书群'), 1)
})
