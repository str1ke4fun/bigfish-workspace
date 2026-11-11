/**
 * prompt-sessions.test.mjs —— `fishCore.prompt` / `fishCore.sessions`（A1.6）
 *
 * 这两组接口是 A2 搬包后 dsh-bili 唯一能用的处境与会话入口，守四件事：
 *   1. 处境段按 session 隔离：两条会话互不串，clear 一条不碰另一条；
 *   2. section 只在匹配面上挂，render 抛错不把插件带走；
 *   3. sessionController 缺席时明确说 NO_SESSION_CONTROLLER，不抛；
 *   4. create 在宿主 create 之前先 reserve 面（agent/created 是同步发出的）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createPromptService } from '../lib/prompt-service.js'
import { createSessionService } from '../lib/session-service.js'
import { createSurfaceRegistry } from '../lib/surface.js'

/** 假宿主：只保留 prompt/sessions 用得到的 get / on。 */
function fakeCtx({ sc, reg } = {}) {
  const handlers = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessionController') return sc
      if (name === 'workspaceRegistry') return reg
      return undefined
    },
    on(ev, fn) {
      const set = handlers.get(ev) ?? new Set()
      set.add(fn)
      handlers.set(ev, set)
      return () => set.delete(fn)
    },
  }
  return { ctx, handlers }
}

function agentFor(id, cwd = '/tmp/elsewhere') {
  const sections = []
  return {
    agent: {
      session: { header: { id, cwd } },
      ctx: { systemPrompt: { section: (cfg) => sections.push(cfg) } },
    },
    sections,
  }
}

// ---- prompt ----

test('wake 段按 session 隔离，clearWake(a) 不清 b', () => {
  const { ctx } = fakeCtx()
  const p = createPromptService({ ctx })

  p.setWake('a', 'A 的处境')
  p.setWake('b', 'B 的处境')
  assert.equal(p.getWake('a'), 'A 的处境')
  assert.equal(p.getWake('b'), 'B 的处境')

  const { agent: aAgent } = agentFor('a')
  const { agent: bAgent } = agentFor('b')
  assert.equal(p.wakeSectionFor(aAgent), 'A 的处境')
  assert.equal(p.wakeSectionFor(bAgent), 'B 的处境')

  p.clearWake('a')
  assert.equal(p.getWake('a'), '')
  assert.equal(p.getWake('b'), 'B 的处境')
  p.clearWake('b')
})

test('section 只在匹配面挂；render 抛错返回空串并记日志', () => {
  const surface = createSurfaceRegistry()
  surface.reserve('bili-1', 'bili')
  surface.reserve('web-1', 'web')
  const logs = []
  const { ctx, handlers } = fakeCtx()
  const p = createPromptService({ ctx, surface, log: (...a) => logs.push(a.join(' ')) })

  const off = p.section({
    id: 'fish:bili',
    order: 8600,
    surface: 'bili',
    render: () => 'B 站这一段',
  })
  const onCreated = [...handlers.get('agent/created')][0]

  const bili = agentFor('bili-1')
  const web = agentFor('web-1')
  onCreated({ agent: bili.agent })
  onCreated({ agent: web.agent })
  assert.equal(bili.sections.length, 1, 'bili 面必须挂上')
  assert.equal(web.sections.length, 0, 'web 面不该看到 B 站段')
  assert.equal(bili.sections[0].text(), 'B 站这一段')

  // render 抛错：text() 不能抛，返回空串，日志有记录
  const bad = p.section({ id: 'fish:bad', surface: 'bili', render: () => { throw new Error('boom') } })
  const onBad = [...handlers.get('agent/created')][1]
  const badAgent = agentFor('bili-2')
  surface.reserve('bili-2', 'bili')
  onBad({ agent: badAgent.agent })
  assert.equal(badAgent.sections[0].text(), '')
  assert.ok(logs.some((l) => l.includes('boom')), 'render 抛错要留下日志')

  off()
  bad()
})

test('section 拒绝不以 fish: 开头的 id', () => {
  const { ctx, handlers } = fakeCtx()
  const p = createPromptService({ ctx })
  const off = p.section({ id: 'bili', render: () => 'x' })
  assert.equal(handlers.get('agent/created')?.size ?? 0, 0, '非法 id 不该监听 agent/created')
  off()
})

