/**
 * scheduler.js —— 生物钟
 *
 * 做什么：每分钟看一眼「现在该不该叫醒她」。该叫就起一个 headless 会话，只说这一次的处境
 * （身份由 identity.js 以 system prompt 段承载、每轮现读，不拼进唤醒消息）。
 *
 * 三条安全线（B §7）：
 *   1. 定时器只是**提议**。任何一次唤醒失败都不重试、不阻塞下一分钟。
 *   2. 一天之内同一条事件模板不重复触发（once 靠 fired 标记，非 once 靠 daily 配额）。
 *   3. 停用插件 = dispose 定时器，不再有任何后台活动（不靠"记得关"）。
 *
 * 时间判断全部走本地时区；跨零点的时间窗（20:00–02:00）按 inWindow 处理。
 */

import { deriveSelf } from './derive.js'
import { validateEvent } from './schema.js'
import { readEvents, appendEvent, rootDir, ensureHer } from './store.js'
import { loadConfig, dateKey, inWindow, pickWakeTime } from './settings.js'
import { plan } from './generator.js'
import { findTemplate } from './events.js'
import { offerPrompt, SLEEP_TODAY } from './persona.js'
import { offerDueDay, pendingOffer, grantableRules } from './unlock.js'
import { withWake } from './wakewin.js'
import { detectAbsence } from './absence.js'
import { flushReport } from './report.js'
import { talkSessionId } from './home.js'
import { WAKE_TRIGGER, WAKE_HINT } from './wakeconst.js'
import { refreshSelfDoc } from './selfdoc.js'
import { setWakeSection, clearWakeSection } from './identity.js'
import { watchTurnEnd } from './turnend.js'

const TICK_MS = 60_000
const INITIAL_DELAY_MS = 20_000
const WAKE_TIMEOUT_MS = 5 * 60_000
// 等她的回合结束时最多等这么久。一次唤醒的思考通常 10–40 秒，
// 90 秒足够；再久就说明卡住了，先把报告写出去，别让用户干等。
const REPORT_WAIT_MS = 90_000

// 最近一次 startScheduler 拿到的钩子表。wakeNow()（设置页「让她去刷 B 站」按钮、
// observe.js 调用）没有 deps.hooks，但必须继续跑 wake 钩子（素材、风险提示），
// 所以 wake() 在拿不到 deps.hooks 时退回这里。tick 不走这条兜底：
// 没有显式传入的钩子就不该有后台活动。
let activeHooks = null

