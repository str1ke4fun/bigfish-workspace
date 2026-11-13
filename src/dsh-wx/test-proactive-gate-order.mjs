// 回归：主动额度只能在频率闸和会话复核之后扣，避免失败/切走后白扣。
// 跑：node --test test-proactive-gate-order.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
const consumes = [...src.matchAll(/gateSend\(\{ consume: true[^}]*\}\)/g)]

test('每个真正发送路径恰好一处消费额度', () => {
  assert.equal(consumes.length, 6)
})

test('消费点都在 speechGate 之后，频率闸拒绝时不会白扣', () => {
  for (const m of consumes) {
    const before = src.slice(Math.max(0, m.index - 1500), m.index)
    assert.match(before, /await speechGate\(/, `consume at ${m.index} must follow speechGate`)
  }
})

test('知道目标会话的路径把 expected 交给 gateSend，切走后不扣', () => {
  const withExpected = consumes.filter((m) => /expected:/.test(m[0]))
  assert.ok(withExpected.length >= 5, 'sendToChat / sticker / search / wx_type 都要带 expected')
})
