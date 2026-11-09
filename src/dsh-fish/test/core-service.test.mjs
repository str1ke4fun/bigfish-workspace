import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provideFishCore } from '../lib/core-service.js'

function fakeCtx() {
  const provided = new Map()
  const services = new Map()
  return {
    provided, services,
    provide(name, value) { provided.set(name, value); services.set(name, value); return () => { provided.delete(name); services.delete(name) } },
    get(name) { return services.get(name) },
  }
}

const agent = (id, cwd = '') => ({ session: { header: { id, cwd } } })

test('provideFishCore 暴露 surface/guard/config，并登记 web/wx/qq/bili', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(ctx.get('fishCore'), core)
  assert.equal(typeof core.guard.sanitizeForeign, 'function')
  assert.equal(core.tools.wrap, null)
  core.surface.reserve('home-1', 'web')
  assert.equal(core.surface.current(agent('home-1')), 'web')
  core.surface.reserve('wx-1', 'wx')
  assert.equal(core.surface.current(agent('wx-1')), 'wx')
  dispose()
  assert.equal(ctx.get('fishCore'), undefined)
})

test('qq 按 onebot- 前缀判定，未知会话 null', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(core.surface.current(agent('onebot-123')), 'qq')
  assert.equal(core.surface.current(agent('random', '/tmp')), null)
  dispose()
})

test('bili 按专属 cwd 判定', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(core.surface.current(agent('bili-1', '/tmp/fish-root/home/bili')), 'bili')
  dispose()
})
