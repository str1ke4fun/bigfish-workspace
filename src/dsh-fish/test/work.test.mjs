import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkState } from '../lib/work-state.js'
import {
  createWorkService,
  isTrustedTurn,
  markTrustedTurn,
  clearTrustedTurn,
  validateWorkDir,
} from '../lib/work.js'

const TRUSTED_CHAT = 'cat不到flag的cat'

async function setup({ surface = 'screen', chat = TRUSTED_CHAT, permission = 'workspace-write', archived = [] } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'fish-work-'))
  const root = join(base, 'fish')
  const dir = join(base, 'proj')
  await mkdir(root, { recursive: true })
  await mkdir(dir, { recursive: true })
  const state = createWorkState({ root })
  const surfaceById = new Map()
  const created = []
  const prompted = []
  const notified = []
  const backendCalls = { spawn: [], message: [], interrupt: [] }
  let settle
  const backend = {
    available: () => true,
    capabilities: () => ({ structuredOutput: true }),
    async spawn(input) {
      backendCalls.spawn.push(input)
      return { ok: true, childId: `child-${backendCalls.spawn.length}`, result: new Promise((r) => { settle = r }), dispose: async () => {} }
    },
    async message(input) { backendCalls.message.push(input); return { ok: true, messageId: 'm1' } },
    async interrupt(input) { backendCalls.interrupt.push(input); return { ok: true, accepted: true } },
    onSettle(result, cb) {
      Promise.resolve(result).then((r) => cb({
        stopReason: r.stopReason,
        closingText: (r.output ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim(),
        structured: r.structured ?? null,
        diagnostic: '',
      }))
      return () => {}
    },
  }
  const guard = { status: () => ({ ok: true }), flushHits: () => 0 }
  const wx = {
    currentChat: () => chat,
    async notifyOwner(msg) { notified.push(msg); return { ok: true } },
  }
  const core = {
    surface: {
      current: (agent) => surfaceById.get(agent?.session?.header?.id ?? agent?.session?.id ?? '') ?? null,
      reserve: (id, s) => surfaceById.set(id, s),
    },
    sessions: {
      async create(input) { created.push(input); return { ok: true, sessionId: input.sessionId ?? `boss-${created.length}` } },
      async prompt(sessionId, text) { prompted.push({ sessionId, text }); return { ok: true } },
      async list() { return { items: [...surfaceById.keys()].map((id) => ({ sessionId: id })) } },
    },
  }
  const ctx = {
    get: (name) => {
      if (name === 'wx') return wx
      if (name === 'permissionPresets') return {
        current: () => {
          if (permission === 'THROW') throw new Error('permission unavailable')
          return permission
        },
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
      return null
    },
    on: () => () => {},
  }
  const config = {
    work: {
      wx: { dispatchChats: [TRUSTED_CHAT], ownerChat: TRUSTED_CHAT },
      delegation: { bossKind: 'fish', backend: 'subagent', structuredOutput: 'inspect-only', maxActive: 2, maxBuild: 1, runTimeoutMs: 60_000 },
    },
  }
  const service = createWorkService({
    ctx, core, config, state, backend, guard, wx, root,
    now: () => 1000,
    log: () => {},
  })
  const agent = (id, cwd = dir) => {
    const a = { session: { header: { id, cwd } } }
    return a
  }
  const boss = agent('boss-1', dir)
  surfaceById.set('boss-1', 'work')
  const screen = agent('screen-1')
  surfaceById.set('screen-1', 'screen')
  const wxAgent = agent('wx-1')
  surfaceById.set('wx-1', 'wx')
  return {
    root, dir, state, service, backendCalls, created, prompted, notified,
    settle: (v) => settle(v), boss, screen, wxAgent, surfaceById,
    ctx, core, config, guard, wx, archived,
  }
}

async function seedBoss(h, sessionId = 'boss-1', dir = h.dir) {  h.surfaceById.set(sessionId, 'work')
  await h.state.mutateSessions((s) => {
    s[dir] = {
      sessionId,
      dir,
      bossKind: 'fish',
      preset: 'fish-work-boss',
      backend: 'subagent',
      state: 'running',
      waitingQuestion: null,
      lastSummary: '',
      createdAt: new Date(1000).toISOString(),
      lastUsedAt: new Date(1000).toISOString(),
    }
  })
  return { session: { header: { id: sessionId, cwd: dir } } }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitSettled(h, unitId) {
  for (let i = 0; i < 200; i += 1) {
    const unit = h.state.readUnits().units.find((u) => u.id === unitId)
    if (unit && ['done', 'blocked', 'failed', 'aborted', 'unknown'].includes(unit.status)) return unit
    await tick()
  }
  throw new Error('unit did not settle')
}

test('目录校验：绝对路径、存在、受保护路径与祖先', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-dir-'))
  const proj = join(root, 'proj')
  await mkdir(proj, { recursive: true })
  assert.equal(validateWorkDir(proj).ok, true)
  assert.equal(validateWorkDir('relative/path').ok, false)
  assert.equal(validateWorkDir(join(root, 'missing')).ok, false)
  assert.equal(validateWorkDir(join(homedir(), '.ssh')).ok, false)
  assert.equal(validateWorkDir(join(homedir(), '.dsh-fish')).ok, false)
  assert.equal(validateWorkDir(homedir()).ok, false)
  assert.match(validateWorkDir(homedir()).why, /包含|受保护|太宽|工作区/)
  assert.equal(validateWorkDir('/').ok, false)
})

test('桌宠派活只接受受信轮次；微信只接受名单里的私聊', async () => {
  const h = await setup()
  const denied = await h.service.tools.her_work.execute({ dir: h.dir, task: '改一下' }, { agent: h.screen })
  assert.equal(denied.ok, false)
  assert.equal(h.created.length, 0)

  markTrustedTurn('screen-1', 1000)
  assert.equal(isTrustedTurn('screen-1', 1000), true)
  const ok = await h.service.tools.her_work.execute({ dir: h.dir, task: '改一下' }, { agent: h.screen })
  assert.equal(ok.ok, true)
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].preset, 'fish-work-boss')
  assert.equal(h.created[0].cwd, h.dir)
  assert.match(h.prompted[0].text, /目录：/)
  assert.match(h.prompted[0].text, /改一下/)
  clearTrustedTurn('screen-1')

  const wxOk = await h.service.tools.her_work.execute({ dir: h.dir, task: '微信派活' }, { agent: h.wxAgent })
  assert.equal(wxOk.ok, true)

  const h2 = await setup({ chat: '某个群' })
  const wxDenied = await h2.service.tools.her_work.execute({ dir: h2.dir, task: '群派活' }, { agent: h2.wxAgent })
  assert.equal(wxDenied.ok, false)
  assert.equal(h2.created.length, 0)
})