test('watchTurnEnd 只在目标会话的 turn/end 触发一次', () => {
  const { ctx, handlers } = fakeCtx()
  const p = createPromptService({ ctx })
  let n = 0
  p.watchTurnEnd('s1', () => { n += 1 })
  // 像宿主一样从当前监听集合里逐个调用：卸载后下一次就不会再触发。
  const emit = (session, event) => { for (const fn of [...(handlers.get('session/event') ?? [])]) fn(session, event) }
  emit({ header: { id: 's2' } }, { type: 'turn/end' })
  assert.equal(n, 0)
  emit({ header: { id: 's1' } }, { type: 'turn/start' })
  assert.equal(n, 0)
  emit({ header: { id: 's1' } }, { type: 'turn/end' })
  assert.equal(n, 1)
  emit({ header: { id: 's1' } }, { type: 'turn/end' })
  assert.equal(n, 1, '回调只跑一次')
})

// ---- sessions ----

function fakeSc({ failFirst = false } = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    async create(req) {
      n += 1
      calls.push({ kind: 'create', req })
      if (failFirst && n === 1) throw new Error('preset 不被宿主接受')
      return { sessionId: req.sessionId ?? 'host-1' }
    },
    async rename(req) { calls.push({ kind: 'rename', req }) },
    async prompt(req, signal) {
      calls.push({ kind: 'prompt', req, signal })
      signal?.throwIfAborted?.()
      return true
    },
    async list() {
      return { items: [{ sessionId: 'bil-1', title: '出门' }, { sessionId: 'web-1', title: '跟大肥鱼说话' }] }
    },
  }
}

test('sessions.create 先 reserve 面再 create，并按 title 改名', async () => {
  const surface = createSurfaceRegistry()
  let surfaceAtCreate = null
  const sc = fakeSc()
  const inner = sc.create.bind(sc)
  sc.create = async (req) => {
    surfaceAtCreate = surface.current({ session: { header: { id: req.sessionId } } })
    return inner(req)
  }
  const { ctx } = fakeCtx({ sc })
  const s = createSessionService({ ctx, surface })

  const out = await s.create({ title: '出门', cwd: '/root/home/bili', preset: 'fish-home', surface: 'bili' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(surfaceAtCreate, 'bili', '宿主 create 期间 agent/created 就要命中 bili 面')
  assert.equal(sc.calls.filter((c) => c.kind === 'create')[0].req.agentPreset, 'fish-home')
  assert.ok(sc.calls.some((c) => c.kind === 'rename' && c.req.title === '出门'))
})

test('sessions.create 首个 preset 方案失败时回退并仍成功', async () => {
  const surface = createSurfaceRegistry()
  const sc = fakeSc({ failFirst: true })
  const { ctx } = fakeCtx({ sc })
  const s = createSessionService({ ctx, surface })
  const out = await s.create({ title: '出门', cwd: '/root/home/bili', preset: 'fish-home', surface: 'bili' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(sc.calls.filter((c) => c.kind === 'create').length, 2)
})

test('sessions.create：宿主没有 sessionController 时明确说 NO_SESSION_CONTROLLER', async () => {
  const { ctx } = fakeCtx()
  const s = createSessionService({ ctx })
  const out = await s.create({ title: '出门' })
  assert.deepEqual(out, { ok: false, why: 'NO_SESSION_CONTROLLER' })
  const p = await s.prompt('s1', 'hi')
  assert.deepEqual(p, { ok: false, why: 'NO_SESSION_CONTROLLER' })
})

test('sessions.find / list 按面过滤，prompt 带 signal 与 queue 模式', async () => {
  const surface = createSurfaceRegistry()
  surface.reserve('bil-1', 'bili')
  surface.reserve('web-1', 'web')
  const sc = fakeSc()
  const { ctx } = fakeCtx({ sc })
  const s = createSessionService({ ctx, surface })

  const hit = await s.find({ title: '出门', surface: 'bili' })
  assert.equal(hit?.sessionId, 'bil-1')
  assert.equal(await s.find({ title: '出门', surface: 'web' }), null, '面不匹配不能认领')

  const list = await s.list({ surface: 'bili' })
  assert.deepEqual(list.map((x) => x.sessionId), ['bil-1'])

  const r = await s.prompt('bil-1', '看一眼')
  assert.equal(r.ok, true, JSON.stringify(r))
  const call = sc.calls.find((c) => c.kind === 'prompt')
  assert.equal(call.req.sessionId, 'bil-1')
  assert.equal(call.req.mode, 'queue')
  assert.equal(call.req.content[0].text, '看一眼')
  assert.equal(typeof call.signal.throwIfAborted, 'function')
})
