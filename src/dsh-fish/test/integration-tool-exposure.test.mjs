/**
 * integration-tool-exposure.test.mjs —— Task 12：假宿主端到端闭环
 *
 * 不开真宿主、不连微信：用最小的假 ctx / 假 agent 把整条链路走一遍——
 *
 *   面判定 → allow → restrict → her_tools 目录 → load → 下一步 allow + guard + 台账
 *
 * 这条测试要抓的是「各模块单独都对、接起来却不对」的断点。Task 6 就出现过一次：
 * 启动期宿主名单里还没有本插件自己的工具，hostNames 过滤把自有工具整批剥掉。
 * 所以这里的接线必须照生产 index.js 抄一遍，而不是每个模块各测各的。
 *
 * 面判定按生产协议走：
 *   - web：会话 cwd 就是她的屋子，由 web matcher 命中；
 *   - wx ：dsh-wx 在会话存在之前预分配 id，靠 reserve 登记，绝不拿 cwd 猜。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { provideFishCore } from '../lib/core-service.js'
import { looksLikeSecret } from '../lib/guard.js'
import {
  FISH_TOOLS,
  getAgentToolState,
  registerToolRestrict,
  revealTools,
} from '../lib/restrict.js'
import {
  catalog,
  describeEntry,
  entriesFor,
  groupsFor,
  loadTargets,
  resolveAllow,
} from '../lib/tool-policy.js'
import { registerHerTools } from '../lib/tools.js'
import { createToolLedger } from '../lib/tool-ledger.js'

/** 生产里 index.js 传给 registerToolRestrict 的 ownTools。 */
const OWN_TOOLS = [...FISH_TOOLS, 'her_tools']

/**
 * 宿主在 wx 面上真实注册过的工具名（假宿主按真名登记）。
 * 必须把自有工具一起列进来：agent/created 发生在插件注册工具之前，
 * 少了它们，启动期的 hostNames 过滤会把自有工具剥掉。
 */
const WX_HOST_TOOLS = [
  'read_image',
  'wx_peek', 'wx_send', 'wx_context', 'wx_task_done', 'wx_task_snooze',
  'wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr',
  'wx_sticker_scan', 'wx_sticker_list', 'wx_sticker_find', 'wx_sticker_tag',
  'wx_sticker_send', 'wx_sticker_collect', 'wx_sticker_search',
  'wx_history',
]

/** wx 面策略表里的全部 deferred 工具：目录只该从这里出。 */
const WX_DEFERRED = [
  'wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr',
  'wx_sticker_scan', 'wx_sticker_list', 'wx_sticker_find', 'wx_sticker_tag',
  'wx_sticker_send', 'wx_sticker_collect', 'wx_sticker_search',
  'wx_history',
]

/** 够用的假插件 ctx：provide / get / on / emit / tools.register。 */
function fakeCtx() {
  const listeners = new Map()
  const services = new Map()
  const defs = new Map()
  return {
    defs,
    ctx: {
      tools: {
        register(def) {
          defs.set(def.name, def)
          return () => { defs.delete(def.name) }
        },
      },
      provide(name, value) {
        services.set(name, value)
        return () => { services.delete(name) }
      },
      get(name) {
        return services.get(name)
      },
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, [])
        listeners.get(ev).push(fn)
        return () => {
          const arr = listeners.get(ev) ?? []
          const i = arr.indexOf(fn)
          if (i >= 0) arr.splice(i, 1)
        }
      },
      emit(ev, ...args) {
        for (const fn of [...(listeners.get(ev) ?? [])]) fn(...args)
      },
    },
  }
}

/**
 * 假 agent：`ctx.tools` 只实现本链路用到的三个方法。
 * `restrict` 模仿宿主做名字校验——名字不在 view 里就抛，避免测试悄悄放过拼写错误。
 */
function fakeAgent({ id, cwd, hostNames }) {
  const known = new Set(hostNames)
  const calls = []
  const guards = []
  let disposed = 0
  return {
    calls,
    guards,
    get disposed() { return disposed },
    agent: {
      id,
      session: { header: { id, cwd } },
      ctx: {
        effect: () => {},
        tools: {
          view() {
            return { restrictableNames: new Set(known) }
          },
          restrict(filter) {
            const allow = Array.isArray(filter?.allow) ? filter.allow : []
            const unknown = allow.filter((n) => !known.has(n))
            if (unknown.length) {
              throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
            }
            calls.push({ allow: [...allow] })
            return () => { disposed += 1 }
          },
          guard(fn) {
            guards.push(fn)
            return () => {}
          },
        },
      },
    },
  }
}

