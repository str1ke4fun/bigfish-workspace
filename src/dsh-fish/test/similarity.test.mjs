import { test } from 'node:test'
import assert from 'node:assert/strict'

import { similarity, normVoice, findEcho, VOICE_FRESH_DAYS } from '../lib/similarity.js'

test('similarity: 相同为 1，空为 0', () => {
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('', 'x'), 0)
  assert.equal(similarity(null, undefined), 1)
})

test('normVoice: 去 URL / @ / 标点', () => {
  assert.equal(normVoice('@a 你好 https://x.test ！'), '你好')
})

test('findEcho: 只在评论之后找相似的话', () => {
  const voice = { id: 'v1', at: '2026-11-10T00:00:00.000Z', text: '今天真冷' }
  const events = [
    { id: 'v1', type: 'voice', ts: voice.at, text: voice.text },
    { id: 'u1', type: 'utterance', ts: '2026-11-10T00:01:00.000Z', text: '今天真冷啊' },
  ]
  assert.equal(findEcho(voice, events)?.id, 'u1')
})

test('findEcho: 评论之前的相似话不算回声', () => {
  const voice = { id: 'v1', at: '2026-11-10T00:02:00.000Z', text: '今天真冷' }
  const events = [
    { id: 'u0', type: 'utterance', ts: '2026-11-10T00:01:00.000Z', text: '今天真冷啊' },
    { id: 'v1', type: 'voice', ts: voice.at, text: voice.text },
  ]
  assert.equal(findEcho(voice, events), null)
})

test('VOICE_FRESH_DAYS 保持 7', () => assert.equal(VOICE_FRESH_DAYS, 7))
