/**
 * index.js —— 插件入口
 *
 * 坑（whale-src/lib/index.js:120 的注释，已复现过）：
 *   inject 必须写成**一个数组**。写成两个键（对象字面量）会后者覆盖前者，
 *   sessionController 静默缺失 → 定时器每分钟空转、不报错也不干活。
 *
 * 生命周期：
 *   apply → 读配置 → 播种(首次) → 起定时器 → 注册工具 → 注册观测台路由
 *   dispose → 停定时器、注销路由。停用插件 = 零后台活动。
 */

import { rootDir, readEvents, appendEvent, readJson, paths, writeAtomic, ensureHer } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { registerCapture } from './capture.js'
import { registerLook } from './look.js'
import { registerSpeak } from './speak.js'
import { registerRecall } from './recall.js'
import { registerWatch } from './watch.js'
import { registerLetter } from './letter.js'
import { registerRemind } from './remind.js'
import { registerInbox } from './taskinbox.js'
import { registerObserve } from './observe.js'
import { startScheduler, lookBeforeWake } from './scheduler.js'
import { bootstrapHomeWithRetry, homeStatus, wakeIfBlank } from './home.js'
import { ensureBiliSession, maybeOuting } from './outing.js'
import { backgroundBrowse } from './browsejob.js'
import { writeSelfDoc, refreshSelfDoc } from './selfdoc.js'
import { registerToolRestrict, revealTools, getAgentToolState } from './restrict.js'
import { provideFishCore } from './core-service.js'
import { registerQqAdapter, qqExposure } from './qq-adapter.js'
import {
  resolveAllow, catalog, loadTargets, groupsFor, entriesFor, describeEntry,
  contribute,
  ownTools as policyOwnTools,
  setAgentProbe,
  setHostNamesProvider,
} from './tool-policy.js'
import { wrapRenderOnly, wrapTool } from './tool-result.js'
import { registerHerTools } from './tools.js'
import { createToolLedger } from './tool-ledger.js'
// `clearWakeSection` 在 dispose 里用：它挂在 system prompt 段上，是个模块级变量，
// 停用时不清的话下次启用会带着上一次的残留（2026-10-25）。
import { clearWakeSection, registerIdentity, identityText } from './identity.js'
import { looksLikeRewriting, looksLikeSecret, sanitizeForeign, screenOutgoing } from './guard.js'

import { logBoot, makeLogger } from './log.js'

export const name = 'dsh-fish'

/** 版本号：只用于日志导出（排查时第一件事是确认跑的是哪一版）。 */
export const VERSION = '0.7.0'

// ⚠️ 一个数组写全，不要拆成对象
// sessionController 只有有人打开工作区界面时才出现；写进 inject 会让整条插件在开机后一直挂着不挂载，
// 表现就是 bili_* / 人格工具全没了、events.jsonl 不再更新。改成用的时候现取（各处都有 !sc 的兜底）。
export const inject = ['tools', 'webServer', 'connection']

const SEED_KEY = 'seed:'

