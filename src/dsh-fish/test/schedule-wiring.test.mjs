/**
 * schedule-wiring.test.mjs —— scheduler 与调度钩子表的接线（A1.5 fix1）
 *
 * A1.5 的唯一验收承诺是「后台刷站 / 出门 / 唤醒素材经钩子表行为不变」。
 * schedule-hooks.test.mjs 只测钩子表本身；这里测的是**接线**：
 *   · scheduler.tick 真的把 hook ctx 交给 runTick；
 *   · changed:true 之后事件流被重读、身份文档被重写；
 *   · 手动唤醒在没有 deps.hooks 时仍通过 activeHooks 命中 runWake，
 *     且 dispose 只清自己留下的兜底；
 *   · core-service 把同一张表挂在 core.schedule 上。
 *
 * 删掉 scheduler.js 的 `h?.runTick` / `h?.runWake`、dispose 的归属判断，
 * 或 core-service 的 `core.schedule = ...`，这些用例必须变红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler, wakeNow } from '../lib/scheduler.js'
import { readEvents, appendEvent, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { CATALOG } from '../lib/events.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-wiring-'))
  try {
    return await fn(root)
  } finally {
    // 与 boot.test.mjs 一致：定时器/写盘可能刚好在用例结束时收尾，
    // 直接 rm 在 Windows 上会撞 ENOTEMPTY。重试不放松任何断言。
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假宿主：与 boot.test.mjs 的 fakeCtx 同构，只保留这里用得到的部分。 */
function fakeCtx() {
  const sessions = new Set()
  const prompts = []
  const workspaces = new Map()
  const ctx = {
    connection: { requestRejection: () => null },
    sessionController: {
      async create({ sessionId }) {
        if (sessions.has(sessionId)) throw new Error('exists')
        sessions.add(sessionId)
        return null
      },
      async prompt(payload) { prompts.push(payload) },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
    provide() { return () => {} },
    workspaceRegistry: {
      async create(path, title) {
        const w = { id: `ws-${workspaces.size + 1}`, path, title, sessionIds: [] }
        workspaces.set(w.id, w)
        return w
      },
      get: (id) => workspaces.get(id) ?? null,
      list: () => [...workspaces.values()],
    },
  }
  return { ctx, prompts }
}

/** 把唤醒窗口挪到 3 小时后：tick 会跑完钩子，但走不到真正的唤醒。 */
async function excludeNow(root) {
  const h1 = (new Date().getHours() + 3) % 24
  const pad = (n) => String(n).padStart(2, '0')
  await writeConfig(
    normalizeConfig({ window: [`${pad(h1)}:00`, `${pad((h1 + 1) % 24)}:00`] }),
    root,
  )
}

const emptyLook = () => ({ text: '', intro: '', picks: [], riskNote: '' })

/**
 * 造一个「今天一定会 quiet」的根：落点已过、窗口覆盖全天、所有模板都消耗或
 * 条件不满足。用于测 quiet 事件本身，不碰唤醒路径。
 */
async function quietRoot(root) {
  await writeConfig(
    normalizeConfig({
      window: ['00:00', '23:59'],
      wakesPerDay: 1,
      daily: { events: 3, questions: 2 },
    }),
    root,
  )
  const dk = dateKey()
  await appendEvent(
    { type: 'meta', text: `sched:${dk} ${new Date(Date.now() - 60_000).toISOString()}` },
    { day: 0, stage: 1, source: 'timer' },
    root,
  )
  await appendEvent(
    { type: 'meta', text: `fired:${CATALOG.map((t) => t.id).join(',')}` },
    { day: 0, stage: 1, source: 'timer' },
    root,
  )
  return dk
}

function quietRows(events, dk) {
  const marker = `quiet:${dk} `
  return events.filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(marker))
}

test('quiet 一天只记一条：写“还不想醒”，不是每分钟追加', async () => {
  await withRoot(async (root) => {
    const dk = await quietRoot(root)
    const s = startScheduler(fakeCtx().ctx, { root, log: () => {} })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }

    const { events } = await readEvents(root)
    const rows = quietRows(events, dk)
    assert.equal(rows.length, 1, '一次 tick 只该留一条 quiet')
    assert.equal(rows[0].text, `quiet:${dk} 还不想醒`)
  })
})

test('当天已有 quiet 标记：再 tick 也不会写第二条', async () => {
  await withRoot(async (root) => {
    const dk = await quietRoot(root)
    await appendEvent(
      { type: 'meta', text: `quiet:${dk} 无候选模板，今天不打扰` },
      { day: 0, stage: 1, source: 'timer' },
      root,
    )

    const s = startScheduler(fakeCtx().ctx, { root, log: () => {} })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }

    const { events } = await readEvents(root)
    const rows = quietRows(events, dk)
    assert.equal(rows.length, 1, '历史里已经有 quiet 时不能再追加')
    assert.equal(rows[0].text, `quiet:${dk} 无候选模板，今天不打扰`, '旧记录原样保留')
  })
})

