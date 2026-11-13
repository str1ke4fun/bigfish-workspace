/**
 * index.test.mjs —— 生产路径把 B 站面挂齐（A2）
 *
 * 钉住五件事：工具、策略表贡献、调度钩子、bili 面提示段、`bili` 服务与路由。
 * 假宿主只实现窄接口，不联网、不碰真实状态库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { fakeCore, fakeHost, fakeSessions, fakeWorkspaces } from './helpers.mjs'

async function boot({ config = { browse: { enabled: true }, comment: { enabled: false } }, events = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-index-'))
  const { core, calls } = fakeCore({ config, events })
  const ctx = fakeHost({
    core,
    tools: ['bili_look', 'bili_watch', 'bili_speak'],
    services: {
      sessionController: fakeSessions(),
      workspaceRegistry: fakeWorkspaces(),
    },
  })
  const handle = apply(ctx, { root })
  const deadline = Date.now() + 3000
  while (!ctx.provided.has('bili') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return { root, core, calls, ctx, handle }
}

test('注册 3 个 B 站工具，并只为自己担保贡献策略表', async () => {
  const { ctx, calls, handle } = await boot()
  try {
    assert.deepEqual(ctx.registered.map((d) => d.name).sort(), ['bili_look', 'bili_speak', 'bili_watch'])
    assert.equal(calls.contributions.length, 1)
    assert.equal(calls.contributions[0].def.id, 'bili')
    assert.deepEqual(calls.contributions[0].def.tools.map((t) => t.name).sort(), ['bili_look', 'bili_speak', 'bili_watch'])
  } finally { handle.dispose() }
})

test('往同一张 core.schedule 表挂刷站与醒来素材两个钩子', async () => {
  const { core, handle } = await boot()
  try {
    const st = core.schedule.status()
    assert.ok(st.tick.some((x) => x.id === 'bili-browse'), '刷站/出门 tick 钩子没挂上')
    assert.ok(st.wake.some((x) => x.id === 'bili-material'), '醒来素材 wake 钩子没挂上')
  } finally { handle.dispose() }
})

test('提示段只挂 bili 面，内容随配置与最近刷到的变化', async () => {
  const events = [
    { type: 'saw', ts: '2026-11-12T10:00:00Z', text: '看到一条测试视频' },
  ]
  const { calls, handle } = await boot({ events })
  try {
    assert.equal(calls.sections.length, 1)
    const sec = calls.sections[0]
    assert.equal(sec.id, 'fish:bili')
    assert.equal(sec.surface, 'bili')
    const text = sec.render()
    assert.match(text, /## 上网/)
    assert.match(text, /bili_look/)
    assert.match(text, /## 我最近刷到的/)
    assert.match(text, /看到一条测试视频/)
    assert.doesNotMatch(text, /## 在网上说话/, '评论关着时不该出现说话段')
  } finally { handle.dispose() }
})

test('provide bili 服务并注册 /dsh-bili 前缀路由', async () => {
  const { ctx, handle } = await boot()
  try {
    assert.ok(ctx.provided.get('bili'), 'bili 服务必须 provide')
    const paths = ctx.routes.map((r) => r.path)
    for (const p of ['/status', '/browse', '/history', '/footprint', '/comment-body', '/comment', '/risk', '/cover', '/sheet', '/ledger', '/outings']) {
      assert.ok(paths.some((x) => x === `/dsh-bili${p}`), `缺路由 ${p}`)
    }
  } finally { handle.dispose() }
})

test('建/复用出门会话并落 bili-session.json', async () => {
  const { root, handle } = await boot()
  try {
    const saved = JSON.parse(await readFile(join(root, 'bili-session.json'), 'utf8'))
    assert.equal(saved.wsId, 'ws-bili')
    assert.equal(saved.title, '去 B 站')
    assert.ok(saved.sessionId)
  } finally { handle.dispose() }
})

test('dispose 停掉一切：钩子、服务、定时器都不再活动', async () => {
  const { core, ctx, handle } = await boot()
  handle.dispose()
  // dispose 是异步 abort 后立刻返回；给 boot 一点时间收尾。
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(!core.schedule.status().tick.some((x) => x.id === 'bili-browse'))
  assert.ok(!core.schedule.status().wake.some((x) => x.id === 'bili-material'))
  assert.ok(!ctx.provided.has('bili'))
})
