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

test('noteHome 死路径已删；屋子会话走 surface.reserve 登记', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(core.surface.noteHome, undefined, '没人调用的第二道保险已删，避免误以为有 homeSessionId 兜底')
  assert.equal(core.surface.current(agent('home-9', '/tmp/elsewhere')), null)
  core.surface.reserve('home-9', 'web')
  assert.equal(core.surface.current(agent('home-9', '/tmp/elsewhere')), 'web')
  dispose()
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

test('schedule 钩子表挂在 core 上：六个成员齐全，dispose 后 status().disposed 为 true', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  for (const key of ['onTick', 'onWake', 'runTick', 'runWake', 'status', 'dispose']) {
    assert.equal(typeof core.schedule[key], 'function', `core.schedule.${key} 必须是函数`)
  }
  assert.equal(core.schedule.status().disposed, false)
  core.schedule.dispose()
  assert.equal(core.schedule.status().disposed, true)
  dispose()
})

test('prompt / sessions 挂在同一个 core 上，成员齐全', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  for (const key of ['setWake', 'clearWake', 'getWake', 'wakeSectionFor', 'withWake', 'watchTurnEnd', 'section']) {
    assert.equal(typeof core.prompt?.[key], 'function', `core.prompt.${key} 必须是函数`)
  }
  for (const key of ['create', 'find', 'prompt', 'rename', 'list']) {
    assert.equal(typeof core.sessions?.[key], 'function', `core.sessions.${key} 必须是函数`)
  }
  dispose()
})
