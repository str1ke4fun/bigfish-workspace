// 跨模块派活：微信会话名与 dispatchChats 的名字比较；审计保留 emoji。
// 只测合成数据，不读 ~/.dsh-wx，不启动微信。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkState } from '../lib/work-state.js'
import { createWorkService, sameDispatchChat } from '../lib/work.js'
import { toolEchoRate } from '../lib/feedback-audit.js'

test('dispatchChats 在 VS16 变体下仍放行', () => {
  const same = (a, b) => a.replace(/️/gu, '') === b.replace(/️/gu, '')
  assert.equal(sameDispatchChat('❤️读书群', ['❤读书群'], same), true)
  assert.equal(sameDispatchChat('别的群', ['❤读书群'], same), false)
})

test('没有注入口径时回退到 trim + 压空白，不猜 emoji 变体', () => {
  assert.equal(sameDispatchChat('  ❤️读书群  ', ['❤️读书群']), true)
  assert.equal(sameDispatchChat('❤️ 读书群', ['❤️ 读书群']), true)
  assert.equal(sameDispatchChat('❤️读书群', ['❤读书群']), false)
  assert.equal(sameDispatchChat('', ['']), false)
  assert.equal(sameDispatchChat('某群', null), false)
})

async function dispatchService({ chat, dispatchChats, sameChatName }) {
  const base = await mkdtemp(join(tmpdir(), 'fish-work-dispatch-'))
  const root = join(base, 'fish')
  const dir = join(base, 'proj')
  await mkdir(root, { recursive: true })
  await mkdir(dir, { recursive: true })
  const state = createWorkState({ root })
  const created = []
  const surfaces = new Map([['wx-1', 'wx']])
  const wx = { currentChat: () => chat }
  if (sameChatName) wx.sameChatName = sameChatName
  const core = {
    surface: {
      current: (agent) => surfaces.get(agent?.session?.header?.id ?? agent?.session?.id ?? '') ?? null,
      reserve: (id, s) => surfaces.set(id, s),
    },
    sessions: {
      async create(input) { created.push(input); return { ok: true, sessionId: input.sessionId ?? `boss-${created.length}` } },
      async prompt() { return { ok: true } },
      async list() { return [] },
    },
  }
  const ctx = {
    get: (name) => (name === 'wx' ? wx : null),
    on: () => () => {},
  }
  const backend = {
    available: () => true,
    capabilities: () => ({ structuredOutput: true }),
    async spawn() { throw new Error('not used') },
    async message() { return { ok: true } },
    async interrupt() {},
    onSettle() { return () => {} },
  }
  const service = createWorkService({
    ctx, core, state, backend,
    guard: { status: () => ({ ok: true }), flushHits: () => 0 },
    config: {
      work: {
        wx: { dispatchChats, ownerChat: dispatchChats[0] },
        delegation: {
          bossKind: 'fish', backend: 'subagent', structuredOutput: 'inspect-only',
          maxActive: 2, maxBuild: 1, runTimeoutMs: 60_000,
        },
      },
    },
    root, now: () => 1000, log: () => {},
  })
  const agent = { session: { header: { id: 'wx-1', cwd: dir }, snapshotEvents: () => [] } }
  return { service, agent, dir, created }
}

test('her_work 用 wxService.sameChatName 比较派活名单', async () => {
  const same = (a, b) => a.replace(/️/gu, '') === b.replace(/️/gu, '')
  const h = await dispatchService({
    chat: '❤️读书群',
    dispatchChats: ['❤读书群'],
    sameChatName: same,
  })
  const allowed = await h.service.tools.her_work.execute({ dir: h.dir, task: '改一下' }, { agent: h.agent })
  assert.equal(allowed.ok, true)
  assert.equal(h.created.length, 1)

  const denied = await dispatchService({
    chat: '❤️读书群',
    dispatchChats: ['❤读书群'],
  })
  const rejected = await denied.service.tools.her_work.execute({ dir: denied.dir, task: '改一下' }, { agent: denied.agent })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'NOT_TRUSTED_CHAT')
  assert.equal(denied.created.length, 0)
})

test('审计对比保留 Extended_Pictographic：emoji 回声仍算工具回声', () => {
  const records = [{
    surface: 'wx',
    kind: 'send',
    toolStatus: 'success',
    projection: '已发送❤️🎉🌊🏖️',
    reply: '已发送❤️🎉🌊🏖️',
  }]
  assert.equal(toolEchoRate(records), 1)
})
