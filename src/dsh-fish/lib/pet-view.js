/**
 * pet-view.js —— 桌宠的易失活动状态与单槽动作（desktop-pet thin shell）。
 *
 * 六档工作状态映射移植自 dsh-pet 的 src/host/work-status.ts：
 * https://github.com/PC2005-cloud/dsh-pet
 * dsh-pet 以 MIT License 发布；这里只保留状态归约规则，不含它的宿主、AI、
 * 人设或记忆代码。
 *
 * 本模块完全易失：不落盘、不写 events.jsonl / presence 台账、不调用模型，
 * 也不 import 其他 dsh-fish 模块。所有输入都应被当作外部数据，校验失败就
 * 明确返回失败，不抛到调用方。
 */

export const PET_MOTIONS = Object.freeze([
  'idle', 'turn', 'moving-left', 'moving-right', 'waving',
  'thinking', 'working', 'result', 'waiting', 'running',
  'review', 'failed', 'success', 'error',
])

export const PET_ACTION_MOTIONS = Object.freeze(PET_MOTIONS.filter((m) => m !== 'dragging'))

export const PET_TEXT_LIMIT = 120
export const PET_ACTION_TTL_MS = 15_000
export const PET_CUE_LIMIT = 8
export const PET_CUE_TTL_MS = 15_000

const PET_ACTION_TTL_MIN_MS = 1_000
const PET_ACTION_TTL_MAX_MS = 60_000
const PET_ACTION_CATALOG_LIMIT = 256
const PET_ACTION_ID_RE = /^[a-z0-9-]{1,32}$/

const PET_SURFACES = new Set(['web', 'screen'])
const PET_ACTION_MOTION_SET = new Set(PET_ACTION_MOTIONS)
const PET_CUE_KINDS = new Set(['speak', 'replied'])
const PET_REST_OVERRIDES = new Set(['auto', 'sleep', 'wake', 'awake'])
/** 用户显式「起来陪我」的最长时限；到期后交回日程，避免忘记收回。 */
export const PET_AWAKE_MAX_MS = 12 * 60 * 60 * 1000

/** dsh-pet 的优先级：数值越大越优先；同档由 pickActivity 取更大 seq。 */
const ACTIVITY_PRIORITY = Object.freeze({
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
})

/**
 * 每档活动的展示有效期。会话轮换/下线后条目不能永久留在 Map 里：
 * 终态（success/error）只亮一下；abandoned waiting 中等；还在干活的
 * thinking/working/result 给足时间（每次新事件都会刷新 `at`）。
 *
 * 过期只是不再展示并从 Map 剔除，不写事件、不落盘。
 */
export const ACTIVITY_TTL_MS = Object.freeze({
  success: 15_000,
  error: 15_000,
  waiting: 90_000,
  thinking: 10 * 60_000,
  working: 10 * 60_000,
  result: 10 * 60_000,
})

/** 桌宠只认她自己的 web / screen 面。 */
export function petSurfaceAllowed(surface) {
  return PET_SURFACES.has(surface)
}

/**
 * 把一个 session/event 压成六档活动状态。
 *
 * @returns {string|null|undefined} 六档字符串；null = 清空该会话；
 *   undefined = 这条事件不关心（meta、未知类型等）。
 */
export function reduceActivity(event) {
  const type = event?.type
  switch (type) {
    case 'turn/start':
      return 'thinking'
    case 'tool/call':
      return event?.data?.name === 'ask_user_question' ? 'waiting' : 'working'
    case 'tool/result':
      return 'result'
    case 'approval/asked':
      return 'waiting'
    case 'turn/end': {
      const kind = event?.data?.reason?.kind
      if (kind === 'completed') return 'success'
      if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
      if (kind === 'blocked') return 'waiting'
      // aborted 以及任何未知结束原因都不该继续展示旧活动。
      return null
    }
    default:
      return undefined
  }
}

