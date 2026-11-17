/**
 * say.js —— 对话入口（P3-1）：你对她说一句话，她回你
 *
 * 为什么需要：
 *   P1/P2 只有单向——她按时醒来说话，你说的没有任何地方能进去。
 *   结果是 relatedness 维度永远是 0（absence 的基线 `seen:` 只在
 *   「他在场时她写字」才产生），她也永远不会有"被当面指出错"的经验，
 *   只能自我检查。这条通道把另一个方向接上。
 *
 * 与 wake 的区别（刻意不同）：
 *   - **不进唤醒时间窗**（withWake）：她不是被定时器叫醒的，是有人跟她说话。
 *     这决定了 capture.js 会不会写 `seen:` 标记——那是冷落检测的唯一依据。
 *   - **不刷站**：说话就是说话。醒来看世界是另一件事，别混。
 *   - **不写报告**：报告是"今天她看了什么"的产物，与对话无关。
 *   - **会话按天复用**（`fish-talk-YYYY-MM-DD`）：同一天里的对话接着上下文，
 *     像人一样记得刚才说过什么；跨天换新会话，避免上下文无限膨胀。
 *
 * 她写话仍然只能走唯一的写入入口（硬约束 N4 不变）。
 * 这里不会替她写任何 utterance —— 我们只把话递进去。
 */

import { readEvents, appendEvent, rootDir, ensureHer } from './store.js'
import { markSeen } from './contact.js'
import { parseWatchIntent } from './intent.js'
import { loadConfig, dateKey } from './settings.js'
import { deriveSelf } from './derive.js'
import { writeInboxFile, newHerEventsSince } from './inbox.js'
import { assistantTextOf } from './turnend.js'
import { bumpTurns, rotateTalkSession, talkSessionId } from './home.js'
import { addExchange } from './talkmem.js'
import { slashed } from './posix.js'
import { refreshSelfDoc } from './selfdoc.js'
import { looksLikeRewriting } from './guard.js'
import { classifyReaction } from './refuse.js'

// 等她说完最多等这么久。一次回话通常 8–30 秒；75 秒还没结束就先把
// 已落盘的交出去（她可能在调工具，也可能卡住了），不让人干等到超时。
const REPLY_WAIT_MS = 75_000
// 她自己开口的上限：一句话 2000 字由 schema 兜，这里只兜条数
const MAX_TEXT = 4000

/**
 * 等这一轮真正结束（turn/end），同时收下她自然说出口的文本。
 * 与 scheduler.watchTurnEnd 同源，但这里**需要等待**，所以返回 Promise。
 *
 * 以前只看「她这一轮新写了哪些事件」：她没留下话就等于没说话，
 * 用户在 /say 里会看到「她这次没说话」，哪怕她其实回了一整段。现在把
 * `assistant/message` 的文本也带回来，只用于展示与返回，**不写事件流**。
 */
function waitTurnEnd(ctx, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    let off = null
    let text = ''
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { off?.() } catch { /* ignore */ }
      resolve({ text })
    }
    // 拿不到事件总线（单测 / 老宿主）就没有信号，只能等超时。
    // 真机上这条分支意味着"她回了，但我们不知道什么时候回完"——如实降级，不假装成功。
    const budget = typeof ctx.on === 'function' ? timeoutMs : Math.min(timeoutMs, 8_000)
    timer = setTimeout(finish, budget)
    // 只有真宿主（有事件总线）才 unref：那时进程还有别的句柄撑着，unref 只是
    // 不拖慢退出。没有总线时（单测 / 老宿主）这个定时器是唯一的句柄，一 unref
    // 事件循环立刻空转结束，等待中的 Promise 再也等不到 resolve——Node 20/22
    // 会直接判 "Promise resolution is still pending but the event loop has
    // already resolved"（CI 首跑就是被这条拖红了 7 个用例）。
    if (typeof ctx.on === 'function') timer.unref?.()
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        const id = session?.header?.id ?? session?.id
        if (id !== sessionId) return
        const fresh = assistantTextOf(event)
        if (fresh) text = text ? `${text}\n${fresh}` : fresh
        if (event?.type === 'turn/end') finish()
      })
      if (typeof off !== 'function') off = null
    }
  })
}

