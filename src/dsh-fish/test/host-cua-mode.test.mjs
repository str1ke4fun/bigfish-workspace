import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostCuaMode } from '../lib/host-cua-mode.js'

test('初始 off，工作台可开 observe 并返回到期时刻', () => {
  let t = 1000
  const m = createHostCuaMode({ now: () => t, ttlMs: 900_000, schedule: () => 1, cancel: () => {} })
  assert.equal(m.status().mode, 'off')
  const r = m.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(r.ok, true)
  assert.equal(r.status.mode, 'observe')
  assert.equal(r.status.expiresAt, 901_000)
  assert.equal(m.authorize('observe').ok, true)
  assert.equal(m.authorize('managed').ok, false)
})

test('桌宠不能开启，只能关闭', () => {
  const m = createHostCuaMode({ schedule: () => 1, cancel: () => {} })
  assert.equal(m.setMode({ mode: 'managed', actor: 'pet' }).code, 'PET_CANNOT_START')
  m.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(m.setMode({ mode: 'off', actor: 'pet' }).ok, true)
})

test('managed 可降到 off，不可降回 observe', () => {
  const m = createHostCuaMode({ schedule: () => 1, cancel: () => {} })
  m.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(m.setMode({ mode: 'observe', actor: 'workbench' }).code, 'MODE_DOWNGRADE')
})

test('tick 到期回到 off 并通知 onChange', () => {
  let t = 0
  const seen = []
  const m = createHostCuaMode({ now: () => t, ttlMs: 10, schedule: () => 1, cancel: () => {}, onChange: (s, why) => seen.push([s.mode, why]) })
  m.setMode({ mode: 'managed', actor: 'workbench' })
  t = 11
  m.tick()
  assert.equal(m.status().mode, 'off')
  assert.deepEqual(seen.at(-1), ['off', 'expired'])
})

test('observe → managed 是允许的升级', () => {
  const m = createHostCuaMode({ schedule: () => 1, cancel: () => {} })
  m.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(m.setMode({ mode: 'managed', actor: 'workbench' }).ok, true)
  assert.equal(m.status().mode, 'managed')
})
