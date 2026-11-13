import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { qq } from '../assets/channels/qq.js'

test('QQ 适配器契约', () => {
  assert.equal(qq.id, 'qq')
  assert.equal(qq.order, 10)
  for (const f of ['badge', 'summary', 'renderPanel', 'refresh', 'leave']) assert.equal(typeof qq[f], 'function')
  assert.deepEqual(qq.humanActions, ['send'])
})
test('QQ 人工发送有确认与人工标记', () => {
  const s = readFileSync(new URL('../assets/channels/qq.js', import.meta.url), 'utf8')
  assert.match(s, /confirmHuman\(/)
  assert.match(s, /人工发送/)
  assert.match(s, /humanChip\(\)/)
  assert.match(s, /\/api\/qq\/send/)
  assert.doesNotMatch(s, /innerHTML/)
  const srv = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(srv, /operator:\s*'human'/)
  assert.match(srv, /channel:\s*'qq'/)
  assert.match(srv, /channel:\s*'wx'/)
})