/**
 * 从各会话的活动条目中挑出唯一要展示的那条。
 * 优先级 waiting > error > working > thinking > result > success；
 * 同档取 seq 更大（更近）的一条。不认识的 state 直接忽略。
 *
 * @param {Array<{state:string, at:number, seq:number, sessionId:string}>} entries
 * @returns {{state:string, at:number, seq:number, sessionId:string}|null}
 */
export function pickActivity(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  let best = null
  let bestRank = -1
  for (const entry of entries) {
    // hasOwn：别把 'constructor' / '__proto__' 这类原型键当成合法状态。
    const state = entry?.state
    if (!Object.hasOwn(ACTIVITY_PRIORITY, state)) continue
    const rank = ACTIVITY_PRIORITY[state]
    const seq = Number(entry?.seq) || 0
    if (!best || rank > bestRank || (rank === bestRank && seq > (Number(best.seq) || 0))) {
      best = entry
      bestRank = rank
    }
  }
  return best
}

/**
 * 创建一个纯内存的 pet view。
 *
 * @param {{now?: () => number, log?: (...args: any[]) => void}} [options]
 */
export function createPetView({ now = Date.now, log } = {}) {
  /** @type {Map<string, {state:string, at:number, seq:number, sessionId:string}>} */
  const sessions = new Map()
  let seq = 0
  let action = null
  let actionCounter = 0
  // 桌宠进程的心跳：全部易失。lastPollAt 只证明有人在轮询；
  // online 只看 hello（窗口真的起来了），免得轮询把掉线的窗口续命。
  let lastPollAt = null
  let helloAt = null
  let version = ''
  let skins = []
  let actionCatalog = new Map()
  let cues = []
  let scheduleRest = false
  let scheduleRestAt = null
  let outingActive = false
  let outingAt = null
  let restOverride = 'auto'
  let restOverrideAt = null
  // 仅 restOverride === 'awake' 时非空：到期时刻，跨过日程 tick 的兜底。
  let awakeUntil = null

  /**
   * 记录她的一条会话事件。只接受 web/screen 面。
   * @returns {boolean} 事件是否被接受（非她面、非六档事件返回 false）。
   */
  function noteSessionEvent({ sessionId, surface }, event) {
    if (!sessionId || !petSurfaceAllowed(surface)) return false
    const state = reduceActivity(event)
    if (state === undefined) return false
    seq += 1
    if (state === null) {
      sessions.delete(sessionId)
      return true
    }
    sessions.set(sessionId, { state, at: now(), seq, sessionId })
    return true
  }

  /**
   * 覆盖单槽动作。校验失败时旧动作保持不变。
   * @returns {{ok:true, action:{id:string, motion?:string, action?:string, text?:string, at:number, ttlMs:number}}|{ok:false, note:string}}
   */
  function act({ motion, action: actionId, text, ttlMs } = {}) {
    const hasMotion = motion !== undefined
    const hasAction = actionId !== undefined
    if (hasMotion === hasAction) {
      return { ok: false, note: 'motion 和 action 必须二选一。' }
    }
    if (hasMotion && !PET_ACTION_MOTION_SET.has(motion)) {
      return { ok: false, note: `不认识的桌宠动作：${motion ?? '（空）'}` }
    }
    if (hasAction && (typeof actionId !== 'string' || !actionCatalog.has(actionId))) {
      return { ok: false, note: `不认识的桌宠动作：${actionId ?? '（空）'}` }
    }

    let cleanText
    if (text !== undefined && text !== null) {
      cleanText = String(text).trim()
      if (!cleanText) cleanText = undefined
      else if (cleanText.length > PET_TEXT_LIMIT) {
        return { ok: false, note: `动作文本最多 ${PET_TEXT_LIMIT} 字。` }
      }
    }

    const n = Number(ttlMs)
    const ttl = ttlMs === undefined || ttlMs === null || !Number.isFinite(n)
      ? PET_ACTION_TTL_MS
      : Math.min(PET_ACTION_TTL_MAX_MS, Math.max(PET_ACTION_TTL_MIN_MS, n))

    const at = now()
    actionCounter += 1
    action = hasMotion
      ? { id: `pet-${at}-${actionCounter}`, motion, text: cleanText, at, ttlMs: ttl }
      : { id: `pet-${at}-${actionCounter}`, action: actionId, text: cleanText, at, ttlMs: ttl }
    return { ok: true, action: { ...action } }
  }

  /** 剔除已经超过自身 TTL 的 cue；过期 cue 不会在重连后补播。 */
  function pruneCues(nowMs) {
    cues = cues.filter((cue) => nowMs - cue.at < cue.ttlMs)
  }

  /**
   * 记录一条已经发生的事实 cue。id 只在当前环形缓冲内去重；文本是
   * 对外展示的摘要，统一裁到 PET_TEXT_LIMIT 字。
   */
  function noteCue({ id, kind, text, at, ttlMs } = {}) {
    if (typeof id !== 'string' || id.trim() === '') return false
    if (!PET_CUE_KINDS.has(kind)) return false
    if (typeof text !== 'string') return false
    const cleanText = text.trim().slice(0, PET_TEXT_LIMIT)
    if (!cleanText) return false

    const nowMs = now()
    pruneCues(nowMs)
    const cueId = id.trim()
    if (cues.some((cue) => cue.id === cueId)) return false

    const n = Number(ttlMs)
    const ttl = ttlMs === undefined || ttlMs === null || !Number.isFinite(n) || n <= 0
      ? PET_CUE_TTL_MS
      : n
    const nAt = Number(at)
    const cueAt = at === undefined || at === null || !Number.isFinite(nAt) ? nowMs : nAt
    cues.push({ id: cueId, kind, text: cleanText, at: cueAt, ttlMs: ttl })
    if (cues.length > PET_CUE_LIMIT) cues = cues.slice(-PET_CUE_LIMIT)
    return true
  }

  /** 更新日程窗口给出的默认休息状态。 */
  function setScheduleRest({ rest, at } = {}) {
    if (typeof rest !== 'boolean') return false
    const n = Number(at)
    scheduleRest = rest
    scheduleRestAt = at === undefined || at === null || !Number.isFinite(n) ? now() : n
    // 日程进入下一次 tick 后重新接管；长唤醒（awake）是唯一例外，
    // 它跨 tick 保持，直到用户收回或 12 小时兜底到期。
    if (restOverride !== 'awake') {
      restOverride = 'auto'
      restOverrideAt = null
    }
    return true
  }

  /** 更新 B 站出门场景；出门与休息互斥时始终由出门优先。 */
  function setOuting({ active, at } = {}) {
    if (typeof active !== 'boolean') return false
    const n = Number(at)
    outingActive = active
    outingAt = at === undefined || at === null || !Number.isFinite(n) ? now() : n
    return true
  }

  /** 用户手动覆盖休息；auto 清除覆盖并回到日程窗口。 */
  function setRestOverride(value) {
    if (!PET_REST_OVERRIDES.has(value)) return false
    restOverride = value
    restOverrideAt = value === 'auto' ? null : now()
    awakeUntil = value === 'awake' ? restOverrideAt + PET_AWAKE_MAX_MS : null
    return true
  }

  /** 桌宠窗口轮询一次；只刷新 lastPollAt。 */
  function markPolled(at = now()) {
    lastPollAt = Number(at)
  }

  /**
   * 桌宠窗口启动时报到。version 只收字符串，skins 只收数组；
   * 非法项直接丢弃，不抛错，也不影响 helloAt（窗口确实活着）。
   */
  function noteHello({ version: v, skins: s, actions } = {}, at = now()) {
    helloAt = Number(at)
    if (typeof v === 'string') version = v
    if (Array.isArray(s)) {
      skins = s
        .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string')
        .map((x) => ({ id: x.id, name: x.name }))
        .filter((x) => x.name.trim() !== '')
        .slice(0, 64)
    }

    // 目录永远跟随最近一次 hello：缺省或非法 actions 都清空旧目录。
    actionCatalog = new Map()
    if (Array.isArray(actions)) {
      const deduped = new Map()
      for (const item of actions) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        if (typeof item.id !== 'string' || !PET_ACTION_ID_RE.test(item.id)) continue
        if (typeof item.label !== 'string' || typeof item.group !== 'string') continue
        const label = item.label.trim()
        const group = item.group.trim()
        if (!label || !group) continue
        // Map.set 保证同一个 id 以最后一次上报的条目为准。
        deduped.set(item.id, { id: item.id, label, group })
      }
      const normalized = [...deduped.values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, PET_ACTION_CATALOG_LIMIT)
      actionCatalog = new Map(normalized.map((item) => [item.id, item]))
    }
  }

  /** 剔除超过所在档位有效期的会话条目；返回当前时间避免重复读时钟。 */
  function pruneExpired(nowMs) {
    for (const [sessionId, entry] of sessions) {
      // hasOwn：别把 'constructor' / '__proto__' 这类原型键当成合法档位。
      if (!Object.hasOwn(ACTIVITY_TTL_MS, entry.state)) continue
      if (nowMs - entry.at >= ACTIVITY_TTL_MS[entry.state]) sessions.delete(sessionId)
    }
  }

  /**
   * @returns {{activity:{state:string, at:number, sessionId:string}|null,
   *   action:{id:string, motion?:string, action?:string, text?:string, at:number, ttlMs:number}|null,
   *   scene:{kind:'rest'|'out', at:number}|null,
   *   awakeUntil:number|null,
   *   cues:Array<{id:string, kind:'speak'|'replied', text:string, at:number, ttlMs:number}>}}
   */
  function snapshot() {
    const nowMs = now()
    // 长唤醒到期：下一次快照自动交回日程，不依赖用户操作。
    if (restOverride === 'awake' && awakeUntil !== null && nowMs >= awakeUntil) {
      restOverride = 'auto'
      restOverrideAt = null
      awakeUntil = null
    }
    pruneExpired(nowMs)
    pruneCues(nowMs)
    const picked = pickActivity([...sessions.values()])
    const activity = picked
      ? { state: picked.state, at: picked.at, sessionId: picked.sessionId }
      : null

    let scene = null
    if (outingActive) {
      scene = { kind: 'out', at: outingAt }
    } else if (restOverride === 'sleep' || (restOverride === 'auto' && scheduleRest)) {
      scene = { kind: 'rest', at: restOverride === 'sleep' ? restOverrideAt : scheduleRestAt }
    }

    let currentAction = null
    if (action) {
      if (nowMs - action.at >= action.ttlMs) action = null
      else currentAction = { ...action }
    }
    return {
      activity,
      action: currentAction,
      lastPollAt,
      helloAt,
      version,
      skins: skins.map((x) => ({ ...x })),
      actions: [...actionCatalog.values()].map((x) => ({ ...x })),
      scene,
      awakeUntil: restOverride === 'awake' ? awakeUntil : null,
      cues: cues.map((cue) => ({ ...cue })),
    }
  }

  /** 清空易失状态；动作序号保持单调，避免同一进程内 id 复用。 */
  function clear() {
    sessions.clear()
    action = null
    lastPollAt = null
    helloAt = null
    version = ''
    skins = []
    actionCatalog.clear()
    cues = []
    scheduleRest = false
    scheduleRestAt = null
    outingActive = false
    outingAt = null
    restOverride = 'auto'
    restOverrideAt = null
    awakeUntil = null
  }

  return {
    noteSessionEvent, act, markPolled, noteHello, noteCue,
    setScheduleRest, setOuting, setRestOverride, snapshot, clear,
  }
}
