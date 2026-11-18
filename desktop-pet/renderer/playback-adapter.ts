import type { AnimationSlot, DshPetConfig } from 'dsh-pet-component'
import type {
  PlaybackAction,
  PlaybackAnimation,
  PlaybackEvent,
  PlaybackSlot,
  PlaybackState,
  PetMotion,
  PetState,
  Seen,
} from './controller'
import type { TriggerSeen } from './trigger-engine'

export const PET_SEEN_LIMIT = 64

/** localStorage 里同时保存一期去重游标和二期 trigger 游标。 */
export interface PetSeen extends TriggerSeen {
  lastActionId: string
  lastCommentAt: string
}

type BorrowAction = string | Pick<PlaybackAction, 'anim' | 'seq'>

interface SlotSnapshot {
  hadMotions: boolean
  hadSlot: boolean
  value: AnimationSlot | undefined
}

/** 借用 config 到原 mapping 的对应关系只活在这份克隆对象上，不污染 App 的 base config。 */
const snapshots = new WeakMap<DshPetConfig, Map<PlaybackSlot, SlotSnapshot>>()

function animationFor(action: BorrowAction): string {
  const name = typeof action === 'string' ? action : action.anim ?? action.seq?.[0]
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('借用动作缺少动画名')
  }
  return name
}

/**
 * 返回只改写一个借用槽 mapping 的 config 克隆。
 *
 * 其余字段和 `animations` 保持同引用；`motions` 单独复制，避免污染 base config。
 * 原槽值记在克隆对象的 WeakMap 快照里，`restoreActionConfig` 据此精确恢复。
 */
export function borrowActionConfig(
  config: DshPetConfig,
  action: BorrowAction,
  slot: PlaybackSlot,
): DshPetConfig {
  const motions = { ...(config.motions ?? {}) }
  const next: DshPetConfig = { ...config, motions }
  next.motions![slot] = animationFor(action)

  const nextSnapshots = new Map(snapshots.get(config) ?? [])
  nextSnapshots.set(slot, {
    hadMotions: Object.hasOwn(config, 'motions'),
    hadSlot: config.motions !== undefined && Object.hasOwn(config.motions, slot),
    value: config.motions?.[slot],
  })
  snapshots.set(next, nextSnapshots)
  return next
}

/** 恢复一次借用前的 mapping；没有借用快照时安全清掉该槽的临时映射。 */
export function restoreActionConfig(config: DshPetConfig, slot: PlaybackSlot): DshPetConfig {
  const next: DshPetConfig = { ...config }
  const snapshot = snapshots.get(config)?.get(slot)

  if (snapshot === undefined) {
    if (config.motions !== undefined) {
      const motions = { ...config.motions }
      delete motions[slot]
      next.motions = motions
    }
    return next
  }

  if (!snapshot.hadMotions) {
    delete next.motions
    return next
  }

  const motions = { ...(config.motions ?? {}) }
  if (snapshot.hadSlot) motions[slot] = snapshot.value
  else delete motions[slot]
  next.motions = motions
  return next
}

/** 循环被命令面借走后，声明式 prop 必须停在安全值，不能让 activity 更新清掉 loop override。 */
export function petMotionProp(
  playback: PlaybackState | null | undefined,
  latestSteady: PetMotion,
): PetMotion {
  return playback?.status === 'holding-loop' ? playback.frozenSteady : latestSteady
}

/** 播放中的注册表动作使用自己的素材基地址；稳态/恢复继续使用当前皮肤。 */
export function petUriProp(
  playback: PlaybackState | null | undefined,
  actions: readonly PlaybackAction[],
  activeUri: string,
): string {
  if (
    playback === null
    || playback === undefined
    || playback.status === 'idle'
    || playback.status === 'restoring'
    || playback.actionId === null
  ) {
    return activeUri
  }
  return actions.find((action) => action.id === playback.actionId)?.mediaUri ?? activeUri
}

/** clear-only 批次执行完 `pet.clear()` 后显式收尾，不依赖组件是否补发恢复回调。 */
export function restoreCompletedEvent(playback: PlaybackState | null | undefined): PlaybackEvent | null {
  if (playback?.status !== 'restoring') return null
  return { type: 'restoreCompleted', generation: playback.generation }
}

function boundedKeys(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const key = value.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique.slice(-PET_SEEN_LIMIT)
}

export function emptyPetSeen(): PetSeen {
  return {
    lastActionId: '',
    lastCommentAt: '',
    cueIds: [],
    occurrenceKeys: [],
    lastActivityState: null,
    lastSceneKind: null,
    sceneLoopActionId: null,
    sceneLoopActive: false,
    sceneLoopNeedsRevalidation: false,
    ambientConsumed: false,
  }
}

