/**
 * index.js —— dsh-bili 插件入口（设计 §6 A2）
 *
 * B 站面从 dsh-fish 拆出来之后的全部行为都在这里装配：
 *   - 3 个工具（bili_look / bili_watch / bili_speak）与策略表贡献；
 *   - 刷站 + 出门（schedule.onTick）、醒来素材（schedule.onWake）；
 *   - 「去 B 站」出门会话；
 *   - bili 面的 system prompt 段（prompt.section，id 必须以 fish: 开头）；
 *   - `/dsh-bili/*` 只读路由；
 *   - `ctx.provide('bili')`：core 的 `/dsh-fish/*` B 路由与工作台 BFF 都转到这里。
 *
 * 依赖方向只有一条：本插件 → 宿主服务 `fishCore`。不 import ../../dsh-fish，
 * 不复制 schema / 常量 / 策略表。
 */
import { rootDir } from './support.js'
import { setCore, getCore } from './core.js'
import { registerLook } from './look.js'
import { registerWatch } from './watch.js'
import { registerSpeak } from './speak.js'
import { backgroundBrowse } from './browsejob.js'
import { ensureBiliSession, maybeOuting } from './outing.js'
import { lookBeforeWake } from './material.js'
import { renderBiliSection } from './prompts.js'
import { createBiliService } from './service.js'
import { registerBiliObserve } from './observe.js'

export const name = 'dsh-bili'
export const VERSION = '0.1.0'

// 与 core 一样：只用数组；sessionController 用的时候现取。
export const inject = ['tools', 'webServer', 'connection']

const CORE_WAIT_MS = 60_000
const CORE_POLL_MS = 500

function safeGet(ctx, key) {
  try { return ctx.get?.(key) ?? ctx[key] ?? null } catch { return null }
}

function waitForCore(ctx, { signal, timeoutMs = CORE_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (signal?.aborted) return resolve(null)
      const core = safeGet(ctx, 'fishCore')
      if (core) return resolve(core)
      if (Date.now() - started >= timeoutMs) return resolve(null)
      setTimeout(tick, CORE_POLL_MS).unref?.()
    }
    tick()
  })
}