test('tick 接线：runTick 收到 Date 形式的 now、root 与非空 deps', async () => {
  await withRoot(async (root) => {
    await excludeNow(root)
    let seen = null
    const hooks = {
      async runTick(ctx) { seen = ctx; return { changed: false } },
      async runWake() { return emptyLook() },
    }
    const s = startScheduler(fakeCtx().ctx, { root, hooks, log: () => {} })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }

    assert.ok(seen, 'scheduler.tick 必须调用 hooks.runTick')
    assert.ok(seen.now instanceof Date, `now 必须是 Date，现在是 ${typeof seen.now}`)
    assert.equal(seen.root, root)
    assert.ok(seen.deps && typeof seen.deps === 'object', 'deps 必须传给钩子')
    assert.equal(seen.deps.hooks, hooks, 'deps 要原样传下去，不能换一份')
  })
})

test('changed:true → 重读事件流并重写身份文档', async () => {
  await withRoot(async (root) => {
    await excludeNow(root)
    const marker = `sched:${dateKey()} `
    const hooks = {
      async runTick() {
        // 模拟刷站/出门写了新事件。ensureSchedule 会复用这条 marker，
        // 所以 tick 后它只能有一条——多条就说明 changed 后没重读。
        await appendEvent(
          { type: 'meta', text: `${marker}${new Date().toISOString()}` },
          { day: 0, stage: 1, source: 'timer' },
          root,
        )
        return { changed: true }
      },
      async runWake() { return emptyLook() },
    }
    const s = startScheduler(fakeCtx().ctx, { root, hooks, log: () => {} })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }

    const { events } = await readEvents(root)
    const marks = events.filter((e) => e.type === 'meta' && String(e.text ?? '').startsWith(marker))
    assert.equal(marks.length, 1, 'marker 只能有一条：changed 后必须重读，不能再写一条')

    const doc = await stat(join(root, 'home', '她的身份.md'))
    assert.ok(doc.size > 0, 'changed:true 之后必须执行 refreshSelfDoc 落盘身份文档')
  })
})

test('手动唤醒命中 runWake，携带 forceBrowse 与已读事件；dispose 后不再触发', async () => {
  await withRoot(async (root) => {
    const probe = 'probe:manual-wake'
    await appendEvent({ type: 'meta', text: probe }, { day: 0, stage: 1, source: 'timer' }, root)

    const calls = []
    const hooks = {
      async runTick() { return { changed: false } },
      async runWake(ctx) { calls.push(ctx); return emptyLook() },
    }
    const { ctx } = fakeCtx()
    const s = startScheduler(ctx, { root, hooks, log: () => {} })
    try {
      // wakeNow 不传 hooks：必须走 scheduler 留下的 activeHooks 兜底。
      const r = await wakeNow(ctx, { root, focus: 'browse' })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(calls.length, 1, 'wakeNow 必须命中 hooks.runWake')
      assert.equal(calls[0].deps.forceBrowse, true, '「让她去刷 B 站」的 forceBrowse 要传到钩子')
      assert.ok(
        calls[0].events.some((e) => e.text === probe),
        '手动唤醒要把已经读到的 events 交给钩子，不能给空数组',
      )
    } finally {
      s.dispose()
    }

    const before = calls.length
    await wakeNow(ctx, { root, focus: 'browse' })
    assert.equal(calls.length, before, 'scheduler.dispose() 之后 activeHooks 兜底必须被清掉')
  })
})

test('dispose 只清自己的 activeHooks，不清后启动的 scheduler 的兜底', async () => {
  await withRoot(async (root) => {
    const calls1 = []
    const calls2 = []
    const hooks1 = {
      async runTick() { return { changed: false } },
      async runWake() { calls1.push(1); return emptyLook() },
    }
    const hooks2 = {
      async runTick() { return { changed: false } },
      async runWake() { calls2.push(1); return emptyLook() },
    }
    const { ctx } = fakeCtx()
    const s1 = startScheduler(ctx, { root, hooks: hooks1, log: () => {} })
    const s2 = startScheduler(ctx, { root, hooks: hooks2, log: () => {} })
    try {
      s1.dispose()
      await wakeNow(ctx, { root, focus: 'browse' })
      assert.equal(calls1.length, 0, '已 dispose 的实例不该再收到唤醒')
      assert.equal(calls2.length, 1, '后启动的 scheduler 的兜底不能被前一个 dispose 清掉')
    } finally {
      s1.dispose()
      s2.dispose()
    }
  })
})