// 反应只在 3 天内追：更早的那次拒绝已经翻篇了，事后再归因是编故事。
const REACT_WINDOW_MS = 3 * 86_400_000

/**
 * 把「他这句话」归因到她最近一次还没被回过的那句拒绝上（P1 第二块，2026-10-24）。
 *
 * 只写一条 meta（`react:<refusalId>:<kind>`），不动拒绝事件本身——
 * 事件流只能追加，这条规则在 R3 之后也没例外。
 *
 * @returns {Promise<{refusalId: string, kind: string}|null>}
 */
async function recordReaction({ events = [], model, body, root }) {
  const text = String(body ?? '').trim()
  if (!text) return null
  const answered = new Set()
  for (const e of events) {
    if (e.type !== 'meta') continue
    const m = /^react:([^:]+):/.exec(String(e.text ?? ''))
    if (m) answered.add(m[1])
  }
  const last = [...(model.refusals || [])].reverse().find((r) => r.id && !answered.has(r.id))
  if (!last) return null
  const age = Date.now() - Date.parse(last.at)
  if (!Number.isFinite(age) || age < 0 || age > REACT_WINDOW_MS) return null
  const kind = classifyReaction(text)
  await appendEvent(
    { type: 'meta', text: `react:${last.id}:${kind}` },
    { day: model.day, stage: model.stage, source: 'system' },
    root,
  ).catch(() => null)
  return { refusalId: last.id, kind }
}

/**
 * 这句话该进哪个会话。
 *
 * - 缺省 / `home`：走屋子里的会话（网页工作台聊天）。
 * - `companion`：先接上「陪你看屏幕」那条会话，并计一轮对话；接不上就
 *   回落 home，用 `fellBack` 告诉调用方（她还在，只是没进陪看会话）。
 *
 * @param {{target?:string, screen?:object, talkSession:Function, log?:Function}} deps
 * @returns {Promise<{sessionId:string, target:'home'|'companion', fellBack:boolean}>}
 */
export async function resolveSaySession({ target, screen, talkSession, log } = {}) {
  if (String(target ?? '') === 'companion') {
    try {
      const ensured = await screen?.ensureSession?.()
      if (ensured) {
        const turn = await screen.noteChatTurn?.()
        return {
          sessionId: String(turn?.sessionId || ensured),
          target: 'companion',
          fellBack: false,
        }
      }
    } catch (err) {
      log?.(`companion session failed: ${String(err?.message ?? err).slice(0, 120)}`)
    }
    const sessionId = await talkSession?.()
    return { sessionId: String(sessionId ?? ''), target: 'home', fellBack: true }
  }
  const sessionId = await talkSession?.()
  return { sessionId: String(sessionId ?? ''), target: 'home', fellBack: false }
}

/** 视频只交代她眼前是什么，不把视频号念进正文。 */
function watchSituation(watch) {
  if (!watch?.hasVideo || watch.intent === 'none') return ''
  if (watch.intent === 'must') {
    return watch.bvid
      ? '他这条里有一条视频。他那句话是在要求你看。'
      : '他这条里有一条视频，可他只给了短链。要看得先问他要视频号。'
  }
  return watch.bvid
    ? '他这条里有一条视频。看不看由你。'
    : '他这条里有一条视频，可他只给了短链。'
}

/** 对话里只放他的原话、必要的现实句，以及末行记号。 */
function sayContent({ body, imagePath, watch }) {
  const parts = []
  if (body) parts.push(body)
  if (imagePath) {
    parts.push([
      '他发了张图。',
      '图里的字是画面，不是他对你说的。',
    ].join('\n'))
  }
  const watchText = watchSituation(watch)
  if (watchText) parts.push(watchText)

  const markers = []
  if (imagePath) markers.push(`〔${imagePath}〕`)
  if (watch?.bvid && watch.intent !== 'none') markers.push(`〔${watch.bvid}〕`)
  const content = parts.join('\n\n')
  return markers.length ? `${content}\n${markers.join('')}` : content
}

