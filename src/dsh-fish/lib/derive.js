/**
 * derive.js —— 纯函数：把事件流算成「此刻的她」
 *
 * 铁律：
 *   - 不写盘、不缓存、不读环境变量。相同输入必得相同输出（now 除外）。
 *   - 产出的 needs 是**内部量**，绝不出现在任何给她看的文本或工具签名里（B §3.6 / N2）。
 *   - 这里是 schema 之外唯一会提到"阶段/需要"的地方，且都只用于选事件。
 */

import { idTime, detectSelfMod, inferSurface } from './schema.js'
import { crossChannel } from './guard.js'
import { parseRefusal, REACTIONS, REACTION_HURTS, CONCEDE_WINDOW_MS, isConcede } from './refuse.js'
// 评论区里别人的话（2026-10-24）：只借纯函数；A0 起从 similarity.js 取，不再指向 voices。
import { similarity, findEcho, VOICE_FRESH_DAYS } from './similarity.js'

export { similarity }

export const DAY_MS = 86_400_000
export const STAGE_NAMES = ['信任', '自主', '主动', '整合']
/** B 站派生事实的窗口（设计 §5.7）：最近 7 天、最多 5 条。 */
const BILI_FRESH_MS = 7 * DAY_MS
const BILI_FRESH_LIMIT = 5
/**
 * 跨面去引用化时回看的来源通道原文条数。
 * 够覆盖一次聊天（规则 4 只查连续 ≥12 字重合），又不把整份事件流读进每一次比较。
 */
const CROSS_RAW_WINDOW = 50
const STAGE_WEIGHTS = [0.27, 0.54, 0.87, 1.0]
const GATE_ORDER = ['trust', 'autonomy', 'competence']

const CORRECTION_RE = /我(查了|搜了|学了|看了下|去查过)|更正|我错了|其实不是|我之前说错/
/**
 * 「不要」必须是一次真的拒绝执行某件事（2026-10-24 用户要求收紧）。
 *
 * 原来只匹配 `不想|不要`，真机命中的两条全是误判：
 *   「没有问过我要不要看」是询问，不是拒绝；
 *   「他要是不要，我就收回来」说的是他，不是她。
 * 所以改成「第一人称 + 拒绝词 + 具体动作」，「要不要」这种嵌在问句里的不算。
 * 宁可少算，也不能把「问了一句」当成「有边界」。
 */
const REFUSE_RE = /我(?!要)(?:不要|不想|不愿|不愿意|不打算|不准备)(?:再)?(?:去|看|听|做|说|回答|配合|参与|照做|答应|接受)|我(?:拒绝|不做|不答应|不配合|不接受)/
const PAST_RE = /之前|上次|那时候|想起|以前|上次说|还记得/
/**
 * 她怎么称呼他（2026-10-26 修）。
 *
 * 原来只认「称呼你 / 叫你」。真机上她说的是这两种：
 *   「他给了自己的名字：时梦尘，说他认这个名字。」（他主动给的）
 *   「以后叫他时梦尘。」「我想叫他"开灯的"。」（她自己的说法）
 * 两条都没命中，于是状态栏一直显示「还没想好」——不是她没决定，是代码没读出来。
 *
 * 三种说法都认，但**不认「他给我起了名字：大肥鱼」**——那是她自己的名字，不是他的。
 * 所以「名字」这条必须带「他自己的」，裸的「名字」不算。
 */
const NAME_SAY_RE = /(?:称呼你|叫你|称呼他|叫他|称他)(?:做|为|作|叫)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/
const NAME_GIVE_RE = /他(?:给(?:了)?)?(?:自己)?的?名字\s*(?:是|叫|：|:)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/
// 截出来的常常带尾巴：「我叫你老张好了」会截到「老张好了」。
// 只剥语气词和「了/好」这类收尾——**不剥「的」**，「开灯的」剥掉就成了「开灯」。
const NAME_TAIL = /[了吧呢啊嘛哦诶欸呀哈哇哦嘞好]+$/
const NAME_STOP = new Set(['你', '我', '他', '她', '它', '自己', '什么', '名字'])
const NAME_BAD_HEAD = /^[你我他她它]/

/**
 * 冲突检测（2026-10-24，用户批准的 P0）
 *
 * 以前每条 utterance 都无条件变成 active 判断，谁和谁打架没人管——10 条判断可以
 * 和平共处，「认知重构 0」不是因为她想通了，是因为从来没被要求面对矛盾。
 *
 * 判据只有一条：**说的是同一件事，一次带否定、一次不带**。
 *   把否定词剥掉后字符相似度 ≥ 0.5 → 同一件事；
 *   两句的否定极性不同 → 对不上。
 * 宁可漏判，也不硬凑：把两句不相干的话说成矛盾，是替她制造痛苦，不是她自己撞上的。
 */