test('工头会话被归档后同目录新建，而不是把话投进死会话', async () => {
  const h = await setup()
  markTrustedTurn('screen-1', 1000)
  const first = await h.service.tools.her_work.execute({ dir: h.dir, task: '一' }, { agent: h.screen })
  assert.equal(first.ok, true)
  h.surfaceById.delete(first.sessionId)
  h.archived.push(first.sessionId)
  const second = await h.service.tools.her_work.execute({ dir: h.dir, task: '二' }, { agent: h.screen })
  assert.equal(second.ok, true)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(h.created.length, 2)
})

test('并发派活同一个目录只建一条工头会话', async () => {
  const h = await setup()
  markTrustedTurn('screen-1', 1000)
  const [a, b] = await Promise.all([
    h.service.tools.her_work.execute({ dir: h.dir, task: '一' }, { agent: h.screen }),
    h.service.tools.her_work.execute({ dir: h.dir, task: '二' }, { agent: h.screen }),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(h.created.length, 1)
  assert.equal(a.sessionId, b.sessionId)
})

test('同目录复用，不同目录新建；continue 用最近的目录', async () => {
  const h = await setup()
  markTrustedTurn('screen-1', 1000)
  const first = await h.service.tools.her_work.execute({ dir: h.dir, task: '一' }, { agent: h.screen })
  const again = await h.service.tools.her_work.execute({ dir: h.dir, task: '二' }, { agent: h.screen })
  assert.equal(first.reused, false)
  assert.equal(again.reused, true)
  assert.equal(again.sessionId, first.sessionId)
  const resumed = await h.service.tools.her_work.execute({ continue: true, task: '三' }, { agent: h.screen })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.sessionId, first.sessionId)
})

test('her_worker：非工头拒绝、权限校验、preset 与 outputSchema', async () => {
  const h = await setup()
  await seedBoss(h)
  const notBoss = await h.service.tools.her_worker.execute({ task: 'x' }, { agent: h.screen })
  assert.equal(notBoss.ok, false)

  const h2 = await setup({ permission: 'danger-full-access' })
  await seedBoss(h2)
  const badPerm = await h2.service.tools.her_worker.execute({ task: 'x' }, { agent: h2.boss })
  assert.equal(badPerm.ok, false)
  assert.match(badPerm.note, /workspace-write/)

  const h3 = await setup({ permission: 'THROW' })
  await seedBoss(h3)
  const unknownPerm = await h3.service.tools.her_worker.execute({ task: 'x' }, { agent: h3.boss })
  assert.equal(unknownPerm.ok, false)

  const inspect = await h.service.tools.her_worker.execute({ mode: 'inspect', task: '看看' }, { agent: h.boss })
  assert.equal(inspect.ok, true)
  assert.equal(h.backendCalls.spawn[0].preset, 'fish-work-inspect')
  assert.ok(h.backendCalls.spawn[0].outputSchema)

  const build = await h.service.tools.her_worker.execute({ mode: 'build', task: '改' }, { agent: h.boss })
  assert.equal(build.ok, true)
  assert.equal(h.backendCalls.spawn[1].preset, 'fish-work-build')
  assert.equal('outputSchema' in h.backendCalls.spawn[1], false)
})

test('并发派 build 不会超过 maxBuild', async () => {
  const h = await setup()
  await seedBoss(h)
  const [a, b] = await Promise.all([
    h.service.tools.her_worker.execute({ mode: 'build', task: 'a' }, { agent: h.boss }),
    h.service.tools.her_worker.execute({ mode: 'build', task: 'b' }, { agent: h.boss }),
  ])
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1)
})