/** 旧版本只有一期字段；缺失/损坏的二游标按空值恢复，绝不无限增长。 */
export function parsePetSeen(raw: unknown): PetSeen {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPetSeen()
  const record = raw as Record<string, unknown>
  const sceneLoopActionId = typeof record.sceneLoopActionId === 'string' ? record.sceneLoopActionId : null
  return {
    lastActionId: typeof record.lastActionId === 'string' ? record.lastActionId : '',
    lastCommentAt: typeof record.lastCommentAt === 'string' ? record.lastCommentAt : '',
    cueIds: boundedKeys(record.cueIds),
    occurrenceKeys: boundedKeys(record.occurrenceKeys),
    lastActivityState: typeof record.lastActivityState === 'string' ? record.lastActivityState : null,
    lastSceneKind: record.lastSceneKind === 'rest' || record.lastSceneKind === 'out'
      ? record.lastSceneKind
      : null,
    sceneLoopActionId,
    // playback 进程内的 state 不落盘；冷启动只能把旧 loop 交给下一拍重新恢复。
    sceneLoopActive: false,
    sceneLoopNeedsRevalidation: sceneLoopActionId !== null,
    ambientConsumed: record.ambientConsumed === true,
  }
}

/** trigger reducer 只拥有自己的游标；合并时保留一期字段和 occurrence 键。 */
export function mergePetSeen(previous: PetSeen, next: TriggerSeen): PetSeen {
  return {
    ...previous,
    ...next,
    cueIds: boundedKeys(next.cueIds),
    occurrenceKeys: boundedKeys(next.occurrenceKeys ?? previous.occurrenceKeys),
  }
}

/** 皮肤切换会停掉当前播放；下一次状态拍允许用新目录恢复同一 scene loop，但不重放 enter trigger。 */
export function interruptSceneLoop<T extends TriggerSeen>(seen: T): T {
  return {
    ...seen,
    cueIds: boundedKeys(seen.cueIds),
    sceneLoopActive: false,
    sceneLoopNeedsRevalidation: true,
  } as T
}

export type ManualRestScene = 'rest' | 'out' | { kind: 'rest' | 'out'; at: number } | null

function manualRestSceneKind(scene: ManualRestScene): 'rest' | 'out' | null {
  if (typeof scene === 'string') return scene
  return scene?.kind ?? null
}

/** 循环睡觉动作属于当前 scene；其他休息动作仍是普通手动动作。 */
export function manualRestPlaybackSource(
  action: 'sleep' | 'wake',
  loops: boolean,
  scene: ManualRestScene,
): PlaybackSource {
  return action === 'sleep' && loops && manualRestSceneKind(scene) !== null
    ? 'scene'
    : 'manual'
}

/** 菜单 sleep/wake 已代表本次 scene transition，避免随后 scene trigger 再播一遍。 */
export function applyManualRestIntent<T extends TriggerSeen>(
  seen: T,
  action: 'sleep' | 'wake',
  actionId: string,
  scene: ManualRestScene,
  ownsSceneLoop = false,
): T {
  const sceneKind = manualRestSceneKind(scene)
  const sceneLoopOwned = ownsSceneLoop && action === 'sleep' && sceneKind !== null
  return {
    ...seen,
    cueIds: boundedKeys(seen.cueIds),
    // 服务端以 out > rest 决定 scene；手动意图只能消费它返回的事实，不能覆盖成 sleep。
    lastSceneKind: sceneKind,
    // 循环睡觉动作接管当前 scene：cue 可以暂时覆盖，播完后仍回到同一个 loop。
    // 非循环/起来动作不留下游标，避免动作结束后再补播同一 scene trigger。
    sceneLoopActionId: sceneLoopOwned ? actionId : null,
    sceneLoopActive: sceneLoopOwned,
    sceneLoopNeedsRevalidation: false,
  } as T
}

/** state 轮询可能早于手动 REST 发出、晚于回执到达；只接受不早于意图的 snapshot。 */
export function petStateSnapshotIsStale(state: PetState | null, intentAt: number): boolean {
  return state !== null
    && Number.isFinite(state.at)
    && Number.isFinite(intentAt)
    && state.at < intentAt
}

/** reducer 归约与真正下发之间状态可能换拍；cue 动作/气泡下发前再核一次当前 TTL。 */
export function cueDispatchIsFresh(state: PetState | null, cueId: string, now: number): boolean {
  const cue = state?.cues?.find((entry) => entry?.id === cueId)
  if (!cue) return false
  return Number.isFinite(cue.at)
    && Number.isFinite(cue.ttlMs)
    && cue.ttlMs > 0
    && now - cue.at < cue.ttlMs
}