export function apply(ctx, baseConfig = {}) {
  const root = baseConfig.root || process.env.DSH_FISH_HOME || rootDir()
  const disposers = []
  const bootAbort = new AbortController()
  const log = (...a) => console.log('[dsh-bili]', ...a)

  let core = null
  let service = null
  let whileBooted = false

  async function boot() {
    core = await waitForCore(ctx, { signal: bootAbort.signal })
    if (bootAbort.signal.aborted) return
    if (!core) {
      log('没等到 fishCore，B 站面这次没挂上（下一个 tick 不会自愈，需重启）')
      return
    }
    setCore(core)

    // ---- 服务：先 provide，core 的 B 路由代理随时可转 ----
    service = createBiliService({ root, version: VERSION, log })
    try {
      const off = ctx.provide?.('bili', service)
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      log(`bili 服务没挂上：${String(err?.message ?? err).slice(0, 160)}`)
    }

    // ---- 工具 ----
    // 与拆包前一致：B 站工具返回对象 + 自带 render，不套 core 的投影包装。
    if (ctx.tools?.register) {
      for (const reg of [
        () => registerLook(ctx, { root, memory: core.memory }),
        () => registerSpeak(ctx, { root, memory: core.memory }),
        () => registerWatch(ctx, { root, memory: core.memory }),
      ]) {
        try {
          const d = reg()
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          log(`工具注册失败：${String(err?.message ?? err).slice(0, 160)}`)
        }
      }
    }

    // ---- 策略表贡献（A1.4）----
    const wanted = [
      { name: 'bili_look', summary: '看 B 站列表', tier: 'always', kind: 'read' },
      { name: 'bili_watch', summary: '看一条视频的画面', tier: 'always', kind: 'read' },
      { name: 'bili_speak', summary: '在评论区说话', tier: 'always', kind: 'send', safety: 'send' },
    ]
    const hostNames = new Set(
      typeof ctx.tools?.get === 'function'
        ? wanted.map((t) => t.name).filter((n) => ctx.tools.get(n))
        : wanted.map((t) => t.name),
    )
    try {
      const c = core.toolPolicy?.contribute?.({ id: 'bili', tools: wanted, groups: [] }, { hostNames })
      if (c?.ok) disposers.push(c.off)
      else log(`B 站工具没贡献进策略表：${c?.why ?? 'unknown'}`)
    } catch (err) {
      log(`B 站工具贡献出错：${String(err?.message ?? err).slice(0, 160)}`)
    }

    // ---- 提示段：只挂 bili 面 ----
    // render 是同步的：配置与「最近刷到的」都走内存缓存，由 boot / tick / onChange 更新。
    let cfgCache = null
    let sawCache = []
    const refreshSection = async () => {
      try { cfgCache = await core.config.get() } catch { /* 保留上一份 */ }
      try {
        const events = await core.memory.readAll()
        sawCache = events
          .filter((e) => e?.type === 'saw')
          .slice(-3)
          .map((e) => ({ at: e.ts ?? '', text: String(e.text ?? '') }))
      } catch { /* 保留上一份 */ }
    }
    await refreshSection()
    try {
      const offCfg = core.config.onChange?.(() => { void refreshSection() })
      if (typeof offCfg === 'function') disposers.push(offCfg)
    } catch { /* ignore */ }
    try {
      const off = core.prompt.section({
        id: 'fish:bili',
        order: 8600,
        surface: 'bili',
        render: () => renderBiliSection({
          browse: cfgCache?.browse?.enabled !== false,
          speak: cfgCache?.comment?.enabled === true,
          recentSaw: sawCache,
        }),
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      log(`提示段没挂上：${String(err?.message ?? err).slice(0, 160)}`)
    }

    // ---- 出门会话 ----
    let ensureBili = null
    try {
      const out = await ensureBiliSession(ctx, { root, preset: cfgCache?.tools?.preset ?? '', log })
      if (out.ok) {
        log(`出门会话 ${out.sessionId}${out.reused ? '（复用）' : '（新建）'}`)
        ensureBili = () => ensureBiliSession(ctx, {
          root,
          preset: cfgCache?.tools?.preset ?? '',
          log,
          wakeOnCreate: false,
        })
      } else {
        log(`出门会话没建起来：${out.why}`)
      }
    } catch (err) {
      log(`出门会话出错：${String(err?.message ?? err).slice(0, 160)}`)
    }

    // ---- 调度钩子 ----
    const hooks = core.schedule
    if (hooks) {
      disposers.push(hooks.onTick({
        id: 'bili-browse',
        everyMs: 60_000,
        order: 20,
        async fn(h) {
          const hdeps = h.deps ?? {}
          const bg = await backgroundBrowse({
            root: h.root,
            config: h.config,
            events: h.events,
            dk: h.dk,
            log: hdeps.log ?? log,
            deps: hdeps,
          })
          let evs = h.events
          if (bg?.ok) evs = await core.memory.readAll()
          const out = await maybeOuting(ctx, {
            root: h.root,
            config: h.config,
            events: evs,
            dk: h.dk,
            now: new Date(),
            material: bg?.ok ? bg.text : '',
            picks: bg?.ok ? bg.picks : [],
            log: hdeps.log ?? log,
            ensureSession: hdeps.ensureBiliSession ?? ensureBili ?? undefined,
            client: hdeps.client,
            appendEvent: hdeps.appendEvent,
            core,
            memory: core.memory,
          })
          if (bg?.ok || out?.ok) void refreshSection()
          return { changed: Boolean(bg?.ok || out?.ok) }
        },
      }))
      disposers.push(hooks.onWake({
        id: 'bili-material',
        order: 20,
        async fn(h) {
          return lookBeforeWake(h.model, h.config, h.dk, {
            ...(h.deps ?? {}),
            root: h.root,
            events: h.events,
            memory: core.memory,
            log: (h.deps ?? {}).log ?? log,
          }, (h.deps ?? {}).log ?? log)
        },
      }))
    }

    // ---- 只读路由 ----
    try {
      const obs = registerBiliObserve(ctx, { service, log })
      if (obs?.dispose) disposers.push(() => obs.dispose())
    } catch (err) {
      log(`路由没挂上：${String(err?.message ?? err).slice(0, 160)}`)
    }

    log(`启动 · 根 ${root}`)
  }

  boot().catch((err) => {
    log(`启动失败 ${String(err?.message ?? err).slice(0, 200)}`)
  })

  const dispose = () => {
    if (whileBooted) return
    whileBooted = true
    try { bootAbort.abort() } catch { /* ignore */ }
    try { setCore(null) } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  }

  ctx.on?.('dispose', dispose)
  return { dispose, get core() { return getCore() }, get service() { return service } }
}