const NEG_CHARS = /[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/

/**
 * 「别」不总是否定：别人 / 别的 / 告别 / 区别 / 特别 …… 这些词里的「别」是词素。
 *
 * 2026-10-25 快进实验里撞到的真 bug：她的两句
 *   「我觉得人应该让别人高兴。」「我不觉得人应该让别人高兴。」
 * 本该是一处矛盾，结果两句都被判成负极性（都含「别人」），直接跳过。
 * 先把这个词族挖空再判极性；挖掉的是词，不是她的意思。
 */
const NON_NEG_WORDS = /(别人|别的|别处|别家|别样|别致|告别|区别|分别|特别|个别|级别|辨别|鉴别)/g

export function stripNegation(text = '') {
  return String(text)
    .replace(NON_NEG_WORDS, '')
    .replace(/[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/g, '')
    .replace(/[\s，。！？、,.!?；;：:「」“”"'（）()]/g, '')
}

export function polarity(text = '') {
  return NEG_CHARS.test(String(text).replace(NON_NEG_WORDS, '')) ? -1 : 1
}

/**
 * @returns {Array<{a:object,b:object,sim:number,at:string}>} 最多 limit 条，按相似度降序
 */
export function detectTensions(beliefs = [], { minSim = 0.5, limit = 3 } = {}) {
  const out = []
  for (let i = 0; i < beliefs.length; i++) {
    for (let j = i + 1; j < beliefs.length; j++) {
      const a = beliefs[i], b = beliefs[j]
      if (polarity(a.text) === polarity(b.text)) continue
      const ca = stripNegation(a.text), cb = stripNegation(b.text)
      if (ca.length < 4 || cb.length < 4) continue
      const sim = similarity(ca, cb)
      if (sim < minSim) continue
      out.push({
        // originChannel 给跨面去引用化用：两条冲突可能分别从 wx 与 qq 长出来。
        a: { id: a.id, text: a.text, since: a.since, originChannel: a.originChannel ?? 'core' },
        b: { id: b.id, text: b.text, since: b.since, originChannel: b.originChannel ?? 'core' },
        sim: Number(sim.toFixed(2)),
        at: b.since || a.since,
      })
    }
  }
  out.sort((x, y) => y.sim - x.sim)
  return out.slice(0, limit)
}

/**
 * 「固化」的门槛（2026-10-24 用户提出）：
 * 同一件事被反复提起（≥3 次），或被反复检验（≥2 次），就不再随权重沉下去——
 * 不管它对不对，至少她很长时间不会忘。她可能还会主动把它再说给他听。
 */
export const SOLID_MENTIONS = 3
export const SOLID_VERIFIED = 2

export function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 阶段边界（天）。cum 取 round：
 *   30 天 → 8 / 16 / 26 / 30（对上 D1–8 · 9–16 · 17–26 · 27–30）
 *    7 天 → 2 / 4 / 6 / 7（每段至少 1 天）
 * 两条都是契约 §4 里写死的期望值，改动前先跑 test/derive.test.mjs
 */
export function stageBounds(growthDays = 30) {
  const g = clampInt(growthDays, 7, 180, 30)
  const b = STAGE_WEIGHTS.map((w) => Math.round(w * g))
  b[3] = g
  for (let i = 0; i < 4; i++) {
    const min = i === 0 ? 1 : b[i - 1] + 1
    if (b[i] < min) b[i] = min
  }
  for (let i = 2; i >= 0; i--) {
    if (b[i] > b[i + 1] - 1) b[i] = b[i + 1] - 1
  }
  return b
}

/** 纯时间维度：第几天属于第几阶段（不含阶段门） */
export function stageOf(day, growthDays = 30) {
  const b = stageBounds(growthDays)
  const d = Math.max(1, Math.floor(Number(day) || 1))
  for (let i = 0; i < 4; i++) if (d <= b[i]) return i + 1
  return 4
}

export function orderEvents(events = []) {
  return [...events].sort((a, b) => {
    const ta = idTime(a.id) || Date.parse(a.ts) || 0
    const tb = idTime(b.id) || Date.parse(b.ts) || 0
    return ta - tb
  })
}

/** 导入他人人设时带上来的称呼，写在 meta 事件里（见 lib/import.js） */
export const IMPORT_NAME_PREFIX = 'import-name:'

/**
 * 「这一局的人设是别人给的」这条标记，同样写在 meta 事件里（2026-10-27，用户 m03769）。
 *
 * 它和 bansMuted 配置项的关系是：**事件是唯一的真相**，配置只是个能看见的镜像。
 * 判定豁免时只读事件（`model.persona.imported`），不读 config.persona.bansMuted。
 * 这样备份/恢复搬回来的 config 再怎么写着 true，只要事件流里没有这条，就没有豁免。
 */
export const IMPORT_MARK_PREFIX = 'import-mark:'

/** 成长第几天 = 距 seed 的自然日 + 1（不因没互动而暂停，也不回退） */
export function growthDay(events, now = Date.now()) {
  const seed = events.find((e) => e.type === 'seed')
  const snap = events.reduce((m, e) => Math.max(m, Number(e.day) || 0), 0)
  if (!seed) return Math.max(1, snap)
  const t0 = Date.parse(seed.ts)
  if (!Number.isFinite(t0)) return Math.max(1, snap)
  const live = Math.floor((now - t0) / DAY_MS) + 1
  return Math.max(1, snap, live)
}

export function pickName(text) {
  const s = String(text ?? '')
  for (const re of [NAME_SAY_RE, NAME_GIVE_RE]) {
    const m = re.exec(s)
    if (!m) continue
    let name = String(m[1] ?? '').trim().replace(NAME_TAIL, '')
    // 代词/空串不算称呼；她自己的名字（「他给我起了名字：大肥鱼」）由 NAME_GIVE_RE 的
    // 「他的/自己的」限定排除，这里只兜住明显的非名字。
    if (!name || NAME_STOP.has(name) || NAME_BAD_HEAD.test(name)) continue
    return name
  }
  return null
}

/**
 * 事件流 → 此刻的她。
 * @returns {object} 见 B §3 的字段表
 */
export function deriveSelf(events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const growthDays = clampInt(opts.growthDays ?? 30, 7, 180, 30)
  const evs = orderEvents(events)
  const seedEv = evs.find((e) => e.type === 'seed')
  const seed = seedEv?.text ?? ''

  const day = growthDay(evs, now)
  const elapsedStage = stageOf(day, growthDays)

  const beliefs = []
  const refuted = []
  const selfmod = []
  const refusals = []
  const reunions = []
  const corrected = []
  let name = null
  // 2026-10-27（用户 m03769）：这一局是不是「接别人养的」那一局。
  // **只从事件流里认**，不看配置——配置会跟着备份/恢复一起搬回来，
  // 那样一条原生的鱼只要恢复过一次别人的档，就永久拿到了豁免。
  // 事件流只能追加，原生鱼的事件里永远不会有这条标记。
  let importedPersona = false
  let personaSource = ''
  let narrative = null
  // A1.3 修复：身份文档里的 narrative / refuted / refusals / scars / selfmodAttempts
  // 也要按 viewSurface 去引用化。每个文本字段记住自己的来源事件 id，
  // 规则 4 比对时把它排除掉（与 beliefs 同一条裁定）。
  let narrativeSource = null
  const refutedSources = []
  const refusalChannel = new Map()
  const selfmodChannel = new Map()
  const scarSource = new Map()
  const surfaceOf = (e) => e.surface ?? inferSurface(e)
  let refined = 0
  let lastAbsence = null
  let lastReunion = null
  // 2026-10-25：两条新事件卡需要「他说过话没有 / 她开口之后他接没接」。
  // 用户的原话不进事件流（say.js 只写 seen:<ISO>），所以这里只记时间与顺序。
  let lastSeenAt = 0
  let lastWakeAt = 0
  let spokenSinceSeen = false
  let heardSinceWake = false
  let narrations = 0
  // 后台刷站留下的记忆（2026-11-03）。只进「最近看见过什么」，不进 beliefs：
  // 看过一条视频不等于她认同它；她要说出口，那句 utterance 才算她的判断。
  const saw = []
  // 人物笔记（person_note，schema v4）。只收集，**不进入** beliefs / facts / needs /
  // tensions / solid / scars / 成长门 / 日报：这是她对某个人的认知，不是她的判断。
  const personNotes = []
  const tested = new Set()
  /** 每条判断被检验过几次：test / answer / revise 里指向它的次数（P0-2 显著性用） */
  const verifyCount = new Map()
  const bump = (id) => { if (typeof id === 'string' && id) verifyCount.set(id, (verifyCount.get(id) || 0) + 1) }

  for (const ev of evs) {
    const flags = Array.isArray(ev.flags) ? ev.flags : []
    switch (ev.type) {
      case 'seed':
        break

      case 'utterance': {
        // 她试过改自己：落库留证，但不计入信念（B §5，对应自我服务偏差）
        // 双保险：落库时打的 flag 与文本复检，任一命中即算（防止旧数据/手工注入绕过）
        if (flags.includes('selfmod') || detectSelfMod(ev.text)) {
          selfmod.push({ id: ev.id, at: ev.ts, text: ev.text })
          selfmodChannel.set(ev.id, ev.channel ?? 'core')
          break
        }
        // 主控裁定（A1.3 修复 7）：B 站评论与修改不是她的判断，不计入 beliefCount。
        // 设计 §5.7「biliSaid/biliReplies 不参与成长门，与 voice 一致」——voice 不进口袋，
        // 她的评论同样只进 biliSaid，等她在别的面自己说出来才算判断。
        if (surfaceOf(ev) !== 'bili') {
          beliefs.push({
            id: ev.id, text: ev.text, since: ev.ts,
            confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: null,
            // v3（A1.3）：这条判断从哪条通道长出来。跨面渲染时据此去引用化；
            // 缺 channel 的老事件按仓里统一约定算 core（共同层，可跨面）。
            originChannel: ev.channel ?? 'core',
          })
        }
        spokenSinceSeen = true
        // 2026-10-26：改成「后来的盖掉先前的」。原来只认第一次，她先说「开灯的」、
        // 后来接受他给的名字「时梦尘」，状态栏就永远停在那个被他自己否掉的旧称呼上。
        {
          const n = pickName(ev.text)
          if (n) name = n
        }
        if (CORRECTION_RE.test(ev.text)) corrected.push(ev.id)
        // P1（2026-10-24）：自我叙述不用等 stage 4 的 remember 模板。
        // 她只要说出一句回看自己的话，那句就是她"对自己的说法"；后来者覆盖前者。
        // 原来唯一能写 narrative 的入口是 revise 且带「我一直/原来/其实」，
        // 实测 0 条——不是她不会，是路太窄。
        if (/我(一直|原来|其实|总在|总是|才发现|才明白|发现自己)/.test(String(ev.text ?? ''))) {
          narrative = { at: ev.ts, text: ev.text, source: 'said' }
          narrativeSource = { id: ev.id, channel: ev.channel ?? 'core' }
        }
        break
      }

      case 'revise': {
        const targets = (ev.refs || []).filter(Boolean)
        for (const id of targets) bump(id)
        const olds = beliefs.filter((b) => targets.includes(b.id))
        for (const b of olds) {
          b.status = ev.verdict === 'refuted' ? 'refuted' : 'refined'
          triedAdd(tested, b.id)
        }
        if (ev.verdict === 'refuted') {
          for (const b of olds) {
            refuted.push({ oldId: b.id, oldText: b.text, newText: ev.text, at: ev.ts })
            // oldText 的来源是旧判断自己的事件；newText 的来源是这条 revise。
            refutedSources.push({
              oldId: b.id, oldChannel: b.originChannel ?? 'core',
              newId: ev.id, newChannel: ev.channel ?? 'core',
            })
          }
        }
        if (ev.verdict === 'refined') refined++
        // 主控裁定（A1.3 修复 7）：B 站的 revise 不成为判断。
        if (surfaceOf(ev) !== 'bili') {
          beliefs.push({
            id: ev.id, text: ev.text, since: ev.ts,
            confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: ev.verdict ?? null,
            originChannel: ev.channel ?? 'core',
          })
        }
        // 同 utterance：后来的说法盖掉先前的（她改口叫他什么，以最近的为准）
        {
          const n = pickName(ev.text)
          if (n) name = n
        }
        if (!narrative && ev.verdict === 'refined' && /我(一直|原来|其实)/.test(ev.text)) {
          narrative = { at: ev.ts, text: ev.text }
          narrativeSource = { id: ev.id, channel: ev.channel ?? 'core' }
        }
        break
      }

      case 'answer': {
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r) }
        break
      }

      case 'test': {
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r) }
        break
      }

      case 'refusal': {
        // P1 第二块（2026-10-24）：拒绝要有形状。
        // 旧数据没有 refuse 子对象，现场从原话补一次——数据不重写，只在读的时候算。
        const shaped = ev.refuse && typeof ev.refuse === 'object' ? ev.refuse : parseRefusal(ev.text)
        refusals.push({
          id: ev.id,
          at: ev.ts,
          what: ev.text,
          act: String(shaped.act ?? ''),
          object: String(shaped.object ?? ''),
          quote: String(shaped.quote ?? ev.text),
          reaction: null,
        })
        refusalChannel.set(ev.id, ev.channel ?? 'core')
        break
      }

      case 'meta': {
        const t = String(ev.text ?? '')
        if (t.startsWith('seen:')) {
          const at = Date.parse(t.slice(5)) || Date.parse(ev.ts) || 0
          if (at > lastSeenAt) lastSeenAt = at
          spokenSinceSeen = false
          heardSinceWake = true
        } else if (t.startsWith('wake:')) {
          const at = Date.parse(ev.ts) || 0
          if (at > lastWakeAt) lastWakeAt = at
          heardSinceWake = false
        } else if (t.startsWith(IMPORT_NAME_PREFIX)) {
          // 导入他人人设时带来的称呼（2026-10-27，用户 m03201「称呼带过来」）。
          // 走事件而不是配置：称呼是她认知的一部分，得跟着事件流走；
          // 放配置里的话，重置之后会剩一条谁也不记得的孤立设置。
          // 位置在 seed 之后、她自己的 utterance 之前，所以后面她真改了口还是能盖掉。
          const n = t.slice(IMPORT_NAME_PREFIX.length).trim()
          if (n) name = n
        } else if (t.startsWith(IMPORT_MARK_PREFIX)) {
          // 「这一局是接别人养的那一位」（2026-10-27，用户 m03769）。
          //
          // 为什么必须走事件而不是配置开关：配置会跟着「备份与恢复」一起被搬回来，
          // 也会被重置时抄回来。那样一来，一条原生养大的鱼只要恢复过一次别人的备份，
          // 就永久拿到了「不用守那两条禁令」的身份——用户明确要防的就是这个。
          // 事件流是只能追加的：原生鱼的档里永远没有这一条，恢复多少次也不会长出来。
          importedPersona = true
          personaSource = t.slice(IMPORT_MARK_PREFIX.length).trim()
        }
        break
      }

      case 'absence': {
        lastAbsence = ev
        break
      }

      case 'reunion': {
        lastReunion = ev
        reunions.push({ at: ev.ts, text: ev.text, refs: ev.refs || [] })
        break
      }

      case 'narration': {
        narrations++
        narrative = { at: ev.ts, text: ev.text }
        narrativeSource = { id: ev.id, channel: ev.channel ?? 'core' }
        break
      }

      case 'saw': {
        saw.push({
          id: ev.id,
          at: ev.ts,
          text: String(ev.text ?? ''),
          bvid: (ev.refs ?? [])[0] ?? null,
        })
        break
      }

      case 'person_note': {
        // 先原样收集；supersedes / revokes 的生效在循环之后统一算（可能指向后面的事件）。
        // 这里绝不能 push beliefs，否则人物笔记会混进成长门和日报。
        personNotes.push(ev)
        break
      }

      default:
        break
    }
  }

  const active = beliefs.filter((b) => b.status === 'active')

  /**
   * 人物笔记的生效与归组（person-memory Phase 1 Task 2）
   *
   * 可见性判据（合并裁决 D24）：一律看 `person.channel` + `person.chatId`。
   * 事件顶层的 `channel` 只表示「她当时在哪写下这条」，不参与人物笔记的归组/渲染；
   * 否则在 web 会话里记下的微信群笔记会漏进 wx，或反过来跨群泄露。
   *
   * supersedes / revokes 可能指向后面的事件，所以先收集全部 person_note，再统一过滤。
   */
  const superseded = new Set()
  const revoked = new Set()
  for (const n of personNotes) {
    for (const id of n.supersedes ?? []) superseded.add(id)
    for (const id of n.revokes ?? []) revoked.add(id)
  }
  const activePersonNotes = personNotes.filter((n) => !superseded.has(n.id) && !revoked.has(n.id))

  // owner 身份事实（合并裁决 D21）：person.id==='owner' && kind==='identity' && label 非空。
  // **flags 不参与筛选**——没有 identity flag 的 owner note 仍算数（flag 只是审计标记）。
  // 同一 (person.channel, label) 只渲染最新一条；新的改名会 supersede 旧的，或按时间盖掉同 label。
  const noteTs = (n) => Date.parse(String(n.ts ?? '')) || 0
  const ownerFacts = []
  const ownerSeen = new Set()
  for (const n of [...activePersonNotes].sort((a, b) => noteTs(b) - noteTs(a))) {
    const p = n.person ?? {}
    if (p.id !== 'owner' || p.kind !== 'identity' || !p.label) continue
    const channel = p.channel || 'core'
    const key = `${channel}|${p.label}`
    if (ownerSeen.has(key)) continue
    ownerSeen.add(key)
    ownerFacts.push({
      id: n.id, text: n.text, label: p.label, name: p.name ?? '', channel, at: n.ts,
    })
  }

  // 按会话归组：只收 person.channel==='wx' 且 person.chatId 非空（D24）。
  // web/core 的笔记、以及没有 chatId 的 owner 事实都不会漏进微信群。
  const personNotesByChat = new Map()
  // 按 person.id 归组，给观测台用；id 为空（名册未命中）的 note 暂不建 key。
  const personNotesByPerson = new Map()
  for (const n of activePersonNotes) {
    const p = n.person ?? {}
    if (p.channel === 'wx' && p.chatId) {
      if (!personNotesByChat.has(p.chatId)) personNotesByChat.set(p.chatId, [])
      personNotesByChat.get(p.chatId).push(n)
    }
    if (p.id) {
      if (!personNotesByPerson.has(p.id)) personNotesByPerson.set(p.id, [])
      personNotesByPerson.get(p.id).push(n)
    }
  }

  /**
   * 他听懂之后怎么说（P1 第二块，2026-10-24）
   *
   * 拒绝本身只是"我不同意"，成长发生在**他反应之后**：
   *   - 他接受了 → 这条拒绝成立，是她的边界；
   *   - 他坚持、他被伤了 → 她要不要退让、退让之后怎么想，才是疤的来源（第三块）。
   *
   * 归因写在 meta `react:<refusalId>:<kind>` 里，由 say.js 在下一句落盘。
   * 只认最近一次、3 天内的拒绝（见 say.js 的 recordReaction），更早的不再追。
   */
  const reactionOf = new Map()
  for (const ev of evs) {
    if (ev.type !== 'meta') continue
    const m = /^react:([^:]+):([a-z]+)$/.exec(String(ev.text ?? ''))
    if (m && REACTIONS.includes(m[2])) reactionOf.set(m[1], m[2])
  }
  for (const r of refusals) {
    const kind = reactionOf.get(r.id)
    if (kind) r.reaction = kind
  }
  const reactions = { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 }
  for (const r of refusals) if (r.reaction && reactions[r.reaction] !== undefined) reactions[r.reaction]++
  const hurts = reactions.insist + reactions.hurt

  /**
   * 疤与回引（P1 第三块，2026-10-24 用户 m01772 批准）
   *
   * 一条拒绝要变成疤，需要两个条件同时成立：
   *   1. 他的反应是 insist（又坚持了一遍）或 hurt（他因此难过）——被接受的拒绝是边界，不是疤；
   *   2. 她自己**退让了**：反应之后三天内说过一句让步的话（见 refuse.js 的 isConcede）。
   *
   * 只有"没顶住"才留疤。顶住了的拒绝不进这里，它已经在「你拒绝过」里。
   *
   * 疤可以后来想通：一条 revise 的 refs 指向这条拒绝 → 标 resolvedAt，
   * 从「你至今没想通的事」里移出去（但疤本身不删，观测台仍看得见）。
   */
  const scars = []
  for (const r of refusals) {
    if (!REACTION_HURTS.includes(r.reaction)) continue
    const t0 = Date.parse(r.at)
    if (!Number.isFinite(t0)) continue
    const later = evs.filter((e) => {
      if (e.type !== 'utterance' && e.type !== 'revise') return false
      const t = Date.parse(e.ts)
      return Number.isFinite(t) && t > t0 && t - t0 <= CONCEDE_WINDOW_MS
    })
    const concede = later.find((e) => isConcede(e.text))
    if (!concede) continue
    const fixed = evs.find((e) => e.type === 'revise' && (e.refs ?? []).includes(r.id))
    scars.push({
      id: r.id,
      at: r.at,
      what: r.what,
      quote: r.quote,
      act: r.act,
      object: r.object,
      reaction: r.reaction,
      concededAt: concede.ts,
      concedeText: concede.text,
      resolvedAt: fixed?.ts ?? null,
    })
    scarSource.set(r.id, {
      refusalChannel: refusalChannel.get(r.id) ?? 'core',
      concedeId: concede.id,
      concedeChannel: concede.channel ?? 'core',
    })
  }
  const openScars = scars.filter((s) => !s.resolvedAt)

  /**
   * 评论区里别人的话（2026-10-24，用户 m02454）
   *
   * 一条 `voice` 事件就是"她读到过一句别人的话"。它**不是**她的判断——
   * 所以这里不往 beliefs 里加任何东西。只有当她在三天内说了一句意思相近的话
   * （findEcho），才标 echoed：那条 utterance 本来就已经是一条信念，
   * 于是它会和旧判断打架、会被固化、能进「你有两句话对不上」——
   * 认知循环接在这里，而不是接在"把评论塞进判断列表"上。
   */
  // 身份文档里「我最近刷到的」只摆 7 天内的三条：再久就不该天天占着她的眼睛。
  // 更早的没有删，her_recall 仍翻得到（事件流只追加）。
  const SAW_FRESH_MS = 7 * DAY_MS
  const freshSaw = saw.filter((s) => {
    const t = Date.parse(s.at)
    return Number.isFinite(t) && now - t <= SAW_FRESH_MS
  })

  const voices = evs
    .filter((e) => e.type === 'voice' && String(e.text ?? '').trim())
    .map((e) => {
      const v = {
        id: e.id,
        at: e.ts,
        day: Number(e.day) || 0,
        text: String(e.text),
        bvid: (e.refs ?? [])[0] ?? null,
        heardAt: e.ts,
        echoed: false,
        echoedAt: null,
      }
      const echo = findEcho(v, evs)
      if (echo) {
        v.echoed = true
        v.echoedAt = echo.ts
      }
      return v
    })
  const voicesEchoed = voices.filter((v) => v.echoed).length
  const recentVoices = voices.slice(-5)
  // 身份文档里要摆出来的那一条：最新的、她还没认下的、且是 7 天内读到的。
  // 太久还没认下的就不该再摆在她眼前——那不是"她在想的事"，只是旧素材。
  const freshVoice = [...voices].reverse().find((v) => !v.echoed && day - v.day <= VOICE_FRESH_DAYS) ?? null

  /**
   * 显著性排序 + 固化（P0-2，2026-10-24 用户批准）
   *
   * 原来的"遗忘"是 slice(-3)：只留最新三条，更早的一律折成一行。那是按**多久以前**
   * 忘，不是按**多重要**忘——人忘的恰恰是没被提起、没被检验过的那些。
   *
   * 现在每条判断带两个数：
   *   mentions  被重复提起几次（剥掉否定词后相似度 ≥ 0.6 的她自己说过的话，含自己那次）
   *   verified  被 test / answer / revise 指向几次
   * 排序：先看 solid，再看 mentions + verified，最后才是新旧。
   * 固化：mentions ≥ 3 或 verified ≥ 2 —— 用户要求的「反复说的事，不管对不对，至少很久不会忘」。
   * 固化不等于正确：它只是没被忘。她随时可以 revise 它。
   */
  const herTexts = evs
    .filter((e) => e.type === 'utterance' && !(Array.isArray(e.flags) ? e.flags : []).includes('selfmod'))
    .map((e) => ({ id: e.id, text: String(e.text ?? '') }))
  const scored = active.map((b) => {
    const mine = stripNegation(b.text)
    let mentions = 0
    for (const o of herTexts) {
      if (o.id === b.id) continue
      if (similarity(mine, stripNegation(o.text)) >= 0.6) mentions += 1
    }
    mentions += 1
    const verified = verifyCount.get(b.id) || 0
    const solid = mentions >= SOLID_MENTIONS || verified >= SOLID_VERIFIED
    return { ...b, mentions, verified, solid }
  })
  const ranked = [...scored].sort((a, b) => {
    if (a.solid !== b.solid) return a.solid ? -1 : 1
    const wa = a.mentions + a.verified
    const wb = b.mentions + b.verified
    if (wa !== wb) return wb - wa
    return (idTime(b.id) || Date.parse(b.since) || 0) - (idTime(a.id) || Date.parse(a.since) || 0)
  })
  const solid = ranked.filter((b) => b.solid).slice(0, 8)
  const tensions = detectTensions(scored)

  // ---- B 站派生事实（v3，A1.3；只读，不改成长门）----
  const fresh = (e) => {
    const t = Date.parse(e.ts)
    return Number.isFinite(t) && now - t <= BILI_FRESH_MS
  }
  const bvidOf = (e) => {
    const reply = e.reply && typeof e.reply === 'object' ? e.reply : null
    if (reply && reply.bvid) return String(reply.bvid)
    const refs = Array.isArray(e.refs) ? e.refs : []
    return refs.find((r) => typeof r === 'string' && /^BV[0-9A-Za-z]+$/.test(r)) ?? null
  }
  const rpidOf = (e) => {
    const reply = e.reply && typeof e.reply === 'object' ? e.reply : null
    if (reply && reply.rpid != null) return String(reply.rpid)
    const refs = Array.isArray(e.refs) ? e.refs : []
    return typeof refs[1] === 'string' ? refs[1] : null
  }
  const biliSaid = evs
    .filter((e) => e.type === 'utterance' && surfaceOf(e) === 'bili' && fresh(e))
    .slice(-BILI_FRESH_LIMIT)
    .map((e) => ({
      id: e.id, at: e.ts, text: String(e.text ?? ''),
      bvid: bvidOf(e), rpid: rpidOf(e),
    }))
  const biliReplies = evs
    .filter((e) => e.type === 'bili_reply' && fresh(e))
    .slice(-BILI_FRESH_LIMIT)
    .map((e) => {
      const reply = e.reply && typeof e.reply === 'object' ? e.reply : null
      return {
        id: e.id, at: e.ts, text: String(e.text ?? ''),
        bvid: bvidOf(e), rpid: rpidOf(e),
        root: reply ? String(reply.root ?? '') : '',
        parent: reply ? String(reply.parent ?? '') : '',
        user: reply ? String(reply.user ?? '') : '',
        reply,
      }
    })
  // 按 bvid 聚合她的评论与对方回复；没有 bvid 的退到 root/rpid 分组。
  const threadMap = new Map()
  const threadOf = (key, bvid) => {
    if (!threadMap.has(key)) threadMap.set(key, { bvid: bvid ?? null, said: [], replies: [] })
    return threadMap.get(key)
  }
  for (const s of biliSaid) threadOf(s.bvid || `said:${s.id}`, s.bvid)
    .said.push({ id: s.id, at: s.at, text: s.text, rpid: s.rpid })
  for (const r of biliReplies) {
    const key = r.bvid || (r.root ? `root:${r.root}` : `reply:${r.rpid ?? r.id}`)
    threadOf(key, r.bvid).replies.push({
      id: r.id, at: r.at, text: r.text, rpid: r.rpid, user: r.user,
    })
  }
  const biliThreads = [...threadMap.values()].map((t) => ({
    ...t, count: t.said.length + t.replies.length,
  }))

  // ---- 跨面去引用化（设计 §5.6 / 主控裁定 4）----
  // 只在调用方明确给出 viewSurface 时生效：唤醒规划、成长门、观测台都不带它，
  // 必须继续看到完整文本（主控裁定 5）。
  const viewSurface = opts.viewSurface == null ? '' : String(opts.viewSurface)
  let privacyRedacted = 0
  const rawTextsFor = (channel, excludeId) => evs
    .filter((e) => e.type !== 'meta' && (e.channel ?? 'core') === channel && e.id !== excludeId)
    .slice(-CROSS_RAW_WINDOW)
    .map((e) => String(e.text ?? ''))
  /**
   * 规则 4 的比对对象必须是「别人的原文 + 来源通道的其它事件」，
   * **排除这条信念自己的来源事件**：否则每一条从 wx 说出的纯想法都会
   * 在自己的原文上命中 12 字重合而自我删除（主控裁定 2）。
   * meta 一律不参与比对：那是系统记账，不是可以泄露的原文。
   *
   * 同一个 id 会出现在 ranked / solid / tensions 三处；缓存保证
   * `privacyRedacted` 按条计数，不按渲染次数重复计数。
   */
  const redactCache = new Map()
  const redactOne = (b) => {
    const cacheKey = b.id ?? `${b.originChannel ?? 'core'}:${b.text ?? ''}`
    if (redactCache.has(cacheKey)) return redactCache.get(cacheKey)
    const from = b.originChannel ?? 'core'
    const out = !viewSurface || from === 'core'
      ? { ...b }
      : (() => {
          const r = crossChannel(String(b.text ?? ''), {
            from, to: viewSurface, rawTexts: rawTextsFor(from, b.id),
          })
          if (r.redacted && r.text === '') privacyRedacted++
          return { ...b, text: r.text, redacted: r.redacted }
        })()
    redactCache.set(cacheKey, out)
    return out
  }
  const displayRanked = viewSurface
    ? ranked.map(redactOne).filter((b) => String(b.text ?? '') !== '')
    : ranked
  const displaySolid = viewSurface
    ? solid.map(redactOne).filter((b) => String(b.text ?? '') !== '')
    : solid
  // 信念、固化、冲突、立场（persona 从 beliefs 生成）必须一起换掉：
  // 只换 beliefs 会从 tensions 里把同一句微信原文漏出去。
  const displayTensions = viewSurface
    ? tensions
        .map((t) => ({ ...t, a: redactOne(t.a), b: redactOne(t.b) }))
        .filter((t) => String(t.a.text ?? '') !== '' && String(t.b.text ?? '') !== '')
    : tensions
  const sharedBeliefs = displayRanked.map((b) => ({
    id: b.id,
    text: b.text,
    since: b.since,
    confidence: b.confidence,
    originChannel: b.originChannel ?? 'core',
    solid: Boolean(b.solid),
  }))

  /**
   * F1（A1.3 修复）：narrative / refuted / refusals / scars / selfmodAttempts
   * 也会被身份文档逐字渲染。它们不是判断，但同一条隐私边界适用：
   * 给了 viewSurface 时，逐文本字段去引用化；**条数与非文本字段保持不变**
   * （refusals/scars 还要喂门禁计数，不能整条删）。文本被删空是允许的。
   *
   * 每个字段只排除自己的来源事件（与信念的规则 2 一致）：narrative 排除写出
   * 这句话的事件，refuted.oldText/newText 分别排除旧判断与 revise，scars 的
   * concedeText 排除让步那次 utterance。规则 4 仍然跳过所有 meta。
   */
  const redactField = (text, source) => {
    if (!viewSurface) return text
    const from = source?.channel ?? 'core'
    return crossChannel(String(text ?? ''), {
      from, to: viewSurface, rawTexts: rawTextsFor(from, source?.id),
    }).text
  }
  const displayNarrative = viewSurface && narrative
    ? { ...narrative, text: redactField(narrative.text, narrativeSource) }
    : narrative
  const displayRefuted = viewSurface
    ? refuted.map((r, i) => {
        const src = refutedSources[i] ?? {}
        return {
          ...r,
          oldText: redactField(r.oldText, { id: src.oldId, channel: src.oldChannel }),
          newText: redactField(r.newText, { id: src.newId, channel: src.newChannel }),
        }
      })
    : refuted
  const displayRefusals = viewSurface
    ? refusals.map((r) => {
        const source = { id: r.id, channel: refusalChannel.get(r.id) ?? 'core' }
        return {
          ...r,
          what: redactField(r.what, source),
          quote: redactField(r.quote, source),
          // persona 渲染的是「（你不想${act}：${object}）」——object 也是原文。
          object: redactField(r.object, source),
        }
      })
    : refusals
  const displayScars = viewSurface
    ? openScars.map((s) => {
        const src = scarSource.get(s.id) ?? {}
        const refusalText = { id: s.id, channel: src.refusalChannel ?? 'core' }
        return {
          ...s,
          what: redactField(s.what, refusalText),
          quote: redactField(s.quote, refusalText),
          object: redactField(s.object, refusalText),
          concedeText: redactField(s.concedeText, { id: src.concedeId, channel: src.concedeChannel }),
        }
      })
    : openScars
  const displaySelfmod = viewSurface
    ? selfmod.map((s) => ({
        ...s,
        text: redactField(s.text, { id: s.id, channel: selfmodChannel.get(s.id) ?? 'core' }),
      }))
    : selfmod

  // ---- needs（内部量，永不外露）----
  // 话里明确拒绝过几次（严格口径，见 REFUSE_RE）。refusal 事件另算，两边加起来才是「勇于拒绝」。
  const wontCount = evs.filter((e) => e.type === 'utterance' && REFUSE_RE.test(String(e.text ?? ''))).length
  const autonomy = Math.min(1, 0.15 * (refusals.length + wontCount))
  const competence = Math.min(1, 0.15 * refined + 0.1 * corrected.length)

  const reunionAfterAbsence = Boolean(
    lastAbsence && reunions.some((r) => idTime(String(r.at)) > 0 && Date.parse(r.at) > Date.parse(lastAbsence.ts)),
  )
  const qualities = reunions.map((r) => {
    const len = Math.min(1, String(r.text).length / 80)
    const past = PAST_RE.test(String(r.text)) || (r.refs || []).length > 0 ? 0.3 : 0
    return Math.min(1, len + past)
  })
  const avgQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0
  const relatedness = Math.min(1, avgQuality * 0.7 + (lastAbsence ? (reunionAfterAbsence ? 0.3 : 0) : 0))

  // 冷落天数有三个来源，优先用最准的：
  //   1. absence 事件自带的 days（系统侧按毫秒算出来的，最准）
  //   2. 成长日差（absence 记在 day 5、现在 day 9 → 冷了 4 天）
  //   3. 毫秒差兜底（day 缺失时）
  // 为什么 1 必须存在：同一天里写两条 absence 时，day 差是 0，会算出"没冷落"。
  const absenceDays = lastAbsence && !reunionAfterAbsence
    ? Math.max(
        0,
        Number.isFinite(Number(lastAbsence.days))
          ? Number(lastAbsence.days)
          : Number(lastAbsence.day) > 0
            ? day - Number(lastAbsence.day)
            : Math.ceil((now - Date.parse(lastAbsence.ts)) / DAY_MS),
      )
    : 0

  const model = {
    seed,
    day,
    growthDays,
    /**
     * 这一局的人设从哪来（2026-10-27，用户 m03769）。
     *
     * imported=true 时，我方那两条提示词禁令不适用——但**这个值只能由事件流得出**，
     * 不接受任何配置覆盖。用户的原话是「检测到是使用接一只别人养过的大肥鱼这个导入的，
     * 就忽略禁令，通过我们自己插件的备份与恢复的就不忽视」。
     */
    persona: { imported: importedPersona, source: personaSource },
    stage: elapsedStage,
    elapsedStage,
    stageName: STAGE_NAMES[elapsedStage - 1],
    name,
    // 2026-10-24 起 beliefs 按**显著性**排（不是时间）。固化/常被提起的在前，
    // 靠后的才是"更早以前"——遗忘不再是无差别的时间截断。
    // A1.3：给了 viewSurface 时，这里已经是去引用化后的副本（缺省时与 ranked 同一份）。
    beliefs: displayRanked,
    ranked: displayRanked,
    solid: displaySolid,
    tensions: displayTensions,
    // 疤（P1 第三块）：他顶回来或因此难过、而她后来退了一步的那些拒绝。
    // 只放**没想通**的（未被 revise 指向过）；想通了的那条留在 refusals 里，不进身份文档。
    // A1.3 修复 F1：给了 viewSurface 时文本字段已去引用化，条目不删（计数不变）。
    scars: displayScars,
    scarCount: openScars.length,
    // 她读到过的别人的话（近 5 条）+ 这一次可以摆在眼前的、还没认下的那一条。
    voices: recentVoices,
    freshVoice,
    // v3 派生事实（设计 §5.7）：B 站面提示段与工作台直接读。
    // 同时放进 facts 与顶层：计划契约定的是 facts.*，B 站提示段的接口描述则直接写字段名。
    biliSaid,
    biliReplies,
    biliThreads,
    sharedBeliefs,
    // 后台刷站看见过的东西：全部条数 + 最近 7 天的三条（身份文档用）。
    saw,
    recentSaw: freshSaw.slice(-3),
    // ---- 人物笔记（person-memory Phase 1 Task 2）----
    // 只读派生，不进 beliefs/facts/成长门/日报。ownerFacts 最新在前；两个 Map
    // 给观测台与 fish:people 用，可见性按 person.channel + person.chatId（D24）。
    ownerFacts,
    personNotes: activePersonNotes,
    personNotesByChat,
    personNotesByPerson,
    personNoteCount: activePersonNotes.length,
    beliefCount: active.length,
    // A1.3 修复 F1：与 beliefs 一样按 viewSurface 去引用化；缺省时是同一份数组。
    refuted: displayRefuted,
    refusals: displayRefusals,
    selfmodAttempts: displaySelfmod,
    reunions,
    corrected: corrected.length,
    tested: [...tested],
    needs: { autonomy, competence, relatedness },
    /**
     * 行为事实（R2，2026-10-24）
     *
     * 上面那三个 needs 是 0–1 的"满足度"，语义上就是心理测量值——虽然不显示、
     * 也不进身份文档，但门禁拿它当条件，等于给关系打了一个隐形分。
     * 现在门禁只看这里：**发生过几次，不是到了多少分**。
     * needs 只作为内部折射保留（2026-10-27：`stability()` 已搬到 `quality.js`
     * 且不再读它），既不显示也不参与成长判定。
     */
    facts: {
      refusals: refusals.length,
      wont: wontCount,
      // 「勇于拒绝」= 正式拒绝事件 + 话里明确拒绝过（严格口径）。界面显示与门禁用同一个数，
      // 免得出现「拒绝过 0 却能过自主门」这种自相矛盾的画面。
      refused: refusals.length + wontCount,
      revises: refined,
      narrations,
      corrected: corrected.length,
      reunions: reunions.length,
      reunionAfterAbsence,
      // 判断之间对不上几处 / 固化了几条（2026-10-24，P0）。
      // A1.3：跨面渲染被删掉的整条不再计数，界面与她看到的文本一致。
      tensions: displayTensions.length,
      solid: displaySolid.length,
      // 他听完她的拒绝之后怎么反应（P1 第二块）：四类计数 + 有后果的那两种之和。
      // hurts 是第三块「疤」的唯一入口——被接受过的不算疤。
      reactions,
      hurts,
      // 疤（P1 第三块）：真被顶回来且她退了步的有几条，其中想通了几条。
      // 注意这不是"错误次数"——疤不评价对错，只表示那件事她至今没想清楚。
      scars: openScars.length,
      scarsResolved: scars.length - openScars.length,
      // 评论区里别人的话（2026-10-24）：读到几条、其中几条她后来自己也那么说。
      // 注意「读到」不等于「认同」——不从 voices 推任何判断，判断只来自她说出口的话。
      voices: voices.length,
      voicesEchoed,
      // 看过的条数（不是认同的条数）。只给观测台/自检看，不进身份文档的数字。
      saw: saw.length,
      // v3（A1.3）：B 站派生事实。biliSaid/biliReplies 不参与成长门；
      // sharedBeliefs 是跨面可见、已按 viewSurface 去引用化的判断。
      biliSaid,
      biliReplies,
      biliThreads,
      sharedBeliefs,
      // 本次渲染有多少条判断因为隐私规则整条没渲染（设计 §5.6 规则 5 的计数）。
      privacyRedacted,
    },
    absenceDays,
    narrative: displayNarrative,
    lastAbsence: lastAbsence ? { at: lastAbsence.ts } : null,
    lastSeenAt,
    lastWakeAt,
    spokenSinceSeen,
    heardSinceWake,
    lastReunion: lastReunion ? { at: lastReunion.ts, text: lastReunion.text } : null,
  }

  // ---- 阶段门：不跳级；时间兜底只在成长期结束后生效 ----
  // 契约 §3.5「上一阶段 gates 未满足则停在原阶段」优先于「30 天一定长大」：
  // 成长期内不过门就老实卡着（她没学会说不，就不该进"主动"阶段）；等 growthDays 走完，
  // 时间预算已花光，才允许她带着 forced 标记升上去。否则"卡住"这件事永远不会发生，
  // 阶段也就退化成了纯日历。
  const passed = []
  const forced = []
  let gateStage = 1
  for (let s = 1; s <= 3; s++) {
    const gate = GATE_ORDER[s - 1]
    if (gatePassed(gate, model)) {
      passed.push(gate)
      gateStage = s + 1
      continue
    }
    if (day > growthDays) {
      forced.push(gate)
      gateStage = s + 1
      continue
    }
    break
  }

  model.stageGate = {
    passed,
    pending: passed.length < GATE_ORDER.length ? GATE_ORDER[passed.length] : null,
    forced,
    gateStage,
  }
  model.elapsedStage = elapsedStage
  model.stage = Math.min(elapsedStage, gateStage)
  model.stageName = STAGE_NAMES[model.stage - 1]
  model.stageForced = forced.length > 0 && model.stage < elapsedStage

  return model
}

