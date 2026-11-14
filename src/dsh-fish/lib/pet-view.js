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

const PET_ACTION_TTL_MIN_MS = 1_000
const PET_ACTION_TTL_MAX_MS = 60_000

const PET_SURFACES = new Set(['web', 'screen'])
const PET_ACTION_MOTION_SET = new Set(PET_ACTION_MOTIONS)

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
   * @returns {{ok:true, action:{id:string, motion:string, text?:string, at:number, ttlMs:number}}|{ok:false, note:string}}
   */
  function act({ motion, text, ttlMs } = {}) {
    if (!PET_ACTION_MOTION_SET.has(motion)) {
      return { ok: false, note: `不认识的桌宠动作：${motion ?? '（空）'}` }
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
    action = { id: `pet-${at}-${actionCounter}`, motion, text: cleanText, at, ttlMs: ttl }
    return { ok: true, action: { ...action } }
  }

  /** 桌宠窗口轮询一次；只刷新 lastPollAt。 */
  function markPolled(at = now()) {
    lastPollAt = Number(at)
  }

  /**
   * 桌宠窗口启动时报到。version 只收字符串，skins 只收数组；
   * 非法项直接丢弃，不抛错，也不影响 helloAt（窗口确实活着）。
   */
  function noteHello({ version: v, skins: s } = {}, at = now()) {
    helloAt = Number(at)
    if (typeof v === 'string') version = v
    if (Array.isArray(s)) {
      skins = s
        .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string')
        .map((x) => ({ id: x.id, name: x.name }))
        .filter((x) => x.name.trim() !== '')
        .slice(0, 64)
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

  /** @returns {{activity:{state:string, at:number, sessionId:string}|null, action:{id:string, motion:string, text?:string, at:number, ttlMs:number}|null}} */
  function snapshot() {
    const nowMs = now()
    pruneExpired(nowMs)
    const picked = pickActivity([...sessions.values()])
    const activity = picked
      ? { state: picked.state, at: picked.at, sessionId: picked.sessionId }
      : null

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
  }

  return { noteSessionEvent, act, markPolled, noteHello, snapshot, clear }
}