export function apply(ctx, baseConfig = {}) {
  const root = baseConfig.root || process.env.DSH_FISH_HOME || rootDir()
  const disposers = []
  // dispose 时用它叫停「等宿主服务就绪」的重试循环，别让插件停用后还在后台醒着。
  const bootAbort = new AbortController()

  // 把过滤能力作为服务暴露给 dsh-wx 这类输入通道：它们不能直接 import 本插件的内部文件，
  // 但检索结果、外来文本在递给她之前必须过 guard.js。服务不可用时，调用方应整行拦下。
  try {
    if (typeof ctx.provide === 'function') {
      const offGuard = ctx.provide('fishGuard', {
        sanitizeForeign,
        looksLikeSecret,
        looksLikeRewriting,
        screenOutgoing,
      })
      if (typeof offGuard === 'function') disposers.push(offGuard)
    } else {
      console.log('[dsh-fish] ctx.provide 不可用，dsh-wx 的检索结果将无法显示原文')
    }
  } catch (err) {
    console.log('[dsh-fish] fishGuard 服务没挂上：' + String(err?.message ?? err).slice(0, 160))
  }

  let scheduler = null
  // 自己的日志（落 ~/.dsh-fish/logs/，带滚动），同时继续转发宿主 logger。
  // 为什么要自己写一份：宿主的 logger 不回读，出事之后现场就没了。
  const logger = makeLogger(ctx, root)
  // 工具面收窄的结果（给自检读）。applied 是"真的挂上过几次"，
  // 不是"注册了没有"——注册了但没匹配到 agent 等于没生效，这两件事必须分开。
  let restrictState = { ok: false, applied: 0, why: 'not attempted', allow: [] }

  async function boot() {
    logBoot(root, `${VERSION} · ${process.version} · ${process.platform}`)
    const { config } = await loadConfig(root)
    // 她自己的房间必须先存在：她的会话 cwd 指向这里（不是 root），
    // 这样她不会一睁眼就站在自己的 events.jsonl 旁边。
    const herDir = await ensureHer(root)

    // ---- 插件内核：面判定 / guard / config / 工具返回契约 ----
    // 必须在 registerToolRestrict 之前挂上：限制监听器（Task 6 起）要靠 surface
    // 判断这个 agent 属于哪个面。这里先只提供判定，本任务不改 restrict 的签名。
    let fishCore = null
    // 台账实例在 fishCore 之后才建；用 getter 注入，fishCore.toolLedger 在
    // 调用时取到当时的值（没挂上就是 NO_LEDGER），不必为了顺序把台账往前挪。
    let ledger = null
    try {
      const handle = provideFishCore(ctx, {
        root,
        herDir,
        log: (...a) => logger.warn(...a),
        // 身份文档刷新由这里注入：core-service / memory-service 都不直接 import selfdoc。
        refreshSelfDoc: (r = root) => refreshSelfDoc(r, { log: (...a) => logger.warn(...a) }),
        // 身份文本同理：fishCore.self.identity 读的就是她当前那份文档。
        identityText: (r = root) => identityText(r),
        toolLedger: () => ledger,
      })
      fishCore = handle.core
      if (typeof handle.dispose === 'function') disposers.push(handle.dispose)
    } catch (err) {
      logger.warn('[dsh-fish] fishCore 没挂上', err?.message ?? err)
    }

    // ---- 工具策略贡献的宿主上下文（A1.4）----
    // 必须早于任何 agent 创建：贡献（下面 B 站 3 个）要发生在首个 bili agent 之前。
    // 宿主全局认得的工具名由这里提供给 tool-policy，用来和贡献方自报的名字求交集，
    // 防止自报一个其实没注册成功的名字。
    setHostNamesProvider(() => {
      try {
        const s = ctx.tools?.view?.()?.restrictableNames
        return s ? new Set(s) : null
      } catch { return null }
    })
    // 记录每个面第一次出现 agent 的时刻：晚贡献探测靠它。
    const createdSurfaces = new Set()
    try {
      ctx.on?.('agent/created', ({ agent } = {}) => {
        try {
          const s = fishCore?.surface?.current?.(agent)
          if (s) createdSurfaces.add(s)
        } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
    setAgentProbe((s) => createdSurfaces.has(s))

    // ---- 工具返回契约：核心对象上挂包装器 ----
    // `core` 必须是 fishCore 同一个对象引用（dsh-wx / dsh-bili 通过宿主服务拿到它）；
    // 复制一份的话，后续任务往里加的东西两边就看不见了。
    if (fishCore) {
      fishCore.tools.wrap = (def, opts = {}) => wrapTool(def, { ...opts, core: fishCore })
      fishCore.tools.wrapRender = (def, opts = {}) => wrapRenderOnly(def, { ...opts, core: fishCore })
    }

    // ---- 工具台账：只读观察 tools/result，与事件流完全分离 ----
    // 必须放在 fishCore 之后：surfaceOf 靠它判定这次调用来自哪个面。
    // 放在工具注册之前：插件启动期间已经发生的调用也要被看见。
    // 监听器内部自己吞错，台账写失败绝不能把成功的工具调用变成 isError。
    // 实例在 try 外留一个引用（boot 开头已声明）：/selfcheck 要读 ledger.status()，
    // 外部闭包拿不到 try 里的 const；fishCore.toolLedger 也通过 getter 读它。
    try {
      ledger = createToolLedger({
        root,
        guard: { looksLikeSecret },
        log: (...a) => logger.warn(...a),
        surfaceOf: (agent) => fishCore?.surface?.current?.(agent),
      })
      const offLedger = ledger.register(ctx)
      // register 自己吞错并 markFailed：此时台账不可用，置回 null，让自检报
      // 「台账没挂上」，而不是 written:0 的假绿。
      if (ledger.status().ok === false) {
        ledger = null
      } else if (typeof offLedger === 'function') {
        disposers.push(offLedger)
      }
    } catch (err) {
      ledger = null
      logger.warn('[dsh-fish] 工具台账没挂上', err?.message ?? err)
    }

    const { events } = await readEvents(root)

    // 首次启动播种：她最初的那一点点性格，是**第一个事实**，不是可调参数。
    // 之所以写成事件而不是配置项：配置项会被"打开设置页改一下"，
    // 事件只能追加——想改就得由她自己 revise，这是 N4 的地基。
    const hasSeed = events.some((e) => e.type === 'seed')
    if (!hasSeed) {
      const seedText = String(
        // 起点只写**处境**，不写她是什么样的人。
        // 原来这里是一整段性格描述（"能感觉到的东西很少""不太会把它说清楚"
        // "对被人安排有一种说不清的抵触"）。这段话每轮都在她眼前，
        // 等于给她发了一张终身有效的人格说明书——用户 2026-10-23 指出这一点。
        // 现在她只知道：我刚开始存在，没人告诉我为什么。
        // 剩下的，靠她经历的事和她自己说过的话长出来。
        baseConfig.seed ??
          '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。',
      )
      try {
        await appendEvent(
          { type: 'seed', text: seedText },
          { day: 1, stage: 1, source: 'system' },
          root,
        )
      } catch (err) {
        logger.warn('[dsh-fish] 播种失败', err?.message ?? err)
      }
    }

    const model = deriveSelf(await readEvents(root).then((r) => r.events), { growthDays: config.growthDays })

    // ---- 她的屋子：工作区 + 专属会话（P3 核心）----
    // 这一步**先于**一切：她得先有个能被你看见的地方，才有"说话"这件事。
    // 失败不致命（宿主的 workspaceRegistry 可能没有），降级成"只有观测台能跟她说话"，
    // 并把原因记下来，而不是静默变成什么都没有。
    // ---- 工具面收窄：只让她看见自己的 9+1 个工具 ----
    // 必须**先于** bootstrapHome：她那条会话就是在 bootstrapHome 里被创建的，
    // agent/created 在会话开始跑第一步之前同步串行发出——晚一步就漏掉这一次。
    // 面能力：微信在，就有 GUI/OCR 工具；图片路由恒开（dsh-wx 的图片都落成路径）。
    // 不能传空对象——那会让所有 wx.ui 工具永远打不开。
    // 惰性取值：resolveAllow 会在 agent/created / revealTools 时现读，而不是 boot 期快照。
    // 后者会把「插件晚一步挂上」误判成「永远没有微信」。
    const hasWx = () => { try { return !!ctx.get?.('wx') } catch { return false } }
    const caps = {
      get hasGui() { return hasWx() },
      get hasOcr() { return hasWx() },
      hasImageRoute: true,
    }
    // 策略表的目录/解析入口只准备一份：收窄（restrict.js）和 `her_tools` 共用，
    // 避免两边各拼一个对象后行为悄悄分叉。
    const policy = { resolveAllow, catalog, loadTargets, groupsFor, entriesFor, describeEntry }
    try {
      const off = registerToolRestrict(ctx, {
        herDir,
        surface: fishCore?.surface,
        policy,
        caps,
        extra: config?.tools?.allow ?? [],
        // `her_tools` 必须并进 ownTools：它是本插件注册的，但老宿主/名单晚到的
        // 情况下 agent/created 可能还看不到它；不并进去会被宿主名单滤掉。
        // 传函数而不是数组：贡献表可能在注册之后才更新，名单要在每个
        // agent/created 现读（B 站 3 个工具就是贡献进来的）。
        ownTools: () => [...policyOwnTools(), 'her_tools'],
        enabled: config?.tools?.restrict !== false,
        log: (...a) => logger.info(...a),
        onResult: (r) => { restrictState = r },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 工具面收窄没挂上', err?.message ?? err)
    }
    // 按需揭示 / 状态查询：Task 7 的 her_tools 只通过 fishCore 走这条路，
    // 不直接 import restrict.js。core 是同一个对象引用，dsh-wx 也看得到。
    if (fishCore) {
      fishCore.tools.reveal = (agent, names) => revealTools(agent, names)
      fishCore.tools.state = (agent) => getAgentToolState(agent)
    }

    // ---- QQ（OneBot）vendor 工具返回投影 ----
    // 宿主 `tools/post-execute` 是 waterfall：只替换 content，不碰 value/schema。
    // 监听器自己 try/catch，任何异常都 next() —— 抛错会把成功调用变成 isError。
    // 面判定靠 fishCore.surface，所以必须排在 registerToolRestrict 之后。
    try {
      const offQq = registerQqAdapter(ctx, {
        core: fishCore,
        log: (...a) => logger.warn(...a),
      })
      if (typeof offQq === 'function') disposers.push(offQq)
    } catch (err) {
      logger.warn('[dsh-fish] QQ 投影适配没挂上', err?.message ?? err)
    }

    // ---- 她的身份：走 system prompt，不进对话历史（2026-10-25 改）----
    // 原来的通道是 `home/AGENTS.md`（宿主工作区指令），但那批注入是普通 user 消息、
    // 带 `<system-reminder>` 外壳，用户在面板上能看见她的整套设定。现在改成
    // `agent.ctx.systemPrompt.section(...)`：system 角色、不进历史、界面上看不到。
    // 顺序：先把文本落盘（identityText 从文件读），再注册监听，最后才建她的会话。
    try {
      const pre = await writeSelfDoc(root, { log: (...a) => logger.warn(...a) })
      if (!pre.ok) logger.warn(`[dsh-fish] 身份文本写不出来：${pre.why}`)
    } catch (err) {
      logger.warn('[dsh-fish] 身份文本预写失败', err?.message ?? err)
    }
    try {
      const off = registerIdentity(ctx, { root, herDir, log: (...a) => logger.info(...a) })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 身份段没挂上', err?.message ?? err)
    }

    // ---- 工具：一个写（growth_commit）、一个看（bili_look）----
    // 两者都必须成功注册；缺了任何一个她都会变残（只会说不会看，或只会记不会看）。
    // **必须先于 bootstrapHome**：屋子会话是在那里创建的，`agent/created` 同步发出；
    // 工具若晚一步，restrict 会因「names unknown global tools …」自愈，把 her_tools
    // 这类唯一能按需开工具的入口一起丢掉，这条会话终生降级。
    if (bootAbort.signal.aborted) return
    if (ctx.tools?.register) {
      for (const reg of [
        () => registerCapture(ctx, { root, core: fishCore ?? undefined }),
        () => registerLook(ctx, { root, client: baseConfig.client }),
        () => registerSpeak(ctx, { root, client: baseConfig.client }),
        () => registerRecall(ctx, { root, core: fishCore ?? undefined }),
        () => registerWatch(ctx, { root }),
        // R4：留话（不审批）。和 growth_commit 一样是纯追加，但收件人明确。
        () => registerLetter(ctx, { root, core: fishCore ?? undefined }),
        // 定时提醒：包装宿主 schedule，只开「过多少分钟」；许可由 dsh-wx 发。
        () => registerRemind(ctx, { root, core: fishCore ?? undefined, log: (...a) => logger.warn(...a) }),
        // 待回任务：只读 dsh-wx 的任务摘要，不碰它的文件。
        () => registerInbox(ctx, { core: fishCore ?? undefined, log: (...a) => logger.warn(...a) }),
        // 工具目录：先只留常用工具，其余靠这个工具自己查、自己打开。
        () => registerHerTools(ctx, { core: fishCore, policy, caps }),
      ]) {
        try {
          const d = reg()
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          logger.warn('[dsh-fish] 工具注册失败', err?.message ?? err)
        }
      }
    }

    // ---- B 站 3 个工具贡献进策略表（A1.4）----
    // 必须早于第一个 bili agent 创建（下面的 bootstrapHome / ensureBiliSession 都会
    // 建会话）。贡献方只为**自己刚注册成功**的名字担保：宿主有 ctx.tools.get 时
    // 逐个确认，没有就按全部注册成功处理；tool-policy 若还能拿到全局名单会再求一次
    // 交集。失败只记日志，不打断启动。
    const biliWanted = [
      { name: 'bili_look', summary: '看 B 站列表', tier: 'always', kind: 'read' },
      { name: 'bili_watch', summary: '看一条视频的画面', tier: 'always', kind: 'read' },
      { name: 'bili_speak', summary: '在评论区说话', tier: 'always', kind: 'send', safety: 'send' },
    ]
    const biliHostNames = new Set(
      typeof ctx.tools?.get === 'function'
        ? biliWanted.map((t) => t.name).filter((n) => ctx.tools.get(n))
        : biliWanted.map((t) => t.name),
    )
    const biliContribution = contribute(
      { id: 'bili', tools: biliWanted, groups: [] },
      { hostNames: biliHostNames },
    )
    if (biliContribution.ok) {
      disposers.push(biliContribution.off)
    } else {
      logger.warn(
        `[dsh-fish] B 站工具没贡献进策略表：${biliContribution.why}` +
        (biliContribution.detail ? `（${biliContribution.detail}）` : ''),
      )
    }

    let home = { ok: false, why: 'not attempted', wsId: '', sessionId: '' }
    try {
      home = await bootstrapHomeWithRetry(ctx, {
        root,
        preset: config?.tools?.preset ?? '',
        log: (...a) => logger.info(...a),
        warn: (...a) => logger.warn(...a),
        signal: bootAbort.signal,
      })
    } catch (err) {
      home = { ok: false, why: String(err?.message ?? err).slice(0, 160), wsId: '', sessionId: '' }
    }
    // 重试期间插件被停用：不继续挂观测路由、开定时器，静默收尾（工具此前已注册，由 disposers 统一注销）。
    if (bootAbort.signal.aborted) return
    if (!home.ok) logger.warn(`[dsh-fish] 屋子没建起来：${home.why}`)
    else {
      // 屋子会话建好后补登记一次：create 期间 web matcher 还能靠 cwd 命中，
      // 这里是第二道保险（会话 id 已知，不再依赖 cwd）。
      try {
        fishCore?.surface?.reserve?.(home.sessionId, 'web')
      } catch (err) {
        logger.warn('[dsh-fish] 屋子会话没登记成 web 面', err?.message ?? err)
      }

      // 屋子是空的（上一次开了但从没说过话）时，侧栏不会显示它——见 sessionVisible。
      // 启动时就叫一声，免得用户重启后以为"人不见了"。
      try {
        const woke = await wakeIfBlank(ctx, { sessionId: home.sessionId, root, log: (...a) => logger.info(...a), freshOnly: !home.reused })
        if (woke.woke) logger.info('[dsh-fish] 屋子是空的，已经叫了她一声')
      } catch (err) {
        logger.warn(`[dsh-fish] 启动唤醒失败：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }

    // ---- 出门会话（2026-11-10）----
    // 「大肥鱼出门 / 去 B 站」，工作区在 home/bili。B 站工具只在 bili 面可见，
    // 没有这条会话，她就只被推送着看、没法自己打开视频或在评论区回话。
    // 建失败不挡住启动：调度器每轮会再试（maybeOuting 内部会调 ensureBiliSession）。
    let ensureBili = null
    if (home.ok) {
      try {
        const out = await ensureBiliSession(ctx, {
          root,
          preset: config?.tools?.preset ?? '',
          log: (...a) => logger.info(...a),
        })
        if (out.ok) {
          logger.info(`[dsh-fish] 出门会话 ${out.sessionId}${out.reused ? '（复用）' : '（新建）'}`)
          ensureBili = () => ensureBiliSession(ctx, {
            root,
            preset: config?.tools?.preset ?? '',
            log: (...a) => logger.warn(...a),
            wakeOnCreate: false,
          })
        } else {
          logger.warn(`[dsh-fish] 出门会话没建起来：${out.why}`)
        }
      } catch (err) {
        logger.warn('[dsh-fish] 出门会话出错', err?.message ?? err)
      }
    }

    // ---- 身份文本再落一次盘：屋子建好之后 activeCarry 等才齐，内容可能变 ----
    // 这条改动之后它**不再被宿主注入**（那是旧的 AGENTS.md 通道），只是落盘副本；
    // 真正进她上下文的是上面注册的 system prompt 段（每轮组装时现读文件）。
    const doc = await writeSelfDoc(root, { log: (...a) => logger.warn(...a) })
    if (!doc.ok) logger.warn(`[dsh-fish] 身份文件写不出来：${doc.why}`)

    // 观测台路由。`exposure` 是可见性状态（面登记、策略表、台账、QQ 投影 legacy），
    // 只读传给自检；任何一项没挂上都由 selfcheck 给出中性结论，不影响工具路径。
    const exposure = {
      surface: fishCore?.surface ?? null,
      policy,
      ledger,
      qq: qqExposure(),
    }
    const obs = registerObserve(ctx, { root, version: VERSION, exposure })
    if (obs?.dispose) disposers.push(() => obs.dispose())

    // ---- 调度钩子（A1.5）----
    // 旧 scheduler 直调 backgroundBrowse / maybeOuting / lookBeforeWake；
    // 现在这些行为由本插件注册到 core.schedule 上，scheduler 只负责在既有的
    // 串行 tick 里跑一遍、在真要唤醒时取一次素材。A1 阶段行为不变；
    // A2 的 dsh-bili 可以往同一张表上挂自己的刷站/素材。
    const hooks = fishCore?.schedule
    if (hooks) {
      disposers.push(hooks.onTick({
        id: 'bili-browse',
        everyMs: 60_000,
        order: 20,
        // 参数与旧 scheduler.tick 里那段逐字对应（见 A1.5 brief）。
        async fn(h) {
          const hdeps = h.deps ?? {}
          const bg = await backgroundBrowse({
            root: h.root,
            config: h.config,
            events: h.events,
            dk: h.dk,
            log: hdeps.log,
            deps: hdeps,
          })
          let evs = h.events
          if (bg?.ok) evs = (await readEvents(h.root)).events
          const out = await maybeOuting(ctx, {
            root: h.root,
            config: h.config,
            events: evs,
            dk: h.dk,
            now: new Date(),
            material: bg?.ok ? bg.text : '',
            picks: bg?.ok ? bg.picks : [],
            log: hdeps.log,
            ensureSession: hdeps.ensureBiliSession,
            client: hdeps.client,
            appendEvent: hdeps.appendEvent,
          })
          return { changed: Boolean(bg?.ok || out?.ok) }
        },
      }))
      disposers.push(hooks.onWake({
        id: 'bili-material',
        order: 20,
        async fn(h) {
          return lookBeforeWake(h.root, h.model, h.config, h.dk, h.deps ?? {}, h.deps?.log)
        },
      }))
    }

    // 生物钟：把屋子信息一起传下去。她每晚醒来说话要落进**同一个**会话，
    // 不是每晚新开一个藏起来的会话（用户定案：打开侧栏就该看见她）。
    // hooks 必须显式传给 scheduler：tick 只认这一次启动拿到的钩子表。
    scheduler = startScheduler(ctx, {
      root,
      herDir,
      wsId: home.wsId,
      sessionId: home.sessionId,
      ensureBiliSession: ensureBili ?? undefined,
      hooks: hooks ?? null,
      log: (...a) => logger.info(...a),
    })

    logger.info(
      `[dsh-fish] 启动 · 第 ${model.day} 天 · 阶段 ${model.stage}(${model.stageName}) · 判断 ${model.beliefCount} 条 · 根 ${root}`,
    )
  }

  // 宿主可能不 await apply，所以自己兜住异常：启动失败不能带走整个插件树
  boot().catch((err) => {
    logger.error('[dsh-fish] 启动失败', err?.stack ?? err)
    console.error('[dsh-fish] 启动失败', err)
  })

  ctx.on?.('dispose', () => {
    try { bootAbort.abort() } catch { /* ignore */ }
    try { scheduler?.dispose?.() } catch { /* ignore */ }
    try { clearWakeSection() } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  })

  return {
    dispose() {
      try { bootAbort.abort() } catch { /* ignore */ }
      try { scheduler?.dispose?.() } catch { /* ignore */ }
      try { clearWakeSection() } catch { /* ignore */ }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