/** 二期把 cue 作为唯一评论表现面；裁定整体忽略 legacy presence.recent，避免过期后补播。 */
export function withoutPresenceComments(state: PetState | null): PetState | null {
  if (!state?.presence || !Array.isArray(state.presence.recent) || state.presence.recent.length === 0) {
    return state
  }
  return {
    ...state,
    presence: { ...state.presence, recent: [] },
  }
}

export function isPetDragGesture(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold = 4,
): boolean {
  const dx = current.x - start.x
  const dy = current.y - start.y
  return dx * dx + dy * dy >= threshold * threshold
}

export function restClickBubble(): { id: string; title: '在休息' } {
  return { id: 'resting', title: '在休息' }
}

export function shouldOpenPetDialogue(state: PetState | null): boolean {
  return state?.scene?.kind !== 'rest'
}

export type PlaybackSource = 'manual' | 'trigger' | 'scene' | null

export interface TriggerBusyFlags {
  manualBusy: boolean
  actionBusy: boolean
}

export const MANUAL_MOTION_LEASE_MS = 15_000

/** 直接 `pet.motion()` 不经过 PlaybackState；用短 lease 把它也纳入手动优先级。 */
export interface ManualMotionLease {
  motion: PetMotion
  started: boolean
  expiresAt: number
}

export function startManualMotionLease(
  motion: PetMotion,
  now: number,
  durationMs = MANUAL_MOTION_LEASE_MS,
): ManualMotionLease {
  return {
    motion,
    started: false,
    expiresAt: now + Math.max(1, durationMs),
  }
}

/** 组件确认起动后再收到别的 motion（通常回 idle）即释放；兜底仍受 lease 到期限制。 */
export function noteManualMotionChange(
  lease: ManualMotionLease | null,
  motion: PetMotion | 'dragging',
  now: number,
): ManualMotionLease | null {
  if (lease === null || !Number.isFinite(now) || now >= lease.expiresAt) return null
  if (motion === lease.motion) return { ...lease, started: true }
  if (lease.started || motion === 'dragging') return null
  return lease
}

export function manualMotionLeaseBusy(lease: ManualMotionLease | null, now: number): boolean {
  return lease !== null && Number.isFinite(now) && now < lease.expiresAt
}

/** trigger 一次性动作与 scene/manual 分开计账；scene loop 不得被 actionBusy 永久压住。 */
export function triggerPlaybackBusy(
  playback: PlaybackState | null | undefined,
  source: PlaybackSource,
): TriggerBusyFlags {
  const busy = playback !== null && playback !== undefined && playback.status !== 'idle'
  if (!busy) return { manualBusy: false, actionBusy: false }
  if (source === 'scene') {
    // 皮肤切换后的 clear/restore 尚未收尾时先别抢回 loop；holding-loop 本身不算忙。
    return playback.status === 'restoring'
      ? { manualBusy: true, actionBusy: false }
      : { manualBusy: false, actionBusy: false }
  }
  if (source === 'trigger') return { manualBusy: false, actionBusy: true }
  return { manualBusy: true, actionBusy: false }
}

/** 一期 decideEffects 仍需自己的两个游标；从合并 Seen 中窄化出来。 */
export function legacySeen(seen: PetSeen): Seen {
  return { lastActionId: seen.lastActionId, lastCommentAt: seen.lastCommentAt }
}

/** 主进程写入 config 的动画名最终会被组件解码成这个目录式资源地址。 */
export function playbackAnimationSource(mediaUri: string, animation: string): string {
  const base = mediaUri.trim().replace(/[\\/]+$/, '')
  return `${base}/${encodeURIComponent(animation)}.webm`
}

export interface PlaybackCallbackArbiter {
  /** 新命令下发时登记目标；在组件回报资源就绪前不接受任何动作回调。 */
  expectTarget(generation: number, animation: string, mediaUri: string, once: boolean): void
  /** `loadeddata` 且前后台交换完成后才绑定 generation，并交出一条目标已出现的状态事件。 */
  ready(): PlaybackEvent | null
  disarm(): void
  motionChanged(motion: PetMotion | 'dragging'): PlaybackEvent | null
  animationChanged(animation: PlaybackAnimation | null): PlaybackEvent | null
}

/**
 * 组件的动作回调没有命令 id，只带当前动作/动画。onAnimationChange 可能先于 loadeddata，
 * 所以目标选择只算候选；直到 onReady 确认交换完成，旧视频晚到的结束回调都不能绑定新 generation。
 */
