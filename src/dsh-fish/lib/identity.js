/**
 * identity.js —— 把「此刻的她」送进 **system 角色**，而不是送进对话
 *
 * 为什么换掉 AGENTS.md（2026-10-25）：
 *   原来身份写在 `<她的屋子>/home/AGENTS.md`，靠宿主的「工作区指令」注入。
 *   那条链路（内核 0.2.1-rc.3 已核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、会留在对话历史里——用户一眼就看见
 *   「规则约束/人格设定」，等于把她每一轮都在读的东西摊开给人看。
 *
 *   宿主还有另一条路：`agent.ctx.systemPrompt.section({ name, order, text })`。
 *   它渲染成 **system 角色消息**（surface 节点 0），**不进对话历史**，
 *   面板与对话框里都看不到；`text` 允许传函数，每次组装提示词时才求值，
 *   所以内容变了下一轮就生效，不需要重建会话。
 *
 * 为什么不直接每次读文件：
 *   `text()` 是同步求值，不能 await。这里用 mtime 缓存：
 *   文件没变就直接返回上次的字符串，变了才 `readFileSync`。
 *   文件很小（几 KB），一次 stat 的成本可以忽略。
 *
 * 边界：
 *   - 拿不到 `systemPrompt`（宿主版本不同）→ 返回 `{ ok:false }`，记一条日志，不崩。
 *     这种情况下身份会**完全不可见**（因为不再写 AGENTS.md）——宁可让她少一段，
 *     也不要把设定重新塞回对话里。缺了会由 `/selfcheck` 的 `identity` 项报出来。
 *   - 只挂在她那个 agent 上（判据 herDir == 会话 cwd），不影响用户自己的会话。
 */

import { readFileSync, statSync } from 'node:fs'
import { ownerDocPath, selfDocPath } from './selfdoc.js'
import { ownerSectionText } from './people-view.js'
import { REMIND_PROMPT } from './remind.js'
import { isHerAgent } from './restrict.js'

/** 段名与顺序：放在宿主自己的段之后、`complete` 段之前（order 越大越靠后）。 */
export const IDENTITY_SECTION = 'fish:identity'
// 2026-10-27 晚：8500 → 50。
// 原因：宿主那 4,400 字的「你是 coding agent」指导在 0~5000 之间，她的身份段排在
// 所有工具说明之后，于是模型先读到"你是工具人"，最后才读到"你是本鱼"。
// 用户的原话是"还是汇报腔"。挪到 0 之后、plan 策略之前——先定人，再谈工具。
// 这是 agent 作用域，只影响她那条会话；profile 的 personaPrefix 是全局的，不能用来干这个。
export const IDENTITY_ORDER = 50

/**
 * 「这一次的处境」段（2026-10-25 晚）。
 *
 * 为什么另开一段（用户 m04080 报的问题）：
 *   定时唤醒、自动刷 B 站推视频给她时，唤醒消息原来整段走 `sc.prompt()` 进对话，
 *   于是他在对话框里看见「你该醒了」「这次推给你的是……」这些系统说的话。
 *   宿主没有「模型看得见、用户看不见」的注入通道（核对过 asar：
 *   `PromptContentPart` 没有 hidden 字段，`SurfaceOp` 只有 append/replace，
 *   append 就一定进人类可见的对话流）。所以唯一的办法是**不把它放进对话**——
 *   正文改从 system prompt 走，对话里只留一句极短的触发语。
 *
 * 生命周期：`setWakeSection()` 在 `sc.prompt()` **之前**写好，
 * 她这一轮组装提示词时求值拿到；`turn/end` 之后立刻 `clearWakeSection()`，
 * 免得他之后主动聊天时她还带着上一次的「此刻处境」。
 */
export const WAKE_SECTION = 'fish:wake'
export const WAKE_ORDER = 8700

/**
 * 工具说明段：定时提醒怎么用、许可怎么带。
 * 和身份段分开：身份是"她是谁"，这一段是"手边多了一个动作"。
 */
export const REMIND_SECTION = 'fish:remind'
export const REMIND_ORDER = 8800

/**
 * 微信任务摘要段：还没回完的请求。
 * 和提醒说明分开：提醒是「到点发一条」，任务是「谁在等、回到哪了」。
 * 没有任务时返回空串（等于不存在），不会每轮都塞一段空标题。
 */
