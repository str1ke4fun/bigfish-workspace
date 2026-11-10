/**
 * outing.test.mjs —— B 站出门会话（2026-11-10）
 *
 * 守三件事：
 *   ① 会话幂等：同一个工作区/会话不会越建越多，归档/删掉后会重建；
 *   ② 面登记**先于** create：`agent/created` 是同步发出的，晚一步她就会
 *      先以 web 面装配一次（拿到的就是屋子的工具）；
 *   ③ 投递只落在出门会话：素材和回复进 `fish:wake` 段、对话里只有触发语，
 *      配额记账只追加，home 那条会话的处境段不受影响。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureBiliSession,
  maybeOuting,
  outingCountToday,
  outingQuota,
  outingDir,
  lastOutingAt,
  replyScanGapMs,
  resetOutingState,
  TITLE_OUTING_SESSION,
  TITLE_OUTING_WORKSPACE,
} from '../lib/outing.js'
import { readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { setWakeSection, clearWakeSection, getWakeSection } from '../lib/identity.js'
import { BILI_TRIGGER } from '../lib/wakeconst.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-outing-'))
  try { return await fn(root) } finally {
    clearWakeSection()
    resetOutingState()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假宿主：workspaceRegistry + sessionController + fishCore.surface + 事件总线。 */
function fakeCtx({ registry = {}, createImpl, promptImpl } = {}) {
  const created = []
  const prompts = []
  const renamed = []
  const reservations = []
  const listeners = new Set()
  const archived = []
  const sessions = new Map()

  const reg = {
    list: () => [...sessions.values()],
    create: async (path, title) => {
      const w = { id: `ws-${sessions.size + 1}`, path, title, sessionIds: [], setTitle: null }
      w.setTitle = async (t) => { w.title = t }
      sessions.set(w.id, w)
      return w
    },
    get: (id) => sessions.get(id) ?? null,
    archivedSessionIds: archived,
  }

  const ctx = {
    workspaceRegistry: reg,
    sessionController: {
      async create(req) {
        created.push(req)
        if (createImpl) return createImpl(req, { sessions })
        if (req.sessionId && (registry.rejectSessionId ?? false)) throw new Error('id rejected')
        const ws = sessions.get(req.workspaceId)
        const id = req.sessionId && !(registry.ignoreSessionId) ? req.sessionId : `ses-${created.length}`
        if (ws && !ws.sessionIds.includes(id)) ws.sessionIds.push(id)
        return { sessionId: id }
      },
      async rename(arg) { renamed.push(arg) },
      async prompt(payload) { prompts.push(payload); if (promptImpl) await promptImpl(payload) },
    },
    fishCore: { surface: { reserve: (id, s) => reservations.push([id, s]) } },
    on(event, fn) { listeners.add(fn); return () => listeners.delete(fn) },
    get(key) { return ctx[key] },
  }
  return { ctx, created, prompts, renamed, reservations, listeners, sessions, reg }
}

const NOW = new Date(2026, 10, 10, 12, 0, 0)

function fireTurnEnd(listeners, sessionId) {
  for (const fn of [...listeners]) fn({ header: { id: sessionId } }, { type: 'turn/end' })
}

// ---------------------------------------------------------------------------
// ensureBiliSession
// ---------------------------------------------------------------------------

test('ensureBiliSession：工作区在 home/bili，会话标题「去 B 站」，状态落盘', async () => {
  await withRoot(async (root) => {
    const { ctx, prompts } = fakeCtx()
    const out = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    assert.equal(out.ok, true, out.why)
    assert.equal(out.dir, join(root, 'home', 'bili'))
    assert.match(out.sessionId, /^[0-9a-f-]{36}$/)
    await stat(out.dir)

    const saved = JSON.parse(await readFile(join(root, 'bili-session.json'), 'utf8'))
    assert.equal(saved.sessionId, out.sessionId)
    assert.equal(saved.wsId, out.wsId)
    assert.equal(saved.title, TITLE_OUTING_SESSION)

    const ws = ctx.get('workspaceRegistry').get(out.wsId)
    assert.equal(ws.title, TITLE_OUTING_WORKSPACE)
    assert.deepEqual(ws.sessionIds, [out.sessionId])
    // wakeOnCreate:false 时不许自己跑一轮
    assert.equal(prompts.length, 0)
  })
})