/** 轮询台账文件（监听器是 `void record(...)` 异步写入）。 */
async function waitForLedgerEntry(file, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = await readFile(file, 'utf8')
      const entries = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      const hit = entries.find(predicate)
      if (hit) return hit
    } catch {
      /* 文件还没出现 / 最后一行还没写完：继续等 */
    }
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('面 → allow → restrict → her_tools → load → 新 allow/guard/台账 闭环', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-exposure-'))
  const herDir = join(root, 'home')

  const { ctx, defs } = fakeCtx()
  const handle = provideFishCore(ctx, { root, herDir })
  const core = handle.core

  // index.js 补的接线，测试自己补：her_tools 只通过 fishCore 走这两条路。
  core.tools.reveal = (agent, names) => revealTools(agent, names)
  core.tools.state = (agent) => getAgentToolState(agent)

  // 策略入口只准备一份：收窄和 her_tools 共用，和生产完全一致。
  const policy = { resolveAllow, catalog, loadTargets, groupsFor, entriesFor, describeEntry }
  const caps = { hasGui: true, hasOcr: true, hasImageRoute: true }
  const results = []
  const offRestrict = registerToolRestrict(ctx, {
    herDir,
    surface: core.surface,
    policy,
    caps,
    extra: [],
    ownTools: OWN_TOOLS,
    enabled: true,
    log: () => {},
    onResult: (r) => results.push(r),
  })

  try {
    // web：cwd 就是她的屋子，命中 web matcher。
    const web = fakeAgent({ id: 'web-1', cwd: herDir, hostNames: [...OWN_TOOLS, 'read_image'] })

    // wx：id 由 dsh-wx 预先登记；cwd 故意不是屋子，证明面不是靠 cwd 猜出来的。
    core.surface.reserve('wx-1', 'wx')
    const wx = fakeAgent({
      id: 'wx-1',
      cwd: join(root, 'wx-cwd'),
      hostNames: [...OWN_TOOLS, ...WX_HOST_TOOLS],
    })

    // ---- 1. 面判定 + 启动期 allow/restrict ----
    ctx.emit('agent/created', { agent: web.agent })
    ctx.emit('agent/created', { agent: wx.agent })

    assert.equal(results.at(-1).ok, true, '两次收窄都该真的挂上')
    assert.equal(results.at(-1).why, 'applied')
    assert.equal(results.at(-1).applied, 2)

    const webAllow = web.calls.at(-1)?.allow ?? []
    assert.ok(webAllow.includes('growth_commit'))
    assert.ok(webAllow.includes('her_tools'))
    assert.ok(webAllow.includes('read_image'))
    assert.equal(webAllow.some((n) => n.startsWith('wx_')), false, 'web 面不该看见 wx 工具')
    assert.equal(webAllow.some((n) => n.startsWith('bili_')), false)
    assert.equal(webAllow.some((n) => n.startsWith('qq_')), false)

    const wxAllow = wx.calls.at(-1)?.allow ?? []
    assert.ok(wxAllow.includes('wx_peek'), 'wx 面常驻工具要在')
    assert.equal(wxAllow.includes('wx_see'), false, 'deferred 工具一开始不该出现')
    assert.equal(wxAllow.includes('bili_look'), false, '别面的工具不该串进来')
    for (const n of ['growth_commit', 'her_tools', 'read_image', 'her_inbox']) {
      assert.ok(wxAllow.includes(n), `wx 的 allow 里少了 ${n}`)
    }

    // ---- 2. 注册 her_tools（生产顺序：agent/created 之后才注册工具）----
    registerHerTools(ctx, { core, policy, caps })
    const herTools = defs.get('her_tools')
    assert.ok(herTools, 'her_tools 应该注册上')

    // ---- 3. 目录：只列当前面 deferred ----
    const search = await herTools.execute({ action: 'search' }, { agent: wx.agent })
    assert.equal(search.ok, true)
    const listed = search.data.items.map((it) => it.name)
    assert.deepEqual(listed, ['wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr'])
    for (const name of listed) assert.ok(WX_DEFERRED.includes(name), `${name} 不该出现在 wx 目录里`)
    assert.match(herTools.output.render({ action: 'search' }, search)[0].text, /wx_see/)

    const crossSurface = await herTools.execute({ action: 'search', query: 'bili' }, { agent: wx.agent })
    assert.deepEqual(crossSurface.data.items, [], 'wx 的目录里不该有 bili 工具')
    const hostTool = await herTools.execute({ action: 'search', query: 'read_image' }, { agent: wx.agent })
    assert.deepEqual(hostTool.data.items, [], '宿主常驻工具不该出现在 deferred 目录里')

    // ---- 4. load：重下 restrict、收回旧限制、新 allow 生效 ----
    const callsBefore = wx.calls.length
    const disposedBefore = wx.disposed
    const loaded = await herTools.execute({ action: 'load', group: 'wx.ui' }, { agent: wx.agent })
    assert.equal(loaded.ok, true)
    assert.deepEqual([...loaded.data.opened].sort(), ['wx_click', 'wx_key', 'wx_ocr', 'wx_see', 'wx_type'])
    assert.equal(wx.calls.length, callsBefore + 1, 'load 之后应该重新下一次 restrict')
    assert.equal(wx.disposed, disposedBefore + 1, '重下之前必须收回上一把限制')

    const afterAllow = wx.calls.at(-1).allow
    assert.ok(afterAllow.includes('wx_see'), '揭示之后新 allow 要含 wx_see')
    assert.ok(afterAllow.includes('wx_peek'), '揭示不能把原本常驻的工具挤掉')
    assert.equal(afterAllow.some((n) => n.startsWith('bili_')), false)
    const state = getAgentToolState(wx.agent)
    assert.equal(state.surface, 'wx')
    assert.ok(state.allow.includes('wx_see'))
    assert.ok(state.revealed.includes('wx_see'))

    // 已经打开的工具不再出现在目录里。
    const afterSearch = await herTools.execute({ action: 'search' }, { agent: wx.agent })
    const stillListed = afterSearch.data.items.map((it) => it.name)
    for (const name of loaded.data.opened) {
      assert.equal(stillListed.includes(name), false, `${name} 已经开着，不该再列出来`)
    }

    // ---- 5. guard：和 allow 读同一个 Set，各面互不放行 ----
    const wxGuard = wx.guards.at(-1)
    assert.equal(typeof wxGuard, 'function')
    assert.equal(wxGuard({ name: 'wx_see' }), undefined, '刚揭示的 wx_see 必须能调')
    const denied = wxGuard({ name: 'bili_look' })
    assert.equal(typeof denied, 'string')
    assert.match(denied, /做不到/)

    const webGuard = web.guards.at(-1)
    assert.equal(webGuard({ name: 'growth_commit' }), undefined)
    assert.equal(typeof webGuard({ name: 'wx_peek' }), 'string', 'web 面不该借到 wx 工具')

    // ---- 6. 台账：tools/result 写一行完整记录 ----
    const ledger = createToolLedger({
      root,
      guard: { looksLikeSecret },
      log: () => {},
      surfaceOf: (agent) => core.surface.current(agent),
    })
    ledger.register(ctx)

    const exec = { name: 'wx_peek', agent: wx.agent, arguments: {} }
    const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: '看过了' }] }
    ctx.emit('tools/result', exec, result)

    const day = new Date().toISOString().slice(0, 10)
    const ledgerFile = join(root, 'tool-ledger', `${day}.jsonl`)
    const entry = await waitForLedgerEntry(ledgerFile, (e) => e.tool === 'wx_peek')
    assert.ok(entry, '台账文件应在 2 秒内写出 wx_peek')
    assert.equal(entry.tool, 'wx_peek')
    assert.equal(entry.surface, 'wx')
    assert.equal(entry.modelText, '看过了')
    assert.equal(entry.sessionId, 'wx-1')
    assert.equal(entry.ok, true)
  } finally {
    try { offRestrict() } catch { /* ignore */ }
    try { handle.dispose() } catch { /* ignore */ }
    await rm(root, { recursive: true, force: true })
  }
})