export function startScheduler(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? ((...a) => console.log('[dsh-fish]', ...a))
  activeHooks = deps.hooks ?? null
  // 记一份本实例的归属：dispose 只清自己留下的兜底，不误伤后来启动的 scheduler。
  const ownHooks = activeHooks

  // 每次 tick 的记忆（内存态，重启即清空；配额以 events.jsonl 为准）
  let lastTick = 0
  let running = false
  let disposed = false
  let timer = null
  let wakeTimer = null


  async function tick() {
    if (disposed || running) return
    const now = Date.now()
    // 同一分钟内只算一次（setInterval 漂移保护）
    if (now - lastTick < 30_000) return
    lastTick = now

    try {
      // ---- 冷落检测：先测，再决定叫不叫她 ----
      // 放在 tick 最前面，因为 wake 的提示词要读 absenceDays；
      // 晚一步的话今天这次唤醒就用的是昨天的冷落结论。
      const absence = await detectAbsence(root)
      // 冷落条数变了 = 她对自己的看法变了，身份文件要跟着重写。
      // 不写的话那份 system prompt 段会一直停在上一次的值上（她"不知道自己被晾过"）。
      if (absence?.written) await refreshSelfDoc(root, { log })

      let { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()

      // ---- 调度钩子：后台刷站 + B 站出门（A1.5）----
      // 钩子跑在这一次串行 tick 里，不另起定时器。刷站放在唤醒日程之前：
      // 她不醒的时候也要有"今天看见过什么"。配额与唤醒共用，browsejob
      // 会为还没发生的唤醒留一次。
      //
      // 出门（2026-11-10）：刷到的素材、以及评论区新回复，投进「去 B 站」那条会话
      // ——不是 home。以前回复渲染在 home 唤醒里，于是她在屋子里替 B 站回话，
      // 而 bili_speak 属于 bili 面，她根本看不见那个工具。
      // 带素材的出门在这里；只带回复的出门也由它自己判配额/间隔。
      //
      // 没有 hooks（fishCore 没挂上 / 单测路径）：什么都不做，不抛错。
      running = true
      let tickRes = { changed: false }
      try {
        const h = deps.hooks ?? null
        if (h?.runTick) {
          tickRes = (await h.runTick({ now: new Date(), root, events, config, dk, deps })) ?? tickRes
        }
      } finally {
        running = false
      }
      if (tickRes?.changed) {
        // 钩子写了新事件（saw / browse）：后面的唤醒配额与身份文档都要读到。
        events = (await readEvents(root)).events
        await refreshSelfDoc(root, { log })
      }

      // 日程：每天在时间窗内抽一个点。抽到的点已存在（今天已经安排过）就不再改。
      const scheduled = await ensureSchedule(root, config, events, dk)
      if (!scheduled) return

      if (!inWindow(config, new Date())) return

      const counts = await todayCounts(events, dk)
      if (now < scheduled.at) return    // 还没到今天的落点

      const model = deriveSelf(events, { growthDays: config.growthDays })
      // 空档补偿只影响这一次挑选的冷却判断（见 gapSqueeze）
      const decision = plan(model, config, counts, events, { squeeze: gapSqueeze(gapSinceLastWake(events)) })

      if (decision.action === 'quiet') {
        // quiet 只表示「这一分钟没有候选」，不是今天到此为止——候选可能过一会儿
        // 才满足条件（14:33 那次唤醒就是等出来的），下一分钟还会重新算。
        // 所以事件流里一天只留第一条，不要每分钟追加；wake / wakefail 照常记录。
        const marker = `quiet:${dk} `
        const noted = events.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(marker))
        if (!noted) {
          await appendEvent({ type: 'meta', text: `${marker}还不想醒` }, { day: model.day, stage: model.stage, source: 'timer' }, root)
        }
        return
      }
      if (decision.action === 'skip') {
        log('skip', decision.why)
        return
      }

      running = true
      try {
        await wake(ctx, root, model, config, decision, dk, log, { ...deps, events })
      } finally {
        running = false
      }
    } catch (err) {
      // 永不抛出：一次失败不能污染后续 tick
      log('tick failed', err?.message ?? err)
    }
  }

  timer = setInterval(() => { void tick() }, TICK_MS)
  wakeTimer = setTimeout(() => { void tick() }, INITIAL_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof wakeTimer.unref === 'function') wakeTimer.unref()

  return {
    tick,
    dispose() {
      disposed = true
      if (activeHooks === ownHooks) activeHooks = null
      if (timer) clearInterval(timer)
      if (wakeTimer) clearTimeout(wakeTimer)
      timer = null
      wakeTimer = null
    },
  }
}

/**
 * 今天的唤醒落点。写进 meta 事件（`sched:YYYY-MM-DD HH:MM`），
 * 这样重启后同一个落点会被沿用，不会因为重启就重新抽一次、把时间漂掉。
 */