test('ensureBiliSession：面登记先于 create（预分配 id 先 reserve，再建会话）', async () => {
  await withRoot(async (root) => {
    const { ctx, created, reservations } = fakeCtx()
    const out = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    const first = created[0]
    assert.ok(first.sessionId, 'create 要带预分配 id')
    // 预分配那个 id 必须已经登记成 bili 面（create 之前）
    assert.deepEqual(reservations[0], [first.sessionId, 'bili'])
    assert.equal(out.sessionId, first.sessionId)
    // 宿主返回的 id 回来后还要再登记一次（返回值可能和请求不同）
    assert.ok(reservations.some(([id, s]) => id === out.sessionId && s === 'bili'))
  })
})

test('ensureBiliSession：宿主不认预分配 id 时以返回值落盘', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx({ registry: { ignoreSessionId: true } })
    const out = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    assert.equal(out.ok, true, out.why)
    assert.match(out.sessionId, /^ses-/)
    const saved = JSON.parse(await readFile(join(root, 'bili-session.json'), 'utf8'))
    assert.equal(saved.sessionId, out.sessionId)
  })
})

test('ensureBiliSession：第二次调用复用，不再多建会话', async () => {
  await withRoot(async (root) => {
    const { ctx, created } = fakeCtx()
    const a = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    const createdOnce = created.length
    const b = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    assert.equal(b.ok, true)
    assert.equal(b.sessionId, a.sessionId)
    assert.equal(b.reused, true)
    assert.equal(created.length, createdOnce, '复用不该再 create 一次')
  })
})

test('ensureBiliSession：会话被归档后重建，状态文件跟着换', async () => {
  await withRoot(async (root) => {
    const { ctx, listeners } = fakeCtx()
    const a = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    ctx.get('workspaceRegistry').archivedSessionIds.push(a.sessionId)
    const b = await ensureBiliSession(ctx, { root, wakeOnCreate: false })
    assert.equal(b.ok, true, b.why)
    assert.notEqual(b.sessionId, a.sessionId)
    const saved = JSON.parse(await readFile(join(root, 'bili-session.json'), 'utf8'))
    assert.equal(saved.sessionId, b.sessionId)
    void listeners
  })
})

test('ensureBiliSession：宿主没有 sessionController 时明确说不行，不抛', async () => {
  await withRoot(async (root) => {
    const out = await ensureBiliSession({ get: () => null }, { root, wakeOnCreate: false })
    assert.equal(out.ok, false)
    assert.match(out.why, /sessionController/)
  })
})

test('ensureBiliSession：新建时叫一声（宿主的侧栏只显示跑过的会话）', async () => {
  await withRoot(async (root) => {
    const { ctx, prompts, listeners } = fakeCtx()
    const out = await ensureBiliSession(ctx, { root })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, out.sessionId)
    assert.equal(prompts[0].content[0].text, BILI_TRIGGER)
    assert.ok(getWakeSection(out.sessionId).includes('你出门了'))
    // 回合结束只清这一条会话的处境段
    fireTurnEnd(listeners, out.sessionId)
    assert.equal(getWakeSection(out.sessionId), '')
  })
})

// ---------------------------------------------------------------------------
// maybeOuting
// ---------------------------------------------------------------------------

function stubSession(sessionId = 'ses-out') {
  return { ok: true, sessionId, wsId: 'ws-1', reused: true }
}

test('maybeOuting：没有素材也没有回复时不出门', async () => {
  await withRoot(async (root) => {
    const { ctx, prompts } = fakeCtx()
    const r = await maybeOuting(ctx, {
      root,
      config: normalizeConfig({ comment: { enabled: false } }),
      events: [],
      dk: '2026-11-10',
      now: NOW,
      ensureSession: async () => stubSession(),
    })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'nothing-to-see')
    assert.equal(prompts.length, 0)
  })
})

test('maybeOuting：素材投进出门会话，对话里只有触发语，只追加 biliout 记账', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ comment: { enabled: false } }), root)
    const { ctx, prompts, listeners } = fakeCtx()
    setWakeSection('屋子里的处境', 'ses-home')

    const r = await maybeOuting(ctx, {
      root,
      config: normalizeConfig({ comment: { enabled: false } }),
      events: [],
      dk: '2026-11-10',
      now: NOW,
      material: '## 屏幕上有人在说话\n\n- 一条视频',
      picks: [],
      ensureSession: async () => stubSession('ses-out'),
      log: () => {},
    })
    assert.equal(r.ok, true, r.why)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, 'ses-out')
    assert.equal(prompts[0].content[0].text, BILI_TRIGGER)

    // 正文走 system prompt 段：只给出门会话看
    const wake = getWakeSection('ses-out')
    assert.ok(wake.includes('屏幕上有人在说话'), '素材要在出门会话的 wake 段里')
    assert.ok(!wake.includes('屋子里的处境'))
    assert.equal(getWakeSection('ses-home'), '屋子里的处境', 'home 的处境段不受影响')
    assert.equal(getWakeSection(), '', '不能写全局段')

    // 记账只追加一条
    const { events } = await readEvents(root)
    const metas = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('biliout:'))
    assert.equal(metas.length, 1)
    assert.equal(metas[0].text, 'biliout:2026-11-10 browse')

    fireTurnEnd(listeners, 'ses-out')
    assert.equal(getWakeSection('ses-out'), '')
    assert.equal(getWakeSection('ses-home'), '屋子里的处境', '清的是这一条会话，不是所有')
  })
})