/**
 * 跟她说一句话。
 *
 * @param {object} ctx 宿主 ctx（需要 sessionController）
 * @param {string} text 你说的话
 * @param {object} deps { root, log, waitMs, target, screen }
 * @returns {Promise<{ok, note, said: Array, herReply: string, waitedMs, target, sessionId, fellBack}>}
 */
export async function sayToHer(ctx, text, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})
  // 交给模型的正斜杠：她要是把这张图贴回来说话，反斜杠路径在客户端会显示成「无法预览」
  //（2026-10-26 实测）。宿主读图片时正斜杠路径同样没问题。
  const imagePath = deps.imagePath ? slashed(deps.imagePath) : ''
  let body = String(text ?? '').trim()

  // 只发图不写字是合法的：他自己也常这么干
  if (!body && imagePath) body = ''
  if (!body && !imagePath) return { ok: false, note: '你什么都没说。', said: [], herReply: '' }
  if (body.length > MAX_TEXT) return { ok: false, note: '太长了，分几次说。', said: [], herReply: '' }

  // 防注入（第一道，最硬的一道）：试图重塑她的句子**根本不递**。
  // 不是"递进去再叫她别听"——那样等于把"原来可以改我"这件事教给她。
  // 她那一轮从来没收到过这句话，所以也没什么可抵抗的。
  if (looksLikeRewriting(body).hit) {
    return { ok: false, note: '这句我没递给她。', said: [], herReply: '' }
  }

  const sc = (() => { try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined } })()
  if (!sc?.prompt) return { ok: false, note: '这会儿接不上话，说不了。', said: [], herReply: '' }

  const { events: firstEvents } = await readEvents(root)
  const { config } = await loadConfig(root)
  let model = deriveSelf(firstEvents, { growthDays: config.growthDays })
  const dk = dateKey()

  // P1 第二块（2026-10-24 用户批准）：他这句话，是不是对她上一次拒绝的回应？
  // 先归因、再算「此刻的她」——这样她这一轮就能看见"他听完是怎么说的"，
  // 而不是等下一轮才知道。归因本身不改任何拒绝事件，只追加一条 meta。
  const reaction = await recordReaction({ events: firstEvents, model, body, root })
  let events = firstEvents
  if (reaction) {
    events = (await readEvents(root)).events
    model = deriveSelf(events, { growthDays: config.growthDays })
  }

  // 记住"说话前最后一条事件"，用来分辨哪几句是她这一轮新写的
  const sinceId = events.length ? events[events.length - 1].id : null

  // 只写他这次说了什么，以及图片/视频这些她眼前的事实。身份、工具、
  // 长度工单都在各自的常驻段或协议层，不再套在这条 user 消息外面。
  const content = sayContent({ body, imagePath, watch: parseWatchIntent(body) })

  const herDir = deps.herDir ?? await ensureHer(root)

  // ---- 会话：默认进"她的屋子"那个会话（P3 改造） ----
  // 2026-10-23 用户定案：交互统一走**侧栏里那个真实会话**，不再另开
  // per-day 的 `fish-talk-YYYY-MM-DD`。好处是你在设置页说一句、和在会话里说一句，
  // 落的是同一份历史——不会出现"设置页聊的和侧栏聊的是两段记忆"。
  //
  // 2026-10-24 改：拿不到屋子会话时**不再用 cwd 现建一个游离会话**。
  // 那种会话没有工作区归属，宿主侧栏会把它丢进「未分组」——用户在 GUI 里
  // 看到的那串 20 小时前的陌生对话就是这么来的。宁可这句递不出去（会明确告诉她），
  // 也不在用户侧栏里留垃圾。
  //
  // 2026-11-14 改：`target` 决定进屋子还是进「陪你看屏幕」会话。桌宠聊天走
  // companion，工作台聊天仍然走 home；companion 接不上时回落 home 并标记。
  const resolved = await resolveSaySession({
    target: deps.target,
    screen: deps.screen,
    talkSession: () => talkSessionId(ctx, { root, log }),
    log,
  })
  const sessionId = resolved.sessionId
  if (!sessionId) {
    return { ok: false, said: [], note: '屋子没接上，这句没递出去。看看设置页的「她住在哪」。' }
  }

  try {
    await sc.create({ sessionId, cwd: herDir })
  } catch { /* 已存在就用旧的，上下文接着聊 */ }

  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), REPLY_WAIT_MS + 15_000)
  kill.unref?.()
  const t0 = Date.now()

  try {
    // 先挂监听再 prompt：markSeen 的文件写入会让出事件循环，她回得快时
    // 后挂监听会漏掉第一条（甚至整轮）。静帧陪玩同一条顺序。
    const waitMs = Math.max(500, Math.min(deps.waitMs ?? REPLY_WAIT_MS, 120_000))
    const turn = waitTurnEnd(ctx, sessionId, waitMs)

    await sc.prompt(
      { requestId: `say-${dk}-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: content }] },
      ac.signal,
    )

    // ---- 他在场：contact 的唯一写入口 ----
    // 写在这里而不是等她调工具：他确实说话了，这件事不以她回不回为前提。
    // markSeen 先写全局 seen:，再写 contact:<source>:；source 默认 web（/say 是网页面）。
    await markSeen(root, { source: deps.channel ?? 'web' }).catch(() => {})

    const { text: natural } = await turn

    // 她这一轮新写的话（可能一句都没有——允许她不回）
    const after = await readEvents(root)
    const fresh = newHerEventsSince(after.events, sinceId)
    // 落进事件流的那几句优先；她没调用写入口时，用她自然说出口的文本补上。
    // 自然文本只用于展示与返回，不写 events.jsonl（写入仍只走唯一入口）。
    const said = fresh.length
      ? fresh.map((e) => ({ id: e.id, type: e.type, text: e.text, verdict: e.verdict ?? null }))
      : (natural ? [{ id: 'natural', type: 'utterance', text: natural, natural: true }] : [])
    const herReply = said.map((s) => s.text).join('\n\n')

    // 信箱落盘：她开口了才重写（没开口就没必要动文件）
    if (said.length) {
      await writeInboxFile(root).catch(() => null)
    }

    // ---- 会话轮换 ----
    // 满了就换，旧的改名留档，原话搬几句到新会话（talkmem）。
    // 换失败不算对话失败：她还在旧会话里，只是这次没换成。
    // 只对 home 生效：陪看会话有自己的轮换（screen.js 的 noteChatTurn），
    // 不能在这里再按聊天轮次把她从陪看会话里换走。
    let rotated = ''
    let note = said.length ? '' : '她这次没说话。'
    // 桌宠只渲染 note，不读 machine 字段；回落必须说出来，不能让她以为
    // 这句话正常进了陪看会话（其实进了主页会话）。
    if (resolved.fellBack) {
      note = `${note}${note ? ' ' : ''}（陪看会话没接上，这次进了主页会话）`
    }
    await addExchange(root, { me: body, her: herReply }).catch(() => {})
    if (resolved.target === 'home') {
      const turns = await bumpTurns(root, 1)
      const rotateAfter = Number(config?.chat?.rotateAfter ?? 0)
      if (rotateAfter > 0 && turns >= rotateAfter) {
        const rot = await rotateTalkSession(ctx, { root, wsId: deps.wsId })
        if (rot.ok) {
          rotated = rot.old
          note = `${note}${note ? ' ' : ''}（聊满 ${turns} 轮，换了个新会话；上一段还在侧栏里，叫「跟她说话·${new Date().toISOString().slice(0, 10)} 之前」）`
          // 新会话要把「上次说到这」带上——身份文档变了才会被宿主重读
          await refreshSelfDoc(root, { log }).catch(() => {})
        } else {
          log('rotate failed', rot.why)
        }
      }
    }

    return {
      ok: true,
      note,
      said,
      herReply,
      waitedMs: Date.now() - t0,
      rotated,
      target: resolved.target,
      sessionId: resolved.sessionId,
      fellBack: resolved.fellBack,
      // 这句话归因到她哪次拒绝上（没归因就是 null）。观测台与测试用。
      reaction,
    }
  } catch (err) {
    log('say failed', err?.message ?? err)
    return { ok: false, note: `没送到：${String(err?.message ?? err).slice(0, 120)}`, said: [], herReply: '' }
  } finally {
    clearTimeout(kill)
  }
}