async function ensureSchedule(root, config, events, dk) {
  const marker = `sched:${dk} `
  for (const e of events) {
    if (e.type === 'meta' && String(e.text ?? '').startsWith(marker)) {
      const at = Date.parse(String(e.text).slice(marker.length).trim())
      if (Number.isFinite(at)) return { at, reused: true }
    }
  }
  const seed = hashSeed(dk)
  const minutes = pickWakeTime(config, seed)
  const [y, mo, d] = dk.split('-').map(Number)
  const at = new Date(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime()
  await appendEvent(
    { type: 'meta', text: `${marker}${new Date(at).toISOString()}` },
    { day: 0, stage: 1, source: 'timer' },
    root,
  )
  return { at, reused: false }
}

function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

async function wake(ctx, root, model, config, decision, dk, log, deps = {}) {
  const sc = (() => { try { return ctx.get?.('sessionController') } catch { return undefined } })()
  if (!sc) { log('no sessionController'); return }

  // ---- 唤醒语只留「这一次」的情境 ----
  // 2026-10-23 用户指出：打开她的会话，看到的是一大块隐藏提示词。
  // 查了会话日志（agent/inbox/spliced → user/message），确认那块东西是**这条唤醒消息**：
  // 原来自带了整份身份段 + 工具说明 + 行为限制，一千多字。
  //
  // 2026-10-26 更正：这里的旧注释写「那些内容宿主本来就每轮从 home/AGENTS.md 注入」，
  // 那个通道 0.4.x 起已经不用了——身份改走 systemPrompt.section（lib/identity.js 挂载、
  // lib/selfdoc.js 渲染），system 角色、不进对话历史、界面看不见；selfdoc 还会 unlink
  // 旧 AGENTS.md。所以现在身份与处境是两条互不重复的路：
  //   system prompt（每轮现读同一个文件）＝ 她是谁；这条唤醒消息 ＝ 她此刻遇到什么。
  // 唤醒消息里任何"你是谁/你能做什么"的复述都是重复，交给身份文档。
  const parts = [decision.prompt]

  // ---- P2：醒之前先让她"看见点东西" ----
  // 顺序是刻意的：先看，再想。如果先出事件提示再塞素材，
  // 她就会先按模板说话、再拿素材硬套——那是模板，不是她。
  // 反过来（先看见世界的动静，再问她怎么想）才像一个人醒来的样子。
  // A2：素材由 dsh-bili 注册的 wake 钩子提供（原名 lookBeforeWake）。链接清单与
  // 封面图已经在钩子侧渲染进 text，core 不再 import 任何 B 站模块。
  // wakeNow() 走的是 activeHooks 兜底（同一张 fishCore.schedule 表）。
  const emptyLook = { text: '', intro: '', picks: [], riskNote: '' }
  let look = emptyLook
  try {
    const h = deps.hooks ?? activeHooks
    if (h?.runWake) {
      look = (await h.runWake({ now: new Date(), root, model, config, dk, events: deps.events ?? [], deps })) ?? emptyLook
    }
  } catch (err) {
    log('wake hooks failed', err?.message ?? err)
  }
  if (look.text) parts.push('', look.intro, '', look.text)
  if (look.riskNote) parts.push('', look.riskNote)

  // 工具说明与上网说明不在这里重复：那两段在身份文档里（selfdoc.js 的
  // 「我手上有什么」「上网」两节，随配置现渲染，\`speak\` 关着时整节不写），
  // 而这整份文档每轮都以 system prompt 的形式在场。这里再写一遍 = 同一件事说两遍。

  // ---- P4：能不能在 B 站说话 ----
  // 2026-11-10：回复**不再**在 home 唤醒里渲染。B 站回复属于 bili 面，
  // 而 home 是 web 面——她在这里看不见 bili_speak，却会被指着鼻子问
  // 「有人在你下面说话了」，只能干看着。现在回复只投进出门会话（lib/outing.js）。
  // 能说话这件事的说明仍在身份文档的「在网上说话」一节（开关打开时 selfdoc 才写）。

  // 日记：**不再在叫醒消息里推**（2026-10-26，用户 m00928：「叫醒仅仅只是叫醒」）。
  // 病历：原来这里整段塞 diaryPrompt（「今天写日记…写今天发生了什么…」），加上后面的
  // 「想一想」段，一条叫醒消息里连着一个祈使句手册。她在 `fish-wake-2026-10-26-manual`
  // 的 reasoning 原话是「需要做的是：说一句…然后写日记」——她把它当成任务清单在执行。
  // 现在写法常驻在身份文档（persona.DIARY_BRIEF → selfdoc），她一直知道该记；
  // 叫醒只给处境，不再派活。

  // ---- 每 N 天的「想一想」----
  // 为什么必须是她自己做、而不是一个定时摘要器：
  //   摘要器写出来的自传是"别人替她解释她的一生"。哪怕她写得粗糙、写得少、
  //   写偏了，那也是她自己写的。
  // 判据用 growthDay 取模（不是自然日），这样改了 growthDays 也不会突然连发。
  // 同一天只用一次，靠 `meta sleep:<dk>` 兜住。
  // 做法写在身份文档（SLEEP_BRIEF），这里只给一句时机标记。
  const every = Number(config?.memory?.sleepEveryDays ?? 0)
  let askedSleep = false
  if (every > 0 && model.day > 1 && model.day % every === 0) {
    const events0 = (await readEvents(root).catch(() => ({ events: [] }))).events
    const doneToday = events0.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`sleep:${dk}`))
    if (!doneToday) { parts.push('', SLEEP_TODAY); askedSleep = true }
  }

  // ---- 规则解禁申请（R3，2026-10-24）----
  // 时机：由「最后一条证据是哪天」+ 稳定偏移（1–3 天）算出来，不用随机数（每次 tick 重算会抖）。
  // 内容：不是随机抽的，是某个她已经用行为走到门边的规则。
  // 一次醒来最多提一条；上一张没处理就不出新的。
  let askedOffer = false
  if (config?.rules?.offers !== false) {
    const ev2 = (await readEvents(root).catch(() => ({ events: [] }))).events
    if (!pendingOffer(ev2, Date.now())) {
      for (const r of grantableRules()) {
        const due = offerDueDay(r.id, model, ev2)
        if (due === null || model.day < due) continue
        try {
          const ev = validateEvent(
            {
              type: 'grant_offer',
              text: `我想试试「${r.title}」这件事。不是现在就要，是想问问你。`,
              grant: { rule: r.id },
              day: model.day,
              stage: model.stage,
            },
            { day: model.day, stage: model.stage, source: 'system' },
          )
          await appendEvent(ev, root)
          parts.push('', offerPrompt(r))
          askedOffer = true
        } catch (err) {
          log('grant offer failed', err?.message || err)
        }
        break
      }
    }
  }
  void askedOffer

  // 「这一次的处境」不再放进对话（2026-10-25 晚，用户 m04080）。
  // 宿主没有「模型看得见、用户看不见」的通道（asar 已核实：PromptContentPart
  // 没有 hidden 字段、SurfaceOp 只有 append/replace），所以正文改走 system prompt
  // 的动态段 `fish:wake`，对话里只留一句极短的触发语把这一轮点起来。
  // 这样对话框里不会再出现「你该醒了」「这次推给你的是……」这些系统的话。
  // 注意：`setWakeSection` 要等会话确定之后再设，否则提前 return 会留下脏段落。
  const content = parts.filter(Boolean).join('\n').trim()
  // 空正文就别唤醒：没有处境可讲，起了也是空转。
  if (!content) {
    log('wake skipped: empty body')
    return
  }
  // 给 wake 段加一句性质说明：对话里那句括号短句是叫醒信号，不是用户的话。
  const wakeText = `${WAKE_HINT}\n\n${content}`
  // ---- 会话（P3 改造）----
  // 2026-10-23 用户定案：她的**所有**开口都落进侧栏那个真实会话，
  // 不再每天另起 `fish-wake-YYYY-MM-DD`。
  // 理由：用户要的是"打开就能看见她"，不是"去一个隐藏会话里找她说过什么"。
  // 副作用（刻意接受）：定时唤醒的内容会出现在同一条对话流里，读起来像
  //   「她自己在那个房间里说话了」——这正是要的效果。
  // 手动唤醒以前传 deps.sessionId（带时间戳的独立会话），2026-10-26 改掉：
  // 用 cwd 建的会话没有工作区归属，宿主侧栏把它丢进「未分组」，用户在
  // 「大肥鱼的家」里看不见（m00507）。现在 wakeNow 也先取屋子会话。
  let sessionId = deps.sessionId
  if (!sessionId) {
    // 2026-10-24 改：不再退回 `fish-wake-${dk}`（那种用 cwd 建的会话没有工作区
    // 归属，宿主侧栏会把它丢进「未分组」）。没有屋子就不开口——但**留一条记录**，
    // 免得「她今天没说话」被读成人格或心情问题。
    sessionId = await talkSessionId(ctx, { root, log })
    if (!sessionId) {
      await appendEvent(
        { type: 'meta', text: `wakefail:${dk} 屋子没接上，这次没开口` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      ).catch(() => {})
      log('no home session; skip wake')
      return
    }
  }

  // cwd = 她自己的房间（root/her），**不是 root**。
  // 以前写的是 root：她站在状态库正中央，`cat events.jsonl` 就能把自己
  // 的全部历史、配置、黑名单读一遍——B 文档 §N3 声称做不到，实现却在放水。
  // 现在她在一个空目录里，状态库是父目录，要碰得主动 `cd ..`。
  const herDir = deps.herDir ?? await ensureHer(root)
  try {
    await sc.create({ sessionId, cwd: herDir })
  } catch { /* 已存在，继续用 */ }

  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), WAKE_TIMEOUT_MS)

  // ---- 报告的两种写法 ----
  // 先写一次：让用户在等回复的这段时间里就能看到"她今天看了什么"。
  // 再等回合真正结束，重写一次补上"她说了什么"。
  // 为什么需要第二次：prompt() 只等消息**入队**，不等模型想完——
  // 真机实测报告比她的原话早落盘 8 秒，于是永远显示"今天她什么都没说"。
  const writeReport = async () => {
    // 这里**不再弹通知**。原实现 spawn 隐藏 PowerShell（-WindowStyle Hidden
    // -EncodedCommand），被火绒当木马行为拦下；更糟的是静默拦截时没有任何
    // 错误返回，`lastShown` 照样被写掉 → 当天再也不会弹，而日志干干净净。
    // 现在由观测台页面轮询 `GET /notify` 自行决定弹不弹（lib/notify.js）。

    // 报告里的「今天看了什么」属于 B 站面，A2 起由服务提供；服务不在时留空，
    // 报告其余部分照写（她说了什么不依赖这个）。
    let items = []
    try {
      const bili = (() => { try { return ctx.get?.('bili') } catch { return null } })()
      if (bili?.browse) items = (await bili.browse())?.items ?? []
    } catch { items = [] }
    return flushReport(root, {
      dateKey: dk,
      items,
      notes: [],
      diaryVisible: config.diary?.visible === true,
    }).catch(() => null)
  }

  // 处境按会话隔离：全局槽会在 turn/end、失败或 90 秒兜底时把出门会话的处境一起清掉。
  const watcher = watchTurnEnd(ctx, sessionId, () => { void writeReport(); clearWakeSection(sessionId) })

  // 处境走 system prompt 段；对话里只留这一句（她看到的是「有人来了」，不是剧本）。
  setWakeSection(wakeText, sessionId)
  try {
    await withWake(async () => {
      await sc.prompt(
        { requestId: `wake-${dk}-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: WAKE_TRIGGER }] },
        ac.signal,
      )
    })
    await appendEvent(
      { type: 'meta', text: `wake:${dk} ${decision.template?.id ?? '?'}` },
      { day: model.day, stage: model.stage, source: 'timer' },
      root,
    )
    // 每条模板都要落 fired 标记（2026-10-24 起）：once 靠它判断用没用过，
    // 可重复的模板靠它的时间戳算冷却（repeat.everyDays）——光有 id 算不出"隔了多久"。
    if (decision.template?.id) {
      await appendEvent(
        { type: 'meta', text: `fired:${decision.template.id}` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      )
    }
    // 想过了就记一笔，免得同一天再问一次（她可能什么都没写，也算问过了）。
    if (askedSleep) {
      await appendEvent(
        { type: 'meta', text: `sleep:${dk}` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      )
    }
    log('woke', sessionId, decision.template?.id)

    // 第一版报告：这时她大概还没说完，所以"她说了什么"多半是空的。
    // 先写一版是为了用户点完按钮立刻就能看到"今天看了什么"。
    await writeReport()

    // 然后**不阻塞**，把重写挂在她的回合结束上。
    // prompt() 只等消息入队、不等模型想完（真机实测：报告比她的原话早落盘 8 秒，
    // 于是报告永远显示"今天她什么都没说"）。所以第二次重写必须由 turn/end 触发。
    // 不 await 是刻意的：唤醒本身不该被拖住。
    // ⚠️ 监听器的注销必须在 finally **之外**做——放进 finally 会当场把它摘掉，
    // 于是 turn/end 永远等不到，报告又是一版空的。
    // 同理，`clearWakeSection()` 也不能放 finally：prompt() 只等入队就返回，
    // 她还没开始想，这里清掉等于她根本看不到这次处境。
    // 兜底：如果 turn/end 一直不来，最迟 REPORT_WAIT_MS 后也把段落清掉，
    // 免得残留到下一轮（他之后主动聊天时会看到她上一次的处境）。
    setTimeout(() => {
      try { watcher.off?.() } catch { /* ignore */ }
      clearWakeSection(sessionId)
    }, REPORT_WAIT_MS).unref?.()
  } catch (err) {
    // 这一次没起来，处境要立刻清掉——只清这一条会话。
    clearWakeSection(sessionId)
    await appendEvent(
      { type: 'meta', text: `wakefail:${dk} ${String(err?.message ?? err).slice(0, 120)}` },
      { day: model.day, stage: model.stage, source: 'timer' },
      root,
    ).catch(() => {})
    log('wake failed', err?.message ?? err)
    try { watcher.off?.() } catch { /* ignore */ }
  } finally {
    clearTimeout(kill)
  }
}

/**
 * 手动唤醒（观测台上的按钮 / 测试用）。不受时间窗限制。
 *
 * 注意 dk 必须是**纯日期**，不能像早期那样传 `${dk}-manual`：
 * 那个后缀会跟着进 browse 记账、日记文件名、报告文件名和会话 id，
 * 于是报告按 `2026-10-23` 去查，记账却写在 `2026-10-23-manual` 里 →
 * 报告"看了什么"永远显示"今天没看"。区分手动只用在 sessionId 上。
 *
 * 2026-10-26（用户 m00507）：**手动唤醒也走屋子会话**。
 * 原来的实现每次手动唤醒都伪造一个 `fish-wake-<dk>-manual-<ts>` 的 id，
 * 宿主不认识这个 id → `sc.create({ sessionId, cwd: herDir })` 按 cwd 建一条
 * 新会话，而她的房间（`~/.dsh-fish/home/her`）是工作区 `~/.dsh-fish/home`
 * 的**子目录**，匹配不上工作区路径 → 侧栏把它丢进「未分组」。
 * 用户看到的就是「叫醒之后，对话到了未分组」。
 * 现在先拿屋子里那条真会话（它由 workspaceId 建，天然属于家）；
 * 只有拿不到屋子时（测试 / 屋子坏了）才退回旧的伪造 id，让调试还能用。
 */
export async function wakeNow(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const { events } = await readEvents(root)
  const { config } = await loadConfig(root)
  const model = deriveSelf(events, { growthDays: config.growthDays })
  const dk = dateKey()
  const counts = { dateKey: dk, sent: 0, questions: 0, proactive: 0 }
  // focus='browse'：设置页那个「让她去刷 B 站」按钮（**仅本机测试版**，2026-10-26）。
  // 不走 plan()——plan 判的是「今天该不该醒」，而这个按钮是人工要求她醒一次去看站；
  // 语气也别写成"任务"，她看到"去看一眼"会自己决定看不看。
  const forcedBrowse = deps.focus === 'browse'
  if (forcedBrowse) deps = { ...deps, forceBrowse: true }
  const decision = forcedBrowse
    ? { action: 'wake', prompt: '（现在，去看一眼 B 站首页在推什么。）', template: { id: 'manual-browse' } }
    : plan(model, config, counts, events, { squeeze: gapSqueeze(gapSinceLastWake(events)) })
  if (decision.action !== 'wake') return { ok: false, why: decision.why ?? 'no candidate' }
  const log = deps.log ?? (() => {})
  let sessionId = deps.sessionId
  if (!sessionId) {
    sessionId = await talkSessionId(ctx, { root, log }).catch(() => '')
    if (!sessionId) {
      sessionId = `fish-wake-${dk}-manual-${Date.now()}`
      log(`屋子没接上，这次手动唤醒用独立会话（会落进「未分组」）：${sessionId}`)
    }
  }
  // 已经读过的事件流一并交给 wake 钩子：A2 的钩子按 §7.3 约定用 ctx.events，
  // 不该在手动唤醒时拿到空数组。lookBeforeWake 自己回读，中间没有写入，等价。
  await wake(ctx, root, model, config, decision, dk, log, { ...deps, sessionId, events })
  return { ok: true, template: decision.template?.id, sessionId }}

/**
 * 今日配额：从事件流里数，不用内存。
 *
 * 2026-10-25 修：原来两处都数不到东西——
 *   · `sent` 只数 `event:` 前缀，但全库没人写 `event:`（唤醒写的是 `wake:`）→ 恒 0；
 *   · `questions` 声明后从不累加 → `daily.questions`（设置页「会向你进行几次提问」）永远拦不住。
 * 于是「每天最多几个事件」「最多几个问题」两个旋钮都是摆设，真正生效的只有 wakesPerDay。
 *
 * 现在统一从 `wake:<日期> <模板id>` 数：一条 wake 就是一个事件；
 * 模板的 asks 决定它算不算一次提问（静态表查询，不依赖模型）。
 */
export function todayCounts(events = [], dk) {
  let sent = 0
  let questions = 0
  let proactive = 0
  for (const e of events) {
    if (e.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('wake:')) continue
    const [head, id] = t.slice(5).trim().split(/\s+/)
    if (head !== dk) continue
    proactive++
    sent++
    const tpl = id ? findTemplate(id) : null
    if (tpl?.asks) questions++
  }
  return { dateKey: dk, sent, questions, proactive }
}

/**
 * 空档天数（2026-10-25）。
 *
 * 她不是一直在跑：DSH 关掉几天、或者某天没到点在窗里，这段空白会白白吃掉成长期。
 * 这里只回答一件事——「距上一次唤醒过了几天」，由调用方决定怎么补偿。
 * 没有任何唤醒记录（刚装好/刚重置）返回 0，不做补偿。
 */
export function gapSinceLastWake(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (e.type !== 'meta' || !String(e.text ?? '').startsWith('wake:')) continue
    const at = Date.parse(e.ts || '') || 0
    if (at > last) last = at
  }
  if (!last) return 0
  return Math.max(0, (Number(now ?? Date.now()) - last) / 86_400_000)
}

/**
 * 空档补偿系数。
 *
 * 断了两天以上，这一次唤醒的冷却按一半算——否则短成长期（7 天）里
 * 一次三天没开，剩下的四天就轮不完四张卡。
 * 系数只作用于**这一次**唤醒，不写盘、不累积。
 */
export function gapSqueeze(gapDays) {
  const g = Number(gapDays) || 0
  if (g >= 4) return 0.35
  if (g >= 2) return 0.5
  return 1
}
