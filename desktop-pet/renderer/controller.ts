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

/** 手动动作在播放器里的五个状态；只能有一个借用槽。 */
export type PlaybackStatus = 'idle' | 'playing-once' | 'playing-seq' | 'holding-loop' | 'restoring'
export type PlaybackSlot = 'waving'

/** 固定借用 `waving`，不额外扩展组件的 14 个动作名。 */
export const PLAYBACK_SLOT: PlaybackSlot = 'waving'

/** 与 Task 2 的 ActionDefinition 结构兼容；避免 renderer 依赖 electron/node:path。 */
export interface PlaybackAction {
  id: string
  label: string
  anim?: string
  seq?: string[]
  loop: boolean
  group: string
}

export interface PlaybackState {
  status: PlaybackStatus
  /** 同一动作的完成回调共享 generation；新动作/显式停止会递增它。 */
  generation: number
  /** 动作播放期间收到的最新声明式稳态，恢复时使用它而不是启动时快照。 */
  steady: PetMotion
  /** 进入循环时冻结给 `<Pet motion>` 的安全值；循环期回调仍可更新 steady。 */
  frozenSteady: PetMotion
  actionId: string | null
  animations: string[]
  index: number
  loop: boolean
  expectedAnimation: string | null
  targetSeen: boolean
  startedAt: number
}

export interface PlaybackAnimation {
  name: string
  once: boolean
  src?: string | null
  row?: number
  column?: number
}

export type PlaybackEvent =
  | { type: 'startAction'; action?: string | PlaybackAction; actionId?: string }
  | { type: 'stopAction' }
  | { type: 'motionChanged'; motion: PetMotion | 'dragging'; generation: number }
  | { type: 'animationChanged'; animation: PlaybackAnimation | null; generation: number }
  | { type: 'steadyChanged'; steady?: PetMotion }
  | { type: 'dragStarted' }
  | { type: 'skinChanged' }

export interface PlaybackContext {
  actions: readonly PlaybackAction[]
  steady: PetMotion
  now: number
}

export interface BindSlotEffect {
  type: 'bind-slot'
  slot: PlaybackSlot
  animation: string
}

export interface PlayMotionEffect {
  type: 'play-motion'
  motion: PlaybackSlot
  loop: boolean
  replay: true
}

export interface ClearMotionEffect {
  type: 'clear-motion'
}

export interface RestoreSlotEffect {
  type: 'restore-slot'
  slot: PlaybackSlot
  steady: PetMotion
}

export type PlaybackEffect = BindSlotEffect | PlayMotionEffect | ClearMotionEffect | RestoreSlotEffect

export interface PlaybackResult {
  state: PlaybackState
  effects: PlaybackEffect[]
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

/** 新播放器的初始值；`null` 也可以直接交给 `reducePlayback`。 */
export function initialPlaybackState(steady: PetMotion = 'idle', now = 0): PlaybackState {
  return {
    status: 'idle',
    generation: 0,
    steady,
    frozenSteady: steady,
    actionId: null,
    animations: [],
    index: 0,
    loop: false,
    expectedAnimation: null,
    targetSeen: false,
    startedAt: now,
  }
}

function playbackActionAnimations(action: PlaybackAction): string[] {
  const values = action.anim !== undefined ? [action.anim] : action.seq
  if (!Array.isArray(values) || values.length === 0) return []
  const names: string[] = []
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (name === '') return []
    names.push(name)
  }
  return names
}

function resolvePlaybackAction(
  event: Extract<PlaybackEvent, { type: 'startAction' }>,
  actions: readonly PlaybackAction[],
): PlaybackAction | null {
  const requested = event.actionId ?? (typeof event.action === 'string' ? event.action : undefined)
  if (requested !== undefined) return actions.find((action) => action.id === requested) ?? null

  if (typeof event.action !== 'object' || event.action === null) return null
  const action = event.action
  if (playbackActionAnimations(action).length === 0) return null
  return {
    id: action.id,
    label: action.label,
    ...(action.anim === undefined ? {} : { anim: action.anim }),
    ...(action.seq === undefined ? {} : { seq: [...action.seq] }),
    loop: action.loop === true,
    group: action.group,
  }
}

function beginRestore(state: PlaybackState, steady: PetMotion, now: number): PlaybackResult {
  return {
    state: {
      ...state,
      status: 'restoring',
      steady,
      expectedAnimation: null,
      targetSeen: false,
      startedAt: now,
    },
    effects: [
      { type: 'clear-motion' },
      { type: 'restore-slot', slot: PLAYBACK_SLOT, steady },
    ],
  }
}