export function createPlaybackCallbackArbiter(): PlaybackCallbackArbiter {
  let expected: {
    generation: number
    animation: string
    source: string
    once: boolean
    selected: boolean
    ready: boolean
  } | null = null

  return {
    expectTarget(generation: number, animation: string, mediaUri: string, once: boolean): void {
      expected = {
        generation,
        animation,
        source: playbackAnimationSource(mediaUri, animation),
        once,
        selected: false,
        ready: false,
      }
    },
    ready(): PlaybackEvent | null {
      if (expected === null || !expected.selected || expected.ready) return null
      expected.ready = true
      return {
        type: 'animationChanged',
        generation: expected.generation,
        animation: {
          name: expected.animation,
          once: expected.once,
          src: expected.source,
        },
      }
    },
    disarm(): void {
      expected = null
    },
    motionChanged(motion: PetMotion | 'dragging'): PlaybackEvent | null {
      if (expected === null || !expected.ready) return null
      return { type: 'motionChanged', motion, generation: expected.generation }
    },
    animationChanged(animation: PlaybackAnimation | null): PlaybackEvent | null {
      if (expected === null) return null
      if (
        animation !== null
        && animation.name === expected.animation
        && animation.src === expected.source
      ) {
        expected.selected = true
      }
      if (!expected.ready) return null
      return { type: 'animationChanged', animation, generation: expected.generation }
    },
  }
}

export interface ActionErrorOwner {
  /** 首次报错的播放 generation；停止动作后 reducer 会把它推进到 restoreGeneration。 */
  generation: number
  restoreGeneration: number
  actionId: string
  /** 首次报错的动画源；只属于这个动作段，不能借给后来的动作或皮肤。 */
  source: string | null
}

/** 只有正在播放的注册表动作才能建立错误所有权；恢复段必须沿用原 owner。 */
export function createActionErrorOwner(
  playback: PlaybackState | null | undefined,
): ActionErrorOwner | null {
  if (
    playback === null
    || playback === undefined
    || playback.actionId === null
    || !(
      playback.status === 'playing-once'
      || playback.status === 'playing-seq'
      || playback.status === 'holding-loop'
    )
  ) return null
  return {
    generation: playback.generation,
    restoreGeneration: playback.generation + 1,
    actionId: playback.actionId,
    source: playback.expectedAnimation,
  }
}

export function retainsActionErrorOwnership(
  playback: PlaybackState | null | undefined,
  owner: ActionErrorOwner | null | undefined,
): boolean {
  if (!playback || !owner || playback.actionId !== owner.actionId) return false
  if (
    playback.status === 'playing-once'
    || playback.status === 'playing-seq'
    || playback.status === 'holding-loop'
  ) return playback.generation === owner.generation
  return playback.status === 'restoring' && playback.generation === owner.restoreGeneration
}

/**
 * 借用槽正在播放注册表动作时，运行期媒体错误属于动作；restoring 期间只保留同一
 * generation/source 的 owner，避免 A 的全局布尔把 B 或皮肤错误误判成动作错误。
 */
export function petErrorTarget(
  playback: PlaybackState | null | undefined,
  owner: ActionErrorOwner | null | undefined = null,
): 'action' | 'skin' {
  return retainsActionErrorOwnership(playback, owner)
    || playback?.status === 'playing-once'
    || playback?.status === 'playing-seq'
    || playback?.status === 'holding-loop'
    ? 'action'
    : 'skin'
}

/** 任何新动作或抢占都让「等待目录补上的旧服务端动作」失效。 */
export function pendingServerActionAfterPlaybackEvent(
  pending: string | null,
  event: PlaybackEvent,
): string | null {
  if (pending === null) return null
  return event.type === 'startAction'
    || event.type === 'stopAction'
    || event.type === 'dragStarted'
    || event.type === 'skinChanged'
    ? null
    : pending
}

export interface ChatReplyPlaybackDecision {
  current: boolean
  motion?: 'waving'
}

/** 旧对话请求直接忽略；当前请求若期间换过动作，只显示回复文字，不再抢占新循环。 */
export function chatReplyPlaybackDecision(input: {
  requestGeneration: number
  latestRequestGeneration: number
  playbackGeneration: number
  playback: PlaybackState | null | undefined
}): ChatReplyPlaybackDecision {
  if (input.requestGeneration !== input.latestRequestGeneration) return { current: false }
  const currentPlaybackGeneration = input.playback?.generation ?? 0
  return currentPlaybackGeneration === input.playbackGeneration
    ? { current: true, motion: 'waving' }
    : { current: true }
}

export interface ChatThinkingPlan {
  bubbleMotion?: 'thinking'
  preemptMotion?: 'thinking'
}

/** 借用播放占用命令面时先显式抢占；否则保留聊天气泡原有的 thinking 行为。 */
export function chatThinkingPlan(playback: PlaybackState | null | undefined): ChatThinkingPlan {
  return playback !== null && playback !== undefined && playback.status !== 'idle'
    ? { preemptMotion: 'thinking' }
    : { bubbleMotion: 'thinking' }
}
