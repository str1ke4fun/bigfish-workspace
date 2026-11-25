import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksGarbled, sanitizePolicyList, canonicalizePolicyName } from '../wx-names.mjs'

test('合法 emoji 名不被乱码规则误杀', () => {
  for (const s of ['🌊周末海边🏖️', '🇨🇳群', '1️⃣群', '❤️读书群']) assert.equal(looksGarbled(s), false)
})

test('U+FFFD / 孤立代理 / 高密度问号被判坏', () => {
  assert.equal(looksGarbled('😀�'), true)
  assert.equal(looksGarbled('😀\uD83D'), true)
  assert.equal(looksGarbled('????'), true)
  assert.equal(looksGarbled('什么??'), false)
})

test('坏条目按条返回，不静默丢弃', () => {
  const r = sanitizePolicyList(['🌊周末海边🏖️', '????', '❤️读书群'])
  assert.deepEqual(r.kept, ['🌊周末海边🏖️', '❤️读书群'])
  assert.equal(r.bad.length, 1)
  assert.equal(r.bad[0].name, '????')
})

test('只从 exact/resolved 条目规范名', () => {
  const entries = [
    { chatId: 'c1', displayName: '❤️读书群', fullName: '❤️读书群', nameConfidence: 'exact' },
    { chatId: 'c2', displayName: '长名...', fullName: '', nameConfidence: 'truncated' },
  ]
  assert.deepEqual(canonicalizePolicyName('❤读书群', entries), { status: 'folded', name: '❤️读书群' })
  assert.equal(canonicalizePolicyName('长名', entries).status, 'truncated')
  assert.equal(canonicalizePolicyName('没见过的群', entries).status, 'unknown')
})

test('exact/resolved 条目改写；truncated/ambiguous 条目不改写', () => {
  const entries = [
    { chatId: 'c1', displayName: '写作群', fullName: '写作群', nameConfidence: 'resolved' },
    { chatId: 'c2', displayName: '截图群...', fullName: '', nameConfidence: 'truncated' },
    { chatId: 'c3', displayName: '撞名群', fullName: '撞名群', nameConfidence: 'ambiguous' },
  ]
  assert.deepEqual(canonicalizePolicyName(' 写作群 ', entries), { status: 'exact', name: '写作群' })
  assert.deepEqual(canonicalizePolicyName('截图群', entries), { status: 'truncated', name: '截图群' })
  const ambiguous = canonicalizePolicyName('撞名群', entries)
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.name, '撞名群')
})

test('两个字面相同的条目、或多条截断条目都按撞名处理', () => {
  const duplicates = [
    { chatId: 'c1', displayName: '同名群', fullName: '同名群', nameConfidence: 'exact' },
    { chatId: 'c2', displayName: '同名群', fullName: '同名群', nameConfidence: 'exact' },
  ]
  assert.equal(canonicalizePolicyName('同名群', duplicates).status, 'ambiguous')

  const truncated = [
    { chatId: 't1', displayName: '长名字...', fullName: '', nameConfidence: 'truncated' },
    { chatId: 't2', displayName: '长名字二号...', fullName: '', nameConfidence: 'truncated' },
  ]
  assert.equal(canonicalizePolicyName('长名', truncated).status, 'ambiguous')
})

test('空名字和折叠撞名都按条报告，不静默丢', () => {
  const empty = sanitizePolicyList(['', '  '])
  assert.deepEqual(empty.kept, [])
  assert.equal(empty.bad.length, 2)

  const folded = sanitizePolicyList(['❤️读书群', '❤读书群'])
  assert.deepEqual(folded.kept, ['❤️读书群'])
  assert.equal(folded.bad.length, 1)
  assert.equal(folded.bad[0].name, '❤读书群')

  const deduped = sanitizePolicyList(['群A', '群A'])
  assert.deepEqual(deduped.kept, ['群A'])
  assert.deepEqual(deduped.bad, [])
})