test('worker 启动失败建 failed unit，不假装 running', async () => {
  const h = await setup()
  await seedBoss(h)
  const backend = {
    available: () => true,
    capabilities: () => ({}),
    spawn: async () => ({ ok: false, code: 'START_FAILED', why: 'boom' }),
  }
  const svc = createWorkService({
    ctx: h.ctx, core: h.core, config: h.config, state: h.state, backend, guard: h.guard, wx: h.wx, root: h.root,
  })
  const r = await svc.tools.her_worker.execute({ mode: 'inspect', task: 'x' }, { agent: h.boss })
  assert.equal(r.ok, false)
  const unit = h.state.readUnits().units[0]
  assert.equal(unit.status, 'failed')
  assert.equal(unit.failureKind, 'start')
  assert.match(unit.summary, /boom/)
})

test('her_worker 并行上限：总 2、build 1；宿主没有 subagents 时失败且不建 unit', async () => {
  const h = await setup()
  await seedBoss(h)
  await h.service.tools.her_worker.execute({ mode: 'build', task: 'b1' }, { agent: h.boss })
  const build2 = await h.service.tools.her_worker.execute({ mode: 'build', task: 'b2' }, { agent: h.boss })
  assert.equal(build2.ok, false)
  await h.service.tools.her_worker.execute({ mode: 'inspect', task: 'i1' }, { agent: h.boss })
  const third = await h.service.tools.her_worker.execute({ mode: 'inspect', task: 'i2' }, { agent: h.boss })
  assert.equal(third.ok, false)

  const h2 = await setup()
  await seedBoss(h2)
  const backend = { available: () => false, capabilities: () => ({}), spawn: async () => ({ ok: false, code: 'NO_SUBAGENTS' }) }
  const svc = createWorkService({
    ctx: h2.ctx, core: h2.core, config: h2.config, state: h2.state, backend, guard: h2.guard, wx: h2.wx, root: h2.root,
  })
  const r = await svc.tools.her_worker.execute({ task: 'x' }, { agent: h2.boss })
  assert.equal(r.ok, false)
  assert.equal(h2.state.readUnits().units.length, 0)
})

test('结算写 WorkUnit，通知状态机区分派出/完成/等待', async () => {
  const h = await setup()
  await seedBoss(h)
  const r = await h.service.tools.her_worker.execute({ mode: 'inspect', task: '看看' }, { agent: h.boss })
  assert.equal(r.ok, true)
  await h.service.onSessionEvent(h.boss, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await tick()
  assert.match(h.notified.at(-1)?.text ?? '', /派出/)

  h.settle({ stopReason: 'completed', output: [{ type: 'text', text: '看完了' }], structured: { summary: '看完了', done: true } })
  await waitSettled(h, r.unitId)
  await tick()
  await h.service.onSessionEvent(h.boss, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '看完了，没问题。' }] } },
  })
  await h.service.onSessionEvent(h.boss, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await tick()
  assert.match(h.notified.at(-1)?.text ?? '', /做完/)
  const unit = h.state.readUnits().units[0]
  assert.equal(unit.status, 'done')
  assert.equal(unit.summary, '看完了')

  await h.service.tools.her_ask_user.execute({ question: '要删吗？' }, { agent: h.boss })
  await h.service.onSessionEvent(h.boss, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  await tick()
  assert.match(h.notified.at(-1)?.text ?? '', /等你/)
  assert.match(h.notified.at(-1)?.text ?? '', /要删吗/)
})

test('her_worker_control：已结算不能 message，list/get 不返回原始日志', async () => {
  const h = await setup()
  await seedBoss(h)
  const started = await h.service.tools.her_worker.execute({ mode: 'inspect', task: '看看' }, { agent: h.boss })
  const list = await h.service.tools.her_worker_control.execute({ action: 'list' }, { agent: h.boss })
  assert.equal(list.ok, true)
  assert.equal(list.units.length, 1)
  assert.equal(list.units[0].unitId, started.unitId)

  const msg = await h.service.tools.her_worker_control.execute({ action: 'message', unitId: started.unitId, text: '继续' }, { agent: h.boss })
  assert.equal(msg.ok, true)

  h.settle({ stopReason: 'completed', output: [{ type: 'text', text: '好了' }] })
  await waitSettled(h, started.unitId)
  await tick()
  const settled = await h.service.tools.her_worker_control.execute({ action: 'message', unitId: started.unitId, text: '再继续' }, { agent: h.boss })
  assert.equal(settled.ok, false)
  assert.equal(settled.why, 'unit-settled')

  const got = await h.service.tools.her_worker_control.execute({ action: 'get', unitId: started.unitId }, { agent: h.boss })
  assert.equal(got.ok, true)
  assert.equal(got.summary, '好了')
  assert.equal('logs' in got, false)
})