function stopPlayback(state: PlaybackState, steady: PetMotion, now: number): PlaybackResult {
  if (state.status === 'idle' || state.status === 'restoring') {
    return { state, effects: [] }
  }
  return beginRestore(
    { ...state, generation: state.generation + 1 },
    steady,
    now,
  )
}

function advancePlayback(state: PlaybackState, steady: PetMotion, now: number): PlaybackResult {
  const nextIndex = state.index + 1
  if (nextIndex >= state.animations.length) return beginRestore(state, steady, now)

  const animation = state.animations[nextIndex]
  const holdsLoop = state.loop && nextIndex === state.animations.length - 1
  return {
    state: {
      ...state,
      status: holdsLoop ? 'holding-loop' : 'playing-seq',
      steady,
      frozenSteady: steady,
      index: nextIndex,
      expectedAnimation: animation,
      targetSeen: false,
      startedAt: now,
    },
    effects: [
      { type: 'bind-slot', slot: PLAYBACK_SLOT, animation },
      { type: 'play-motion', motion: PLAYBACK_SLOT, loop: holdsLoop, replay: true },
    ],
  }
}

/**
 * 纯播放状态机。调用方负责执行 effects：只改 `config.motions.waving`、
 * 调用 `pet.motion({ type: 'waving', loop, replay: true })`，结束后 `pet.clear()`。
 */
export function reducePlayback(
  state: PlaybackState | null | undefined,
  event: PlaybackEvent,
  context: PlaybackContext,
): PlaybackResult {
  const steady = asMotion(event.type === 'steadyChanged' ? event.steady : undefined)
    ?? asMotion(context.steady)
    ?? state?.steady
    ?? 'idle'
  const current = state === null || state === undefined
    ? initialPlaybackState(steady, context.now)
    : { ...state, steady }

  if (event.type === 'steadyChanged') {
    return { state: current, effects: [] }
  }

  if (event.type === 'startAction') {
    const action = resolvePlaybackAction(event, context.actions)
    if (action === null) return { state: current, effects: [] }
    const animations = playbackActionAnimations(action)
    if (animations.length === 0) return { state: current, effects: [] }

    const generation = current.generation + 1
    const holdsLoop = action.loop === true && animations.length === 1
    const status: PlaybackStatus = holdsLoop
      ? 'holding-loop'
      : animations.length > 1
        ? 'playing-seq'
        : 'playing-once'
    const effects: PlaybackEffect[] = []
    if (current.status !== 'idle') effects.push({ type: 'clear-motion' })
    effects.push(
      { type: 'bind-slot', slot: PLAYBACK_SLOT, animation: animations[0] },
      { type: 'play-motion', motion: PLAYBACK_SLOT, loop: holdsLoop, replay: true },
    )
    return {
      state: {
        status,
        generation,
        steady,
        frozenSteady: steady,
        actionId: action.id,
        animations,
        index: 0,
        loop: action.loop === true,
        expectedAnimation: animations[0],
        targetSeen: false,
        startedAt: context.now,
      },
      effects,
    }
  }

  if (event.type === 'stopAction' || event.type === 'dragStarted' || event.type === 'skinChanged') {
    return stopPlayback(current, steady, context.now)
  }

  if (event.type === 'motionChanged') {
    if (event.generation !== current.generation) {
      return { state: current, effects: [] }
    }
    if (current.status === 'restoring') {
      return {
        state: event.motion === PLAYBACK_SLOT
          ? current
          : { ...current, status: 'idle', startedAt: context.now },
        effects: [],
      }
    }
    if (
      (current.status === 'playing-once' || current.status === 'playing-seq')
      && current.targetSeen
      && event.motion !== PLAYBACK_SLOT
    ) {
      return advancePlayback(current, steady, context.now)
    }
    return { state: current, effects: [] }
  }

  if (event.type === 'animationChanged') {
    if (event.generation !== current.generation) {
      return { state: current, effects: [] }
    }
    if (current.status === 'restoring') {
      return {
        state: { ...current, status: 'idle', startedAt: context.now },
        effects: [],
      }
    }
    if (current.status !== 'playing-once' && current.status !== 'playing-seq') {
      return { state: current, effects: [] }
    }

    const animation = event.animation
    if (
      animation !== null
      && animation.name === current.expectedAnimation
      && animation.once === true
    ) {
      return {
        state: current.targetSeen ? current : { ...current, targetSeen: true },
        effects: [],
      }
    }
    if (current.targetSeen && (animation === null || animation.name !== current.expectedAnimation)) {
      return advancePlayback(current, steady, context.now)
    }
  }

  return { state: current, effects: [] }
}
