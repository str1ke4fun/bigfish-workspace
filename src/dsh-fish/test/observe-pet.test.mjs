/**
 * observe-pet.test.mjs —— 桌宠薄壳的 BFF 路由（/pet/state、/pet/act）
 *
 * 桌宠窗口不直连事件流：状态走 `/pet/state`（活动 + 动作 + 屏幕陪伴只读快照），
 * 用户点一下走 `/pet/act`（写单槽动作）。两条路由都是用户面，不碰模型，
 * 也不写 events.jsonl——这里从 HTTP 路由层确认它们只是 petView 的薄包装。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { createPetView } from '../lib/pet-view.js'

function fakeCtx() {
  const routes = []
  const cfg = { connection: null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function callRoute(routes, path, method, body) {
  const pathname = path.split('?')[0]
  const def = routes.find((d) => d.path === '/dsh-fish' + pathname)
  if (!def) throw new Error(`没注册这条路由：${pathname}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = '/dsh-fish' + path
  req.headers = { 'content-type': 'application/json' }
  let out = null
  const res = {
    statusCode: 0,
    ended: false,
    setHeader() {},
    writeHead(n) { this.statusCode = n },
    end(t) { this.ended = true; try { out = JSON.parse(String(t)) } catch { out = String(t) } },
  }
  return def.handler(req, res).then(() => ({ status: res.statusCode, body: out }))
}

test('/pet/state 聚合活动、动作与屏幕陪伴快照', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }

  const petView = createPetView({ now: () => 1000 })
  petView.noteSessionEvent({ sessionId: 's1', surface: 'web' }, { type: 'turn/start' })
  petView.act({ motion: 'waving', text: '你好' })
  const screen = {
    status: () => ({
      on: true,
      mode: 'event',
      busy: false,
      snapshot: null,
      recent: [{ at: '2026-11-14T08:00:00Z', mode: 'event', event: 'scene_change', text: '这一下有点意思。' }],
    }),
  }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView, screen })

  const s = await callRoute(ctx.routes, '/pet/state', 'GET')
  assert.equal(s.status, 200)
  assert.equal(s.body.activity.state, 'thinking')
  assert.equal(s.body.action.motion, 'waving')
  assert.equal(s.body.action.text, '你好')
  assert.equal(s.body.presence.on, true)
  assert.equal(s.body.presence.recent[0].text, '这一下有点意思。')
  assert.equal(typeof s.body.at, 'number')

  const ok = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'success' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.action.motion, 'success')

  const bad = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'dragging' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
  assert.equal(typeof bad.body.note, 'string')

  assert.equal((await callRoute(ctx.routes, '/pet/act', 'GET')).status, 405)
})

test('/pet/act 的文本上限与 ttl 归一交给 petView，不重复校验', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const tooLong = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'idle', text: '啊'.repeat(121) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.ok, false)

  const clamped = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'idle', ttlMs: 10 })
  assert.equal(clamped.status, 200)
  assert.equal(clamped.body.action.ttlMs, 1000)

  const defaulted = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'idle', ttlMs: 'nope' })
  assert.equal(defaulted.status, 200)
  assert.equal(defaulted.body.action.ttlMs, 15_000)
})

test('petView 缺席时两条路由都返回 200 ok:false，不 500', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused' })

  const state = await callRoute(ctx.routes, '/pet/state', 'GET')
  assert.equal(state.status, 200)
  assert.equal(state.body.ok, false)
  assert.equal(state.body.note, '桌宠状态没在跑。')

  const act = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'success' })
  assert.equal(act.status, 200)
  assert.equal(act.body.ok, false)
  assert.equal(act.body.note, '桌宠状态没在跑。')
})