export const INBOX_SECTION = 'fish:inbox'
export const INBOX_ORDER = 8850

/**
 * owner 身份事实段（person-memory Phase 1 Task 4）。
 *
 * 和身份段分开：身份是“她是谁”，这一段是“哪些名字是他”。
 * 只对 web / wx / screen 返回内容；bili / qq 上不渲染（合并裁决 D5、D28）。
 * `ownerText` 走 mtime 缓存，`text()` 是同步求值，不能 await。
 */
export const OWNER_SECTION = 'fish:owner'
export const OWNER_ORDER = 75

/** 这一次唤醒的处境正文；空串表示没有（正常聊天时就是空）。 */
let wakeText = ''
/**
 * 按会话分开的处境（2026-11-10，B 站出门会话）。
 *
 * 以前只有一份全局 `wakeText`：home 在唤醒时，出门会话如果刚好也在组装提示词，
 * 会把 home 的处境看进去；反过来也一样。现在唤醒可以带 sessionId，段按会话取；
 * 不带 sessionId 的旧调用仍写全局那份，行为不变。
 */
const wakeBySession = new Map()

function sessionIdOf(agent) {
  return String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
}

/**
 * 设这一次的处境正文。传空串等于清掉。
 * @param {string} text
 * @param {string} [sessionId] 只给这一条会话看；不传就写给全局（旧行为）
 */
export function setWakeSection(text, sessionId) {
  const body = String(text ?? '')
  const sid = String(sessionId ?? '')
  if (sid) {
    if (body) wakeBySession.set(sid, body)
    else wakeBySession.delete(sid)
    return
  }
  wakeText = body
}

/**
 * 清掉。回合结束、唤醒失败、插件卸载时都要调。
 * @param {string} [sessionId] 只清这条会话；不传就清全局和所有会话段
 */
export function clearWakeSection(sessionId) {
  const sid = String(sessionId ?? '')
  if (sid) {
    wakeBySession.delete(sid)
    return
  }
  wakeText = ''
  wakeBySession.clear()
}

/** 测试用：看现在挂着什么（带 sessionId 就看那条会话的）。 */
export function getWakeSection(sessionId) {
  const sid = String(sessionId ?? '')
  if (sid) return wakeBySession.get(sid) ?? ''
  return wakeText
}

/** 某条 agent 这一轮该看到的处境：有按会话的就用会话的，否则退回全局。 */
export function wakeSectionFor(agent) {
  const sid = sessionIdOf(agent)
  if (sid && wakeBySession.has(sid)) return wakeBySession.get(sid)
  return wakeText
}

const cache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读她的身份文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
export function identityText(root) {
  try {
    const file = selfDocPath(root)
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      cache.text = readFileSync(file, 'utf8')
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    return cache.text
  } catch {
    return cache.text
  }
}

/** 「关于他.md」的 mtime 缓存；语义同 identityText。 */
const ownerCache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读「关于他」文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
export function ownerText(root) {
  try {
    const file = ownerDocPath(root)
    const st = statSync(file)
    if (ownerCache.file !== file || ownerCache.mtimeMs !== st.mtimeMs) {
      ownerCache.text = readFileSync(file, 'utf8')
      ownerCache.file = file
      ownerCache.mtimeMs = st.mtimeMs
    }
    return ownerCache.text
  } catch {
    return ownerCache.file === ownerDocPath(root) ? ownerCache.text : ''
  }
}

/** 测试用：清掉 owner 缓存，强制下次重新读盘。 */
export function resetOwnerCache() {
  ownerCache.file = ''
  ownerCache.mtimeMs = -1
  ownerCache.text = ''
}

/** 测试用：清掉缓存，强制下次重新读盘。 */
export function resetIdentityCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.text = ''
  resetOwnerCache()
}

/**
 * 把身份段挂到某个 agent 的 system prompt 上。
 * @param {object} agent
 * @param {string} root
 * @param {{canRemind?: (agent:object)=>boolean, inboxText?: ()=>string, surfaceOf?: (agent:object)=>string}} [opts]
 *   canRemind：这条会话是不是微信那条。不是的话，提醒说明返回空串——
 *   QQ / 网页里的她看不到「去微信发提醒」这段，免得把通道说明带错地方。
 *   inboxText：还没回完的微信任务摘要；同样是「不在微信那条会话里就不显示」。
 *   surfaceOf：这次会话在哪个面（web/wx/screen/bili/qq）；`fish:owner` 只在前三个面渲染。
 * @returns {{ ok: boolean, why?: string }}
 */
