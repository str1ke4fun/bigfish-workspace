/**
 * integration-tool-exposure.test.mjs —— Task 12：假宿主端到端闭环
 *
 * 不开真宿主、不连微信：用最小的假 ctx / 假 agent 把整条链路走一遍——
 *
 *   面判定 → allow → restrict → her_tools 目录 → load → 下一步 allow + guard + 台账
 *
 * 这条测试要抓的是「各模块单独都对、接起来却不对」的端到端断点，接线照生产
 * index.js 抄一遍。生产里 agent/created 早于本插件注册自有工具，启动期把自有
 * 工具并进宿主名单的时序由 test/restrict.test.mjs 的单测钉住；这里不复制那个
 * 时序，只验证面 → allow → restrict → 揭示 → guard → 台账的闭环。
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

/** wx 面宿主真实注册过的工具名。 */
const WX_HOST_TOOLS = [
  'read_image',
  'wx_peek', 'wx_send', 'wx_context', 'wx_task_done', 'wx_task_snooze',
  'wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr',
  'wx_sticker_scan', 'wx_sticker_list', 'wx_sticker_find', 'wx_sticker_tag',
  'wx_sticker_send', 'wx_sticker_collect', 'wx_sticker_search',
  'wx_history',
]

/**
 * 两个面共用同一份「真实宿主」名字集合。
 *
 * 关键：它必须包含别的面和宿主标准工具（bash / subagent / bili / qq）。policy
 * 的 hostOk 过滤排在面过滤之后；如果 web 假宿主只登记自己的工具，跨面泄漏会先被
 * hostOk 滤掉，`webAllow` 不含 `wx_*` 之类的断言就永远是绿的，抓不到真正的错误。
 *
 * 假宿主在 agent/created 时就能看到自有工具：这是端到端接线，不复制生产启动期
 * 「宿主名单里还没登记自有工具」的时序（那段由 test/restrict.test.mjs 覆盖）。
 */
