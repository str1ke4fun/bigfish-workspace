/**
 * observe-pet.test.mjs —— 桌宠薄壳的 BFF 路由（/pet/state、/pet/act、/pet/rest）
 *
 * 桌宠窗口不直连事件流：状态走 `/pet/state`（活动 + 动作 + 屏幕陪伴只读快照），
 * 用户点一下走 `/pet/act`（写单槽动作）或 `/pet/rest`（写休息覆盖）。三条路由都是用户面，不碰模型，
 * 也不写 events.jsonl——这里从 HTTP 路由层确认它们只是 petView 的薄包装。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerObserve } from '../lib/observe.js'
import { createPetView } from '../lib/pet-view.js'

function fakeCtx() {
  const routes = []
  const cfg = { connection: null }
  let config = {}
  const fishCore = {
    config: {
      get: async () => config,
      patch: async (input) => {
        config = { ...config, ...input }
        return { ok: true, config }
      },
    },
  }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    fishCore,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : k === 'fishCore' ? fishCore : undefined),
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
  petView.noteCue({ id: 'cue-1', kind: 'speak', text: '刚说过的话', at: 900, ttlMs: 5000 })
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
  assert.equal(s.body.scene, null)
  assert.deepEqual(s.body.cues, [{ id: 'cue-1', kind: 'speak', text: '刚说过的话', at: 900, ttlMs: 5000 }])
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

test('/pet/hello 转发 action 目录，/pet/act 接受已上报的 action', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const hello = await callRoute(ctx.routes, '/pet/hello', 'POST', {
    version: '0.2.0',
    skins: [{ id: '', name: '默认' }],
    actions: [{ id: 'wave', label: '挥手', group: '回应' }],
  })
  assert.equal(hello.status, 200)

  const ok = await callRoute(ctx.routes, '/pet/act', 'POST', { action: 'wave', text: '你好' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.action.action, 'wave')
  assert.equal(ok.body.action.motion, undefined)
  assert.equal(ok.body.action.text, '你好')

  const unknown = await callRoute(ctx.routes, '/pet/act', 'POST', { action: 'missing' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.ok, false)

  const motion = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'success' })
  assert.equal(motion.status, 200)
  assert.equal(motion.body.action.motion, 'success')

  const state = await callRoute(ctx.routes, '/pet/state', 'GET')
  assert.deepEqual(state.body.actions, [{ id: 'wave', label: '挥手', group: '回应' }])
  assert.equal(Object.hasOwn(state.body.pet, 'actions'), false)
})

test('/pet/act 同时给 motion 和 action 或两者都不给时返回 400', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({ actions: [{ id: 'wave', label: '挥手', group: '回应' }] })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const both = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'success', action: 'wave' })
  assert.equal(both.status, 400)
  assert.equal(both.body.ok, false)

  const neither = await callRoute(ctx.routes, '/pet/act', 'POST', {})
  assert.equal(neither.status, 400)
  assert.equal(neither.body.ok, false)
})

test('/pet/rest 只把用户显式操作写进易失 scene，不写事件流', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.setScheduleRest({ rest: true, at: 900 })
  const root = join(tmpdir(), `fish-pet-rest-${process.pid}-${Date.now()}`)
  registerObserve(ctx, { root, petView })

  const wake = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'wake' })
  assert.equal(wake.status, 200)
  assert.equal(wake.body.ok, true)
  assert.equal(wake.body.action, 'wake')
  assert.equal((await callRoute(ctx.routes, '/pet/state', 'GET')).body.scene, null)

  const auto = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'auto' })
  assert.equal(auto.status, 200)
  assert.deepEqual((await callRoute(ctx.routes, '/pet/state', 'GET')).body.scene, { kind: 'rest', at: 900 })

  const invalid = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'nap' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.ok, false)
  assert.equal((await callRoute(ctx.routes, '/pet/rest', 'GET')).status, 405)
  assert.equal(existsSync(join(root, 'events.jsonl')), false)
})

test('/pet/state 的顶层 at 跟随 snapshot 时刻，不因等待 config 而跨过之后的 rest 操作', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 500 })
  let releaseConfig
  let markConfigStarted
  const configStarted = new Promise((resolve) => { markConfigStarted = resolve })
  const configGate = new Promise((resolve) => { releaseConfig = resolve })
  ctx.fishCore.config.get = async () => {
    markConfigStarted()
    await configGate
    return {}
  }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const pending = callRoute(ctx.routes, '/pet/state', 'GET')
  await configStarted
  const restAt = Date.now()
  petView.setRestOverride('sleep')
  await new Promise((resolve) => setTimeout(resolve, 5))
  releaseConfig()

  const state = await pending
  assert.equal(state.status, 200)
  // This response captured the pre-rest state. Its top-level timestamp must stay pre-rest so
  // the renderer's manual-intent floor rejects it when the POST /pet/rest response arrives.
  assert.equal(state.body.scene, null)
  assert.ok(state.body.at <= restAt, `state.at=${state.body.at} restAt=${restAt}`)
})

test('hello / config / rotate 三条新路由', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  const screen = {
    status: () => ({ on: true, mode: 'event', busy: false, snapshot: null, recent: [] }),
    companionInfo: () => ({ sessionId: 's1', sessionComments: 2, chatTurns: 1, rotateAfter: 30 }),
    rotateSession: async () => 's1',
  }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView, screen })

  assert.equal((await callRoute(ctx.routes, '/pet/hello', 'POST', { version: '0.1.0', skins: [{ id: '', name: '默认' }] })).status, 200)
  assert.equal((await callRoute(ctx.routes, '/pet/state', 'GET')).body.pet.version, '0.1.0')

  const cfg = await callRoute(ctx.routes, '/pet/config', 'POST', { size: 320, skin: '' })
  assert.equal(cfg.status, 200)
  assert.equal(cfg.body.pet.size, 320)
  assert.equal((await callRoute(ctx.routes, '/pet/config', 'POST', { skin: 'Bad ID' })).status, 400)

  const rot = await callRoute(ctx.routes, '/pet/rotate', 'POST', {})
  assert.equal(rot.status, 200)
  assert.equal(rot.body.sessionId, 's1')
})

test('/pet/state 把当前桌宠上报的动作目录交给工作台', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({ actions: [{ id: 'asset-001', label: '三球抛接', group: '日常' }] })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const state = await callRoute(ctx.routes, '/pet/state', 'GET')

  assert.deepEqual(state.body.actions, [{ id: 'asset-001', label: '三球抛接', group: '日常' }])
})

test('/pet/rest 接受 auto、sleep、wake、awake 并回传当前场景', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.setScheduleRest({ rest: true, at: 900 })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const sleep = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'sleep' })
  assert.deepEqual(sleep.body.scene, { kind: 'rest', at: 1000 })
  const wake = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'wake' })
  assert.equal(wake.body.scene, null)
  const auto = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'auto' })
  assert.deepEqual(auto.body.scene, { kind: 'rest', at: 900 })

  assert.equal((await callRoute(ctx.routes, '/pet/state', 'GET')).body.awakeUntil, null)

  const awake = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'awake' })
  assert.equal(awake.status, 200)
  assert.equal(awake.body.ok, true)
  assert.equal(awake.body.action, 'awake')
  assert.equal(awake.body.scene, null)
  assert.equal(awake.body.awakeUntil, 1000 + 12 * 60 * 60 * 1000)
  // 桌宠菜单读的是 /pet/state，必须一并透出。
  assert.equal((await callRoute(ctx.routes, '/pet/state', 'GET')).body.awakeUntil, 1000 + 12 * 60 * 60 * 1000)

  assert.equal((await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'wrong' })).status, 400)
})

test('/pet/rest 把休息意图交给落盘回调，长唤醒带到期时刻', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  const saved = []
  registerObserve(ctx, {
    root: '/tmp/fish-pet-unused',
    petView,
    persistPetRest: (state) => saved.push(state),
  })

  await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'awake' })
  assert.deepEqual(saved.at(-1), { action: 'awake', awakeUntil: 1000 + 12 * 60 * 60 * 1000 })

  await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'sleep' })
  assert.deepEqual(saved.at(-1), { action: 'sleep', awakeUntil: null })
})

test('/pet/config 接受气泡透明度和宽度，并在 state.settings 里回显', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView: createPetView({ now: () => 1000 }) })

  const ok = await callRoute(ctx.routes, '/pet/config', 'POST', { bubbleOpacity: 70, bubbleWidth: 300 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.pet.bubbleOpacity, 70)
  assert.equal(ok.body.pet.bubbleWidth, 300)
  assert.equal(ok.body.pet.size, 400)

  const clamped = await callRoute(ctx.routes, '/pet/config', 'POST', { bubbleOpacity: 5, bubbleWidth: 999 })
  assert.equal(clamped.body.pet.bubbleOpacity, 40)
  assert.equal(clamped.body.pet.bubbleWidth, 420)

  const follow = await callRoute(ctx.routes, '/pet/config', 'POST', { bubbleWidth: 0 })
  assert.equal(follow.body.pet.bubbleWidth, 0)

  assert.equal((await callRoute(ctx.routes, '/pet/config', 'POST', { bubbleOpacity: 'x' })).status, 400)
  assert.equal((await callRoute(ctx.routes, '/pet/config', 'POST', { bubbleWidth: null })).status, 400)

  const state = await callRoute(ctx.routes, '/pet/state', 'GET')
  assert.equal(state.body.settings.bubbleOpacity, 40)
  assert.equal(state.body.settings.bubbleWidth, 0)
})

test('petView 缺席时桌宠路由都返回 200 ok:false，不 500', async () => {
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

  const rest = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'sleep' })
  assert.equal(rest.status, 200)
  assert.equal(rest.body.ok, false)
  assert.equal(rest.body.note, '桌宠状态没在跑。')
})

test('/pet/ambient GET 返回默认、覆盖、合并结果和动作目录', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({
    actions: [{ id: 'asset-109', label: '伸懒腰', group: '日常' }],
    ambient: {
      version: 1, quietHours: null,
      modes: { work: { enabled: true, items: [{ action: 'asset-109', weight: 1 }], frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 } } },
    },
  })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const r = await callRoute(ctx.routes, '/pet/ambient', 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.defaults.modes.work.items[0].action, 'asset-109')
  assert.equal(r.body.effective.work.enabled, true)
  assert.deepEqual(r.body.actions.map((a) => a.id), ['asset-109'])
})

test('/pet/hello 转发 ambient 默认策略，GET /pet/ambient 能读到', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const hello = await callRoute(ctx.routes, '/pet/hello', 'POST', {
    version: '0.2.0',
    actions: [{ id: 'asset-109', label: '伸懒腰', group: '日常' }],
    ambient: {
      version: 1, quietHours: null,
      modes: { work: { enabled: true, items: [{ action: 'asset-109', weight: 2 }] } },
    },
  })
  assert.equal(hello.status, 200)

  const r = await callRoute(ctx.routes, '/pet/ambient', 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.body.defaults.modes.work.items[0].weight, 2)
})

test('/pet/ambient POST add-item 写 config.pet.ambient，不覆盖其他 pet 键', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({
    actions: [{ id: 'asset-109', label: '伸懒腰', group: '日常' }, { id: 'asset-087', label: '照镜子', group: '日常' }],
    ambient: { version: 1, quietHours: null, modes: { work: { enabled: true, items: [{ action: 'asset-109', weight: 1 }], frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 } } } },
  })
  await ctx.fishCore.config.patch({ pet: { size: 320, skin: 'x', ambient: null } })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const r = await callRoute(ctx.routes, '/pet/ambient', 'POST', {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 3,
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const cfg = await ctx.fishCore.config.get()
  assert.equal(cfg.pet.size, 320)
  assert.equal(cfg.pet.skin, 'x')
  assert.equal(cfg.pet.ambient.modes.work.items.length, 2)
})

test('/pet/ambient 拒绝未知 op / 未知 mode / 非 JSON', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView: createPetView() })
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'POST', { op: 'nope' })).status, 400)
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'POST', { op: 'reset', mode: 'boss' })).status, 400)
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'GET')).status, 200)
})