export function attachIdentity(agent, root, { canRemind, inboxText, surfaceOf } = {}) {
  const sp = agent?.ctx?.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' }
  }
  try {
    sp.section({
      name: IDENTITY_SECTION,
      order: IDENTITY_ORDER,
      // 每次组装提示词时求值：文件变了，下一轮就是新的她。
      text: () => identityText(root),
    })
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      // 按会话取：home 和出门会话各自只看到自己的处境。
      text: () => wakeSectionFor(agent),
    })
    // 定时提醒的工具说明。固定文本，不随配置变；只在微信那条会话里出现。
    sp.section({
      name: REMIND_SECTION,
      order: REMIND_ORDER,
      text: () => (canRemind && !canRemind(agent) ? '' : REMIND_PROMPT),
    })
    // 还没回完的微信任务。没有任务时是空串；同样只在微信那条会话里出现。
    sp.section({
      name: INBOX_SECTION,
      order: INBOX_ORDER,
      text: () => {
        if (canRemind && !canRemind(agent)) return ''
        const body = String(inboxText?.() ?? '').trim()
        return body ? '## 微信里还没回完的任务\n\n' + body : ''
      },
    })
    // 哪些名字是他。只在 web / wx / screen 出现；没有 owner 文档时是空串。
    // screen 的支持由实现保证，Phase 1 的测试按 D28 不断言，等 presence 的面表落地。
    sp.section({
      name: OWNER_SECTION,
      order: OWNER_ORDER,
      text: () => {
        let surface = 'web'
        try {
          surface = String(surfaceOf?.(agent) ?? 'web')
        } catch {
          return ''
        }
        if (surface !== 'web' && surface !== 'wx' && surface !== 'screen') return ''
        return ownerSectionText({ doc: ownerText(root) })
      },
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
  }
}

/**
 * 注册 `agent/created` 监听。**必须先于任何 agent 创建**（与工具面收窄同理），
 * 所以 index.js 里放在 ensureHer 之后、bootstrapHome 之前。
 *
 * @returns {() => void} 卸载函数；挂不上时返回一个空函数，不抛
 */
export function registerIdentity(ctx, { root, herDir, log, surfaceOf } = {}) {
  const state = { ok: false, applied: 0, why: '' }
  /** 这条会话是不是 dsh-wx 的微信会话。拿不到服务就先当不是，下一轮再求值。 */
  const canRemind = (agent) => {
    try {
      const id = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
      if (!id || id.startsWith('onebot-')) return false
      const wx = ctx.get?.('wx')
      return !!wx?.isWxSession?.(id)
    } catch {
      return false
    }
  }
  /** 任务摘要由 dsh-wx 提供；服务没起来或没有任务时就是空串。 */
  const inboxText = () => {
    try {
      const wx = ctx.get?.('wx')
      return wx?.inboxSummary?.({ max: 5 }) ?? ''
    } catch {
      return ''
    }
  }
  const onCreated = ({ agent } = {}) => {
    try {
      if (!herDir) return
      if (!isHerAgent(agent, herDir)) return
      const r = attachIdentity(agent, root, { canRemind, inboxText, surfaceOf })
      if (r.ok) {
        state.ok = true
        state.applied += 1
        log?.(`[dsh-fish] 身份段已挂进 system prompt（第 ${state.applied} 次）`)
      } else {
        state.ok = false
        state.why = r.why ?? 'unknown'
        log?.(`[dsh-fish] 身份段没挂上：${state.why}`)
      }
    } catch (err) {
      state.why = String(err?.message ?? err).slice(0, 200)
      log?.(`[dsh-fish] 身份段挂了：${state.why}`)
    }
  }
  const off = ctx.on?.('agent/created', onCreated)
  if (typeof off !== 'function') {
    // 没挂上监听也别抛：index.js 会让插件照常启动，只是她的身份会缺一段。
    state.why = 'ctx.on 不可用'
    return () => {}
  }
  return off
}
