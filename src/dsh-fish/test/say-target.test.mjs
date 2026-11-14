import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSaySession } from '../lib/say.js'

test('companion：先 ensureSession，再计一轮对话', async () => {
  const calls = []
  const screen = {
    ensureSession: async () => { calls.push('ensure'); return 'c1' },
    noteChatTurn: async () => { calls.push('turn'); return { rotated: false, sessionId: 'c1' } },
  }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'c1', target: 'companion', fellBack: false })
  assert.deepEqual(calls, ['ensure', 'turn'])
})

test('companion 失败回落 home，并标记 fellBack', async () => {
  const screen = { ensureSession: async () => '', noteChatTurn: async () => ({ rotated: false, sessionId: '' }) }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: true })
})

test('缺省走 home，不碰 screen', async () => {
  let touched = false
  const screen = { ensureSession: async () => { touched = true; return 'c1' } }
  const r = await resolveSaySession({ target: undefined, screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: false })
  assert.equal(touched, false)
})
