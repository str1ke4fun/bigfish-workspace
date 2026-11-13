import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceRegistry, agentSessionId } from '../lib/surface.js'

const agent = (id, cwd = '') => ({ session: { header: { id, cwd } } })

test('预分配 id 优先于 matcher', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ id }) => id === 'home' })
  r.reserve('wx-1', 'wx')
  assert.equal(r.current(agent('wx-1')), 'wx')
})

test('按 bili → wx → qq → web 顺序命中即返回', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ cwd }) => cwd === '/home' })
  r.register({ id: 'wx', match: ({ id }) => id.startsWith('wx-') })
  r.register({ id: 'qq', match: ({ id }) => id.startsWith('onebot-') })
  r.register({ id: 'bili', match: ({ cwd }) => cwd === '/home/bili' })
  assert.equal(r.current(agent('x', '/home/bili')), 'bili')
  assert.equal(r.current(agent('wx-2', '/home/bili')), 'bili')
  assert.equal(r.current(agent('wx-2', '/home')), 'wx')
  assert.equal(r.current(agent('onebot-1', '/home')), 'qq')
  assert.equal(r.current(agent('home', '/home')), 'web')
})

test('未知会话返回 null，不默认归 web', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ id }) => id === 'home' })
  assert.equal(r.current(agent('random', '/tmp')), null)
})

test('create 返回不同 id 时两个 id 都要能认', () => {
  const r = createSurfaceRegistry()
  r.reserve('requested', 'wx')
  r.reserve('returned', 'wx')
  assert.equal(r.current(agent('requested')), 'wx')
  assert.equal(r.current(agent('returned')), 'wx')
})

test('重复注册同一个 surface 抛错；release 后回到 matcher', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'wx', match: () => false })
  assert.throws(() => r.register({ id: 'wx', match: () => false }), /SURFACE_DUPLICATE|already registered/)
  r.reserve('s1', 'wx')
  r.release('s1')
  assert.equal(r.current(agent('s1')), null)
})

test('screen 面可以 reserve，current 返回 screen', () => {
  const r = createSurfaceRegistry()
  r.reserve('screen-1', 'screen')
  assert.equal(r.current(agent('screen-1')), 'screen')
})

test('cwd=home/screen 的 matcher 判成 screen（不依赖 reserve，D36）', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ cwd }) => cwd === '/root/home' })
  r.register({ id: 'screen', match: ({ cwd }) => cwd === '/root/home/screen' })
  assert.equal(r.current(agent('screen-2', '/root/home/screen')), 'screen')
  assert.equal(r.current(agent('home', '/root/home')), 'web')
})

test('agentSessionId 兼容 session.header.id / session.id / agent.id', () => {
  assert.equal(agentSessionId({ session: { header: { id: 'a' } } }), 'a')
  assert.equal(agentSessionId({ session: { id: 'b' } }), 'b')
  assert.equal(agentSessionId({ id: 'c' }), 'c')
})
