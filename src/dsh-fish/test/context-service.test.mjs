import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextService } from '../lib/context-service.js'

const at = (t) => ({ text: '## 他现在在做什么\n他正在玩游戏。', at: t })

test('provide/render/TTL/surface/section', () => {
  const c = createContextService({ now: () => 1000 })
  const off = c.provide('screen-activity', {
    order: 60, surfaces: ['web', 'wx', 'screen'], ttlMs: 120_000, get: () => at(900),
  })
  assert.match(c.render({ surface: 'web', now: 1000 }), /正在玩游戏/)
  assert.match(c.render({ surface: 'screen', now: 1000 }), /正在玩游戏/)
  assert.equal(c.render({ surface: 'bili', now: 1000 }), '')
  assert.equal(c.render({ surface: 'web', section: 'other', now: 1000 }), '')
  assert.equal(c.render({ surface: 'web', now: 200_000 }), '', 'TTL 过期不渲染')
  off()
  assert.equal(c.render({ surface: 'web', now: 1000 }), '')
})

test('provider 抛错不影响其他段；ISO at 也能比较', () => {
  const c = createContextService({ now: () => Date.parse('2026-11-13T10:01:00Z') })
  c.provide('bad', { order: 1, surfaces: ['web'], ttlMs: 120_000, get: () => { throw new Error('boom') } })
  c.provide('good', {
    order: 2, surfaces: ['web'], ttlMs: 120_000,
    get: () => ({ text: '## 他现在在做什么\n他在电脑前做事。', at: '2026-11-13T10:00:00Z' }),
  })
  const out = c.render({ surface: 'web' })
  assert.match(out, /电脑前做事/)
})

test('总长 400 字，按 order 排序，截后面的', () => {
  const c = createContextService({ now: () => 1000 })
  c.provide('a', { order: 2, surfaces: ['web'], ttlMs: 0, get: () => ({ text: 'B'.repeat(300), at: 900 }) })
  c.provide('b', { order: 1, surfaces: ['web'], ttlMs: 0, get: () => ({ text: 'A'.repeat(300), at: 900 }) })
  const out = c.render({ surface: 'web', now: 1000 })
  assert.equal(out.length, 400)
  assert.ok(out.startsWith('A'))
})