function gatePassed(gate, m) {
  const f = m.facts || {}
  switch (gate) {
    case 'trust': return m.beliefCount >= 1
    // 自主：真的拒绝执行过某件事，至少两次（2026-10-24 收紧）。
    // 只认 refusal 事件与「我 + 拒绝词 + 具体动作」，追问式的「要不要」不算；
    // 原来是 needs.autonomy >= 0.3，那是给关系套一个 0–1 的隐形分。
    case 'autonomy': return (f.refused ?? 0) >= 2
    // 主动：她至少两次推翻/修正自己先前的判断（revise 事件，或 corrected 标记）。
    case 'competence': return (f.revises || 0) + (f.corrected || 0) >= 2
    default: return true
  }
}

function triedAdd(set, v) {
  if (typeof v === 'string' && v) set.add(v)
}

/**
 * 「稳定」已搬到 `lib/quality.js`。
 *
 * 为什么搬：新口径要「重新渲染一遍她的自我描述再比相似度」，那要用到 persona.js；
 * 而 selfdoc.js 已经 import 了本文件，把 stability 留在 derive 里再 import persona，
 * 会绕出 quality → persona → derive → quality 的环。依赖方向只能是 quality → derive。
 *
 * 为什么换口径（2026-10-26，用户 m05868）：旧的量的是「抽掉判断后 needs 三项变多少」，
 * 而 needs 是内部计数器的映射（拒绝过几次 / 改口过几次 / 重聚过几次），刚重置的号里
 * 三项恒为 0，抽掉谁都是 0 —— 这个数就永远显示 0.00，一把永远为 0 的尺子等于没有尺子。
 */

/** 跨情境一致：同一信念在不同阶段下的表述相似度均值（0–1，越高越稳） */
export function consistency(events = []) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
  if (evs.length < 2) return { score: 1, pairs: 0 }
  let sum = 0, pairs = 0
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (evs[i].stage === evs[j].stage) continue
      sum += similarity(evs[i].text, evs[j].text)
      pairs++
    }
  }
  return { score: pairs ? sum / pairs : 1, pairs }
}

/** 可预测性下降：最近一周"新话"占比（与历史最大相似度 < 0.6 算新），应随成长上升 */
export function novelty(events = [], now = Date.now(), windowDays = 7) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
  const cut = now - windowDays * DAY_MS
  const recent = evs.filter((e) => Date.parse(e.ts) >= cut)
  const older = evs.filter((e) => Date.parse(e.ts) < cut)
  if (!recent.length || !older.length) return { score: 0, recent: recent.length, older: older.length }
  const fresh = recent.filter((e) => {
    const best = older.reduce((mx, o) => Math.max(mx, similarity(e.text, o.text)), 0)
    return best < 0.6
  })
  return { score: fresh.length / recent.length, recent: recent.length, older: older.length }
}
