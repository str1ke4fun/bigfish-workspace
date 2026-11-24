import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerLookScreen } from '../lib/look-screen.js'
import { resolveAllow } from '../lib/tool-policy.js'

function setup({ surface = 'screen', captureNow } = {}) {
  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  const core = { surface: { current: () => surface } }
  const screen = {
    captureNow: captureNow ?? (async () => ({ ok: true, path: '/tmp/look-1.jpg', at: 1000, mode: 'event' })),
  }
  registerLookScreen(ctx, { core, screen })
  return { def: defs.get('look_screen') }
}

test('look_screen 只在 screen 面可见，别的面拒绝', async () => {
  const { def: screenDef } = setup()
  assert.match(screenDef.description, /屏幕上有什么/)
  assert.match(screenDef.description, /read_image/)
  assert.ok(resolveAllow({ surface: 'screen', caps: {} }).includes('look_screen'))
  for (const s of ['web', 'wx', 'qq', 'bili', 'work']) {
    assert.equal(resolveAllow({ surface: s, caps: {} }).includes('look_screen'), false, s)
  }
  const { def } = setup({ surface: 'web' })
  const r = await def.execute({}, { agent: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_SCREEN')
})

test('抓到了就返回这一张的路径，不直接塞图', async () => {
  const { def } = setup()
  const r = await def.execute({}, { agent: {} })
  assert.deepEqual(r, { ok: true, path: '/tmp/look-1.jpg', at: 1000, mode: 'event' })
  const blocks = def.output.render({}, r)
  assert.match(blocks[0].text, /看一眼/)
  assert.match(blocks[0].text, /\/tmp\/look-1\.jpg/)
  assert.match(blocks[0].text, /read_image/)
})

test('抓不到时按原因回人话，不假装看到了', async () => {
  for (const [why, text] of [
    ['presence-off', '没开'],
    ['not-capturing', '看不到'],
    ['no-frame', '没有.*画面'],
    ['save-failed', '没存下来'],
  ]) {
    const { def } = setup({ captureNow: async () => ({ ok: false, why }) })
    const r = await def.execute({}, { agent: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, why)
    const blocks = def.output.render({}, r)
    assert.match(blocks[0].text, new RegExp(text))
  }
})

test('screen 服务缺失时明确失败', async () => {
  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  registerLookScreen(ctx, { core: { surface: { current: () => 'screen' } }, screen: null })
  const r = await defs.get('look_screen').execute({}, { agent: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_SCREEN_SERVICE')
})
