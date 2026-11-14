/**
 * 桌宠薄壳的动作控制器。
 *
 * 纯函数：不 import React / Electron，也不读时钟 —— `now` 由调用方传入，
 * 这样同一份逻辑既能被渲染进程使用，也能在 `node --test` 里直接跑。
 *
 * 两层动作模型（与设计文档 5.4 一致）：
 * - **稳态（steady）**：activity > presence 开启时的 thinking > idle。走 `<Pet motion>` 声明式，
 *   命令面的一次性动作播完后组件自动回落到它。
 * - **一次性（motion）**：显式 action、新评论。只走 `pet.motion({ loop: false })`，
 *   播完回落稳态，不常驻、不锁死。
 */

/** 与 dsh-pet-component 的 14 个动作同名；`dragging` 是手势态，不走控制器。 */
export type PetMotion =
  | 'idle'
  | 'turn'
  | 'moving-left'
  | 'moving-right'
  | 'waving'
  | 'thinking'
  | 'working'
  | 'result'
  | 'waiting'
  | 'running'
  | 'review'
  | 'failed'
  | 'success'
  | 'error'

export interface PetComment {
  at: string
  mode: string
  event: string
  text: string
}

export interface PetPresence {
  on: boolean
  mode: string | null
  busy: boolean
  snapshot: unknown
  recent: PetComment[]
}

export interface PetActivity {
  state: string
  at: number
  sessionId: string
}

export interface PetAction {
  id: string
  motion: string
  text: string | null
  at: number
  ttlMs: number
}

/** `GET /api/fish/pet/state` 的形状；所有字段都可能是 null。 */
export interface PetState {
  at: number
  presence: PetPresence | null
  activity: PetActivity | null
  action: PetAction | null
}

/**
 * 已播放过的东西；持久化在渲染进程的 localStorage 里，重启不重播。
 *
 * 刻意不存 `activity`：activity 是当前状态，不是「已播放」——重启后重新挂载的
 * 桌宠必须立刻按当前 activity 显示稳态动作（设计文档 6.3 只要求持久化这两项）。
 */
export interface Seen {
  lastActionId: string
  lastCommentAt: string
}

export interface PetBubbleEffect {
  id: string
  text: string
  motion?: PetMotion
}

export interface Effects {
  /** 一次性动作：交给命令面 `pet.motion({ type, loop: false })`。 */
  motion?: PetMotion
  /** 声明式稳态动作：每次轮询都给出，交给 `<Pet motion={steady}>`。 */
  steady: PetMotion
  bubble?: PetBubbleEffect
  seen: Seen
}

/** 菜单/手动表演的动作选项：一次性播放，播完回落声明式稳态。 */
export interface PerformedMotion {
  type: PetMotion
  loop: false
  replay: true
}

/** 气泡的稳定 key：同一条评论/动作原地更新，不叠一摞气泡。 */
export const BUBBLE_ID = 'bigfish'

const MOTIONS: ReadonlySet<string> = new Set([
  'idle',
  'turn',
  'moving-left',
  'moving-right',
  'waving',
  'thinking',
  'working',
  'result',
  'waiting',
  'running',
  'review',
  'failed',
  'success',
  'error',
])

export function emptySeen(): Seen {
  return { lastActionId: '', lastCommentAt: '' }
}

function asMotion(value: unknown): PetMotion | undefined {
  return typeof value === 'string' && MOTIONS.has(value) ? (value as PetMotion) : undefined
}

/**
 * 当前该常驻展示的动作：activity 优先；没有活动时，presence 开启 = thinking，
 * 关闭/未知 = idle（设计文档 5.4）。
 */
export function steadyMotion(state: PetState | null): PetMotion {
  const activity = asMotion(state?.activity?.state)
  if (activity) return activity
  return state?.presence?.on === true ? 'thinking' : 'idle'
}

/**
 * 右键菜单「演一个动作」的规范化：永远一次性（`loop: false`）并强制重播，
 * 播完由组件回落到 `<Pet motion>` 的稳态，不会把宠物锁在循环里。
 * 不认识的动作名返回 null。
 */
export function performedMotion(value: string): PerformedMotion | null {
  const type = asMotion(value)
  return type ? { type, loop: false, replay: true } : null
}

/** `recent` 里 `at` 最大的一条（ISO 字符串；无法解析的按最旧处理）。 */
function latestComment(recent: PetComment[] | undefined): PetComment | null {
  if (!Array.isArray(recent) || recent.length === 0) return null
  let best: PetComment | null = null
  let bestTime = Number.NEGATIVE_INFINITY
  for (const entry of recent) {
    if (!entry || typeof entry.at !== 'string') continue
    const parsed = Date.parse(entry.at)
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
    if (!best || time > bestTime) {
      best = entry
      bestTime = time
    }
  }
  return best
}

/**
 * 把一次轮询到的状态翻译成「要不要换动作 / 弹气泡」。
 *
 * @param prev 上一次返回的 `seen`
 * @param state BFF 状态；null/畸形时按空状态处理
 * @param now 外壳时钟（毫秒），用于判断显式动作是否过期
 */
export function decideEffects(prev: Seen, state: PetState | null, now: number): Effects {
  const seen: Seen = { ...prev }
  // 稳态每拍都给：声明式 prop 幂等，组件按内容指纹去重，不会重复起播。
  const effects: Effects = { seen, steady: steadyMotion(state) }

  const action = state?.action ?? null
  const actionAlive = action !== null && now - action.at < action.ttlMs

  if (action && actionAlive) {
    // 同一个 action.id 只播一次；新一轮显式动作覆盖上一轮。
    if (action.id !== prev.lastActionId) {
      const motion = asMotion(action.motion)
      if (motion) effects.motion = motion
      if (action.text) effects.bubble = { id: BUBBLE_ID, text: action.text, motion }
      seen.lastActionId = action.id
    }
    return effects
  }

  const comment = latestComment(state?.presence?.recent)
  if (comment && comment.at !== prev.lastCommentAt) {
    const motion: PetMotion = comment.event === 'settlement' ? 'success' : 'waving'
    effects.motion = motion
    effects.bubble = { id: BUBBLE_ID, text: comment.text, motion }
    seen.lastCommentAt = comment.at
  }

  seen.lastActionId = ''
  return effects
}