test('maybeOuting：当日额度用完就不出门', async () => {
  await withRoot(async (root) => {
    const config = normalizeConfig({ browse: { perDay: 1 }, comment: { enabled: false } })
    const events = [
      { type: 'meta', text: 'biliout:2026-11-10 browse', ts: NOW.toISOString() },
    ]
    const { ctx, prompts } = fakeCtx()
    const r = await maybeOuting(ctx, {
      root, config, events, dk: '2026-11-10', now: NOW,
      material: 'x', ensureSession: async () => stubSession(),
    })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'quota-full')
    assert.equal(prompts.length, 0)
  })
})

test('maybeOuting：只带回复出门时，两次之间至少隔一小时', async () => {
  await withRoot(async (root) => {
    const config = normalizeConfig({
      browse: { perDay: 3 },
      comment: { enabled: true, window: ['00:00', '23:59'] },
    })
    // 上一次出门在 30 分钟前
    const events = [
      { type: 'meta', text: 'biliout:2026-11-10 replies', ts: new Date(NOW.getTime() - 30 * 60_000).toISOString() },
    ]
    const { ctx, prompts } = fakeCtx()
    const r = await maybeOuting(ctx, {
      root, config, events, dk: '2026-11-10', now: NOW,
      ensureSession: async () => stubSession(),
    })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'min-gap')
    assert.equal(prompts.length, 0)
  })
})

test('maybeOuting：会话没就绪时跳过，不抛、不记账', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx()
    const r = await maybeOuting(ctx, {
      root,
      config: normalizeConfig({ comment: { enabled: false } }),
      events: [],
      dk: '2026-11-10',
      now: NOW,
      material: 'x',
      ensureSession: async () => ({ ok: false, why: '宿主没有 workspaceRegistry 服务' }),
      log: () => {},
    })
    assert.equal(r.ok, false)
    assert.match(r.why, /workspaceRegistry/)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text).startsWith('biliout:')).length, 0)
  })
})

test('配额与计数：biliout 按日期数，上限跟刷站配额走、至少一次', () => {
  const events = [
    { type: 'meta', text: 'biliout:2026-11-10 browse' },
    { type: 'meta', text: 'biliout:2026-11-10 replies' },
    { type: 'meta', text: 'biliout:2026-11-09 browse' },
    { type: 'meta', text: 'wake:2026-11-10 t1' },
  ]
  assert.equal(outingCountToday(events, '2026-11-10'), 2)
  assert.equal(outingQuota({ browse: { perDay: 3 } }), 3)
  assert.equal(outingQuota({ browse: { perDay: 0 } }), 1, '关掉刷站也要留一次自己出门的机会')
  assert.equal(outingQuota({ browse: { perDay: 99 } }), 4, '最多 4 次')
  assert.equal(lastOutingAt([]), 0)
})

test('回复扫描间隔跟 comment.scanEveryMin 走，缺省 30 分钟、夹在 5 分钟到 12 小时', () => {
  assert.equal(replyScanGapMs({}), 30 * 60_000)
  assert.equal(replyScanGapMs({ comment: { scanEveryMin: 120 } }), 120 * 60_000)
  assert.equal(replyScanGapMs({ comment: { scanEveryMin: 1 } }), 5 * 60_000)
  assert.equal(replyScanGapMs({ comment: { scanEveryMin: 99999 } }), 720 * 60_000)
  assert.equal(replyScanGapMs({ comment: { scanEveryMin: 'abc' } }), 30 * 60_000)
})

test('出门目录固定是 root/home/bili（面判定靠这个 cwd）', async () => {
  await withRoot(async (root) => {
    assert.equal(outingDir(root), join(root, 'home', 'bili'))
    void dateKey
  })
})
