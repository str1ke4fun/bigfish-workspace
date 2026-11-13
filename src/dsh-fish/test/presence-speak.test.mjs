import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerPresenceSpeak } from '../lib/presence-speak.js'

function setup({ surface = 'screen', canSpeak = () => ({ ok: true }) } = {}) {
  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  const comments = []
  const screen = {
    comments,
    canSpeak,
    currentMode: () => 'event',
    currentEvent: () => 'scene_change',
    async recordComment(o) { comments.push(o); return { ok: true } },
  }
  const core = { surface: { current: () => surface } }
  registerPresenceSpeak(ctx, { core, screen })
  return { def: defs.get('presence_speak'), comments, screen }
}

test('presence_speak 只在 screen 面可用，正常写入台账', async () => {
  const { def, comments } = setup()
  const r = await def.execute({ text: '这一下有点意思。' }, { agent: {} })
  assert.equal(r.ok, true)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].text, '这一下有点意思。')
  assert.equal(comments[0].event, 'scene_change')
})

test('非 screen 面拒绝，不写台账', async () => {
  const { def, comments } = setup({ surface: 'web' })
  const r = await def.execute({ text: '好' }, { agent: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_SCREEN')
  assert.equal(comments.length, 0)
})

test('空话/超长/冷却拒绝，且不写台账', async () => {
  const { def, comments, screen } = setup()
  assert.equal((await def.execute({ text: '   ' }, { agent: {} })).code, 'EMPTY')
  assert.equal((await def.execute({ text: 'x'.repeat(121) }, { agent: {} })).code, 'TOO_LONG')
  screen.canSpeak = () => ({ ok: false, why: 'cooldown' })
  assert.equal((await def.execute({ text: '好' }, { agent: {} })).code, 'PRESENCE_COOLDOWN')
  assert.equal(comments.length, 0)
})
