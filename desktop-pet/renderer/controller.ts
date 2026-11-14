/**
 * 桌宠薄壳的动作控制器。
 *
 * 纯函数：不 import React / Electron，也不读时钟 —— `now` 由调用方传入，
 * 这样同一份逻辑既能被渲染进程使用，也能在 `node --test` 里直接跑。
 *
 * 优先级（与设计文档 5.4 一致）：
 * 显式 action（TTL 内）> 新评论气泡 > activity > idle。
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

/** 已播放过的东西；持久化在渲染进程的 localStorage 里，重启不重播。 */
export interface Seen {
  lastActionId: string
  lastCommentAt: string
  activity: string | null
}

export interface PetBubbleEffect {
  id: string
  text: string
  motion?: PetMotion
}

export interface Effects {
  motion?: PetMotion
  bubble?: PetBubbleEffect
  seen: Seen
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
  return { lastActionId: '', lastCommentAt: '', activity: null }
}

function asMotion(value: unknown): PetMotion | undefined {
  return typeof value === 'string' && MOTIONS.has(value) ? (value as PetMotion) : undefined
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
  const effects: Effects = { seen }

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
    // 动作播放期间也记录 activity，动作过期后据此回落。
    seen.activity = state?.activity?.state ?? null
    return effects
  }

  const comment = latestComment(state?.presence?.recent)
  const activityState = state?.activity?.state ?? null
  const activityMotion = asMotion(activityState)
  const hadAction = prev.lastActionId !== ''

  if (comment && comment.at !== prev.lastCommentAt) {
    const motion: PetMotion = comment.event === 'settlement' ? 'success' : 'waving'
    effects.motion = motion
    effects.bubble = { id: BUBBLE_ID, text: comment.text, motion }
    seen.lastCommentAt = comment.at
  } else if (hadAction || activityState !== prev.activity) {
    // 动作过期/消失后即使 activity 没变也要把动作切回来。
    effects.motion = activityMotion ?? 'idle'
  }

  seen.lastActionId = ''
  seen.activity = activityState
  return effects
}