const HOST_TOOLS = [...new Set([
  ...OWN_TOOLS,
  'read_image',
  'bash', 'subagent',
  ...WX_HOST_TOOLS,
  'bili_look', 'bili_watch', 'bili_speak',
  'qq_send_image', 'qq_send_voice', 'qq_send_video', 'qq_send_file',
  'qq_send_forward', 'qq_napcat_api', 'qq_group_history',
])]

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
  const viewCalls = []
  let disposed = 0
  return {
    calls,
    guards,
    viewCalls,
    get disposed() { return disposed },
    agent: {
      id,
      session: { header: { id, cwd } },
      ctx: {
        effect: () => {},
        tools: {
          // 宿主语义：view(agent) 是 agent 视角（祖先层也算），view() 是 global
          // 视角。生产 readHostNames 必须走前者；后者这里故意留空，回归时会露馅。
          view(scope) {
            viewCalls.push(scope)
            return { restrictableNames: scope ? new Set(known) : new Set() }
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

/** 有上限的轮询：用来等异步落盘和 written 计数。 */
async function pollUntil(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 轮询台账文件（监听器是 `void record(...)` 异步写入）。 */
async function waitForLedgerEntry(file, predicate, timeoutMs = 2000) {
  let hit = null
  await pollUntil(async () => {
    try {
      const text = await readFile(file, 'utf8')
      const entries = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      hit = entries.find(predicate) ?? null
      return hit !== null
    } catch {
      /* 文件还没出现 / 最后一行还没写完：继续等 */
      return false
    }
  }, timeoutMs)
  return hit
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
  let offLedger = null

  try {
    // 两个 agent 看到的是同一份真实宿主名单：跨面工具确实被宿主注册了，
    // 能不能看见只能由面策略决定——这样下面的跨面断言才真的在测面过滤。
    const web = fakeAgent({ id: 'web-1', cwd: herDir, hostNames: HOST_TOOLS })

    // wx：id 由 dsh-wx 预先登记；cwd 故意不是屋子，证明面不是靠 cwd 猜出来的。
    core.surface.reserve('wx-1', 'wx')
    const wx = fakeAgent({ id: 'wx-1', cwd: join(root, 'wx-cwd'), hostNames: HOST_TOOLS })

    // ---- 1. 面判定 + 启动期 allow/restrict ----
    ctx.emit('agent/created', { agent: web.agent })
    ctx.emit('agent/created', { agent: wx.agent })

    assert.equal(results.at(-1).ok, true, '两次收窄都该真的挂上')
    assert.equal(results.at(-1).why, 'applied')
    assert.equal(results.at(-1).applied, 2)

    // 生产取宿主名单必须用 agent 视角：view(agent)。若退回 global view()，
    // 假宿主给的是一张空名单，这条会红。
    assert.ok(web.viewCalls.some((scope) => scope === web.agent), 'readHostNames 必须走 view(agent)')
    assert.ok(wx.viewCalls.some((scope) => scope === wx.agent), 'readHostNames 必须走 view(agent)')

    const webAllow = web.calls.at(-1)?.allow ?? []
    assert.ok(webAllow.includes('growth_commit'))
    assert.ok(webAllow.includes('her_tools'))
    assert.ok(webAllow.includes('read_image'))
    assert.equal(webAllow.some((n) => n.startsWith('wx_')), false, 'web 面不该看见 wx 工具')
    assert.equal(webAllow.some((n) => n.startsWith('bili_')), false)
    assert.equal(webAllow.some((n) => n.startsWith('qq_')), false)
    for (const name of ['bash', 'subagent']) {
      assert.equal(webAllow.includes(name), false, `${name} 不在策略表里，不该进 allow`)
    }

    const wxAllow = wx.calls.at(-1)?.allow ?? []
    assert.ok(wxAllow.includes('wx_peek'), 'wx 面常驻工具要在')
    assert.equal(wxAllow.includes('wx_see'), false, 'deferred 工具一开始不该出现')
    assert.equal(wxAllow.includes('bili_look'), false, '别面的工具不该串进来（宿主确实登记了它）')
    for (const n of ['growth_commit', 'her_tools', 'read_image', 'her_inbox']) {
      assert.ok(wxAllow.includes(n), `wx 的 allow 里少了 ${n}`)
    }

    // ---- 2. 注册 her_tools（生产顺序已改为先注册工具再建会话，见 boot.test.mjs；
    //         这里仍手动注册，测的是收窄之后按需揭示的闭环）----
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
    assert.equal(typeof webGuard({ name: 'subagent' }), 'string', '策略表之外的名字永远不放行')

    // ---- 6. 台账：tools/result 写一行完整记录 ----
    // 时钟钉在 emit 之前：文件名取记录时刻的 UTC 日期，跨午夜时不会指错文件。
    const fixed = Date.now()
    const ledger = createToolLedger({
      root,
      guard: { looksLikeSecret },
      log: () => {},
      now: () => fixed,
      surfaceOf: (agent) => core.surface.current(agent),
    })
    offLedger = ledger.register(ctx)

    const exec = { name: 'wx_peek', agent: wx.agent, arguments: {} }
    const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: '看过了' }] }
    ctx.emit('tools/result', exec, result)

    const day = new Date(fixed).toISOString().slice(0, 10)
    const ledgerFile = join(root, 'tool-ledger', `${day}.jsonl`)
    const entry = await waitForLedgerEntry(ledgerFile, (e) => e.tool === 'wx_peek')
    assert.ok(entry, '台账文件应在 2 秒内写出 wx_peek')
    assert.equal(entry.tool, 'wx_peek')
    assert.equal(entry.surface, 'wx')
    assert.equal(entry.modelText, '看过了')
    assert.equal(entry.sessionId, 'wx-1')
    assert.equal(entry.ok, true)

    // written++ 发生在 append 句柄关闭之后：等它落定再清理，Windows 上才不会 EBUSY。
    assert.equal(
      await pollUntil(() => ledger.status().written >= 1),
      true,
      '台账应在 2 秒内把 written 记上',
    )
  } finally {
    try { offLedger?.() } catch { /* ignore */ }
    try { offRestrict() } catch { /* ignore */ }
    try { handle.dispose() } catch { /* ignore */ }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
