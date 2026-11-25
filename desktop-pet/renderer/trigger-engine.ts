/**
 * 桌宠事件触发器归约器。
 *
 * 纯函数：不读时钟、不访问 Electron/React；动作选择随机源由调用方注入，
 * 同一状态序列可以稳定重放。`seen` 是触发器自己的游标，不与手动动作目录混用。
 */

import {
  pickTriggerAction,
  type TriggerDefinition,
} from '../shared/trigger-model.ts'
import type { AmbientModePolicy } from '../shared/ambient-model.ts'
import {
  isPetMotion,
  type PetState,
  type PetMotion,
  type PlaybackAction,
} from './controller.ts'

export type { TriggerDefinition } from '../shared/trigger-model.ts'

export const TRIGGER_SEEN_LIMIT = 64

export interface TriggerQuietHours {
  /** 本地时间起点，含；从零点起算的分钟数。 */
  startMinute: number
  /** 本地时间终点，不含；可小于起点表示跨午夜。 */
  endMinute: number
  /** 安静时段结束后再额外固定等待的秒数；缺省 0。 */
  afterJitterSec?: number
}

export interface TriggerEngineConfig {
  quietHours?: TriggerQuietHours | null
  /**
   * 按 presence.mode 选出的氛围策略；缺省/null 时回落到旧 `ambient` trigger。
   * 存在策略时由下面的调度字段驱动，旧 trigger 分支不再参与。
   */
  ambient?: AmbientModePolicy | null
}

export interface TriggerSeen {
  /** 已消费的 cue id；有界，避免 localStorage 无限增长。 */
  cueIds: string[]
  /** date/ambient 的稳定 occurrence 与最近触发时间；有界持久化。 */
  occurrenceKeys: string[]
  lastActivityState: string | null
  lastSceneKind: 'rest' | 'out' | null
  sceneLoopActionId: string | null
  sceneLoopActive: boolean
  /** 旧 playback 已丢失/被打断；恢复前必须按当前 trigger 目录重新选择。 */
  sceneLoopNeedsRevalidation: boolean
  /** 旧 `ambient` trigger 的一次性游标；策略存在时不参与。 */
  ambientConsumed: boolean
  /** 当前策略 mode；变化时整套调度重置。 */
  ambientMode: string | null
  /** 下一次允许播放的本地时间戳；null 表示本段已结束/被压住。 */
  ambientNextAt: number | null
  ambientIdleSince: number | null
  ambientIdleCount: number
  /** 每日计数所属的本地日期（YYYY-MM-DD）。 */
  ambientDayKey: string
  ambientCountToday: number
  ambientLastAt: number | null
  /** `"<action>|<timestamp>"`；有界，按最后一次播放裁剪。 */
  ambientActionKeys: string[]
}

export interface TriggerBubbleEffect {
  id: string
  text: string
}

export type TriggerActionEffect =
  | { type: 'startAction'; actionId: string; loop: boolean }
  | { type: 'stopAction' }

export interface TriggerEffects {
  action?: TriggerActionEffect
  bubble?: TriggerBubbleEffect
  steady: PetMotion
  seen: TriggerSeen
}

export interface ReduceTriggersInput {
  state: PetState | null
  triggers: readonly TriggerDefinition[]
  actions: readonly PlaybackAction[]
  seen: TriggerSeen
  now: number
  /** 用户手动动作正在播放时为 true；它压住所有自动触发。 */
  manualBusy: boolean
  /** 自动触发的一次性动作尚未完成；true 时不恢复 loop、不消费后续事件。 */
  actionBusy?: boolean
  /** 安静时段等运行配置由调用方注入，reducer 不读取全局设置。 */
  config?: TriggerEngineConfig
  rng?: () => number
}

export function emptyTriggerSeen(): TriggerSeen {
  return {
    cueIds: [],
    occurrenceKeys: [],
    lastActivityState: null,
    lastSceneKind: null,
    sceneLoopActionId: null,
    sceneLoopActive: false,
    sceneLoopNeedsRevalidation: false,
    ambientConsumed: false,
    ambientMode: null,
    ambientNextAt: null,
    ambientIdleSince: null,
    ambientIdleCount: 0,
    ambientDayKey: '',
    ambientCountToday: 0,
    ambientLastAt: null,
    ambientActionKeys: [],
  }
}

function boundedSeen(values: readonly string[]): string[] {
  const unique: string[] = []
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || ids.has(value)) continue
    ids.add(value)
    unique.push(value)
  }
  return unique.slice(-TRIGGER_SEEN_LIMIT)
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

function cloneSeen(seen: TriggerSeen): TriggerSeen {
  return {
    cueIds: boundedSeen(seen?.cueIds ?? []),
    occurrenceKeys: boundedSeen(seen?.occurrenceKeys ?? []),
    lastActivityState: typeof seen?.lastActivityState === 'string' ? seen.lastActivityState : null,
    lastSceneKind: seen?.lastSceneKind === 'rest' || seen?.lastSceneKind === 'out'
      ? seen.lastSceneKind
      : null,
    sceneLoopActionId: typeof seen?.sceneLoopActionId === 'string' ? seen.sceneLoopActionId : null,
    sceneLoopActive: seen?.sceneLoopActive === true,
    sceneLoopNeedsRevalidation: seen?.sceneLoopNeedsRevalidation === true,
    ambientConsumed: seen?.ambientConsumed === true,
    ambientMode: typeof seen?.ambientMode === 'string' ? seen.ambientMode : null,
    ambientNextAt: finiteOrNull(seen?.ambientNextAt),
    ambientIdleSince: finiteOrNull(seen?.ambientIdleSince),
    ambientIdleCount: countOf(seen?.ambientIdleCount),
    ambientDayKey: typeof seen?.ambientDayKey === 'string' ? seen.ambientDayKey : '',
    ambientCountToday: countOf(seen?.ambientCountToday),
    ambientLastAt: finiteOrNull(seen?.ambientLastAt),
    ambientActionKeys: boundedSeen(seen?.ambientActionKeys ?? []),
  }
}

function rememberCue(seen: TriggerSeen, id: string): void {
  if (seen.cueIds.includes(id)) return
  seen.cueIds = boundedSeen([...seen.cueIds, id])
}

function localDay(now: number): { monthDay: string; dayKey: string; minute: number } {
  const date = new Date(now)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return {
    monthDay: `${month}-${day}`,
    dayKey: `${year}-${month}-${day}`,
    minute: date.getHours() * 60 + date.getMinutes(),
  }
}

function validQuietHours(config: TriggerEngineConfig | undefined): TriggerQuietHours | null {
  const quiet = config?.quietHours
  if (!quiet) return null
  const start = quiet.startMinute
  const end = quiet.endMinute
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || start > 1440 || end < 0 || end > 1440 || start === end) return null
  return quiet
}

function minuteInQuietHours(quiet: TriggerQuietHours, minute: number): boolean {
  const start = quiet.startMinute
  const end = quiet.endMinute
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end
}

function inQuietHours(config: TriggerEngineConfig | undefined, minute: number): boolean {
  const quiet = validQuietHours(config)
  return quiet !== null && minuteInQuietHours(quiet, minute)
}

/** 当前安静时段结束的本地时间；跨午夜时落到次日。 */
function quietEndAt(quiet: TriggerQuietHours, now: number): number {
  const date = new Date(now)
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(quiet.endMinute / 60),
    quiet.endMinute % 60,
    0,
    0,
  )
  if (end.getTime() <= now) end.setDate(end.getDate() + 1)
  return end.getTime()
}

function fireMarker(when: string, now: number): string {
  return `fire|${when}|${Math.max(0, Math.trunc(now))}`
}

function dateMarker(when: string, dayKey: string): string {
  return `date|${when}|${dayKey}`
}

function replaceMarker(seen: TriggerSeen, prefix: string, marker: string): void {
  seen.occurrenceKeys = boundedSeen([
    ...seen.occurrenceKeys.filter((key) => !key.startsWith(prefix)),
    marker,
  ])
}

function rememberFire(seen: TriggerSeen, when: string, now: number): void {
  replaceMarker(seen, `fire|${when}|`, fireMarker(when, now))
}

function rememberDate(seen: TriggerSeen, when: string, dayKey: string): void {
  replaceMarker(seen, `date|${when}|`, dateMarker(when, dayKey))
}

function hasDate(seen: TriggerSeen, when: string, dayKey: string): boolean {
  return seen.occurrenceKeys.includes(dateMarker(when, dayKey))
}

function lastFiredAt(seen: TriggerSeen, when: string, now: number): number | null {
  const prefix = `fire|${when}|`
  let latest: number | null = null
  for (const key of seen.occurrenceKeys) {
    if (!key.startsWith(prefix)) continue
    const timestamp = Number(key.slice(prefix.length))
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) continue
    if (latest === null || timestamp > latest) latest = timestamp
  }
  return latest
}

function triggerCooldownElapsed(trigger: TriggerDefinition, seen: TriggerSeen, now: number): boolean {
  const gapSec = Number(trigger.minGapSec)
  if (!Number.isFinite(gapSec) || gapSec <= 0) return true
  const last = lastFiredAt(seen, trigger.when, now)
  return last === null || now - last >= gapSec * 1000
}

interface SelectedAction {
  trigger: TriggerDefinition
  action: PlaybackAction
}

function selectAction(
  when: string,
  triggers: readonly TriggerDefinition[],
  actions: readonly PlaybackAction[],
  rng: () => number,
): SelectedAction | null {
  const trigger = triggers.find((entry) => entry?.when === when)
  if (!trigger) return null
  const actionId = pickTriggerAction(trigger, rng)
  if (actionId === null) return null
  const action = actions.find((entry) => entry?.id === actionId)
  return action ? { trigger, action } : null
}

function actionForTrigger(
  trigger: TriggerDefinition,
  actions: readonly PlaybackAction[],
  rng: () => number,
): PlaybackAction | null {
  const actionId = pickTriggerAction(trigger, rng)
  if (actionId === null) return null
  return actions.find((entry) => entry?.id === actionId) ?? null
}

function takeAction(
  selected: SelectedAction | null,
  seen: TriggerSeen,
  now: number,
): PlaybackAction | null {
  if (selected === null || !triggerCooldownElapsed(selected.trigger, seen, now)) return null
  rememberFire(seen, selected.trigger.when, now)
  return selected.action
}

function cueWhen(kind: unknown): 'speak' | 'bili_replied' | null {
  if (kind === 'speak') return 'speak'
  if (kind === 'replied') return 'bili_replied'
  return null
}

function steadyMotion(state: PetState | null): PetMotion {
  const activity = state?.activity?.state
  if (activity === 'waiting') return 'waiting'
  if (state?.scene) return 'idle'
  if (isPetMotion(activity)) return activity
  return state?.presence?.on === true ? 'thinking' : 'idle'
}

function isAmbientState(state: PetState | null): boolean {
  if (state === null) return true
  return state.scene === null
    && state.activity === null
    && state.presence?.on !== true
}

/** 策略路径的空闲判定：presence 用 enabled 表达，不要求 presence.on === false。 */
function ambientPolicyEligible(state: PetState | null, policy: AmbientModePolicy): boolean {
  if (policy.enabled !== true) return false
  // event 模式只消费事实事件；即使配置误写 enabled:true 也不播氛围动作。
  if (policy.mode === 'event') return false
  if (state === null) return true
  return state.scene === null && state.activity === null
}

function endAmbientIdle(seen: TriggerSeen): void {
  seen.ambientNextAt = null
  seen.ambientIdleSince = null
  seen.ambientIdleCount = 0
}

function ambientSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value < 0 ? 0 : value
}

function ambientCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/** 权重：非法/负数按 1；0 表示永不选中。 */
function ambientWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 1
  return value
}

function clampRoll(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  return value > 1 ? 1 : value
}

/** 进入空闲/每次播放后抽下一次间隔；intervalMinSec === intervalMaxSec 时是固定值。 */
function drawAmbientIntervalMs(policy: AmbientModePolicy, rng: () => number): number {
  const frequency = policy.frequency
  const min = ambientSeconds(frequency?.intervalMinSec)
  const max = Math.max(min, ambientSeconds(frequency?.intervalMaxSec))
  return Math.round((min + clampRoll(rng()) * (max - min)) * 1000)
}

function lastAmbientActionAt(seen: TriggerSeen, actionId: string, now: number): number | null {
  const prefix = `${actionId}|`
  let latest: number | null = null
  for (const key of seen.ambientActionKeys) {
    if (!key.startsWith(prefix)) continue
    const timestamp = Number(key.slice(prefix.length))
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) continue
    if (latest === null || timestamp > latest) latest = timestamp
  }
  return latest
}

/**
 * 策略路径的一拍调度。
 *
 * 只在 `ambientPolicyEligible` 为真时调用；`seen` 原位更新。
 * 返回要播放的一次性动作，或 null。所有随机性都走注入的 rng。
 */
function ambientPolicyAction(
  policy: AmbientModePolicy,
  seen: TriggerSeen,
  now: number,
  actions: readonly PlaybackAction[],
  rng: () => number,
  quiet: TriggerQuietHours | null,
  minute: number,
): PlaybackAction | null {
  const frequency = policy.frequency

  if (seen.ambientIdleSince === null) {
    seen.ambientIdleSince = now
    seen.ambientIdleCount = 0
    const settleMs = ambientSeconds(frequency?.settleSec) * 1000
    seen.ambientNextAt = now + Math.max(settleMs, drawAmbientIntervalMs(policy, rng))
  }

  // 安静时段优先于 nextAt：每次空闲拍都把下一次推到结束后，并叠加固定等待。
  if (quiet !== null && minuteInQuietHours(quiet, minute)) {
    const target = quietEndAt(quiet, now) + ambientSeconds(quiet.afterJitterSec) * 1000
    seen.ambientNextAt = Math.max(seen.ambientNextAt ?? target, target)
    return null
  }

  if (seen.ambientNextAt === null || now < seen.ambientNextAt) return null

  const maxPerIdle = ambientCount(frequency?.maxPerIdle)
  if (maxPerIdle > 0 && seen.ambientIdleCount >= maxPerIdle) {
    seen.ambientNextAt = null
    return null
  }
  const maxPerDay = ambientCount(frequency?.maxPerDay)
  if (maxPerDay > 0 && seen.ambientCountToday >= maxPerDay) {
    seen.ambientNextAt = null
    return null
  }

  const minGapMs = ambientSeconds(frequency?.minGapSec) * 1000
  if (seen.ambientLastAt !== null && minGapMs > 0) {
    const earliest = seen.ambientLastAt + minGapMs
    if (now < earliest) {
      seen.ambientNextAt = earliest
      return null
    }
  }

  const idleMs = Math.max(0, now - (seen.ambientIdleSince ?? now))
  const actionIds = new Set(actions.map((entry) => entry.id))
  const items = Array.isArray(policy.items) ? policy.items : []
  const eligible = items.filter((item) => {
    if (item === null || item.enabled === false) return false
    if (ambientWeight(item.weight) <= 0) return false
    if (!actionIds.has(item.action)) return false
    if (idleMs < ambientSeconds(item.minIdleSec) * 1000) return false

    const explicitCooldown = item.cooldownSec
    const cooldownSec = typeof explicitCooldown === 'number' && Number.isFinite(explicitCooldown)
      ? Math.max(0, explicitCooldown)
      : ambientSeconds(frequency?.actionCooldownSec)
    if (cooldownSec <= 0) return true
    const last = lastAmbientActionAt(seen, item.action, now)
    return last === null || now - last >= cooldownSec * 1000
  })

  if (eligible.length === 0) {
    seen.ambientNextAt = now + 60_000
    return null
  }

  const weights = eligible.map((item) => ambientWeight(item.weight))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) {
    seen.ambientNextAt = now + 60_000
    return null
  }

  let roll = clampRoll(rng()) * total
  let index = weights.length - 1
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]
    if (roll < 0) {
      index = i
      break
    }
  }
  const chosen = eligible[index]
  const action = actions.find((entry) => entry.id === chosen.action)
  if (action === undefined) {
    seen.ambientNextAt = now + 60_000
    return null
  }

  seen.ambientIdleCount += 1
  seen.ambientCountToday += 1
  seen.ambientLastAt = now
  seen.ambientActionKeys = boundedSeen([
    ...seen.ambientActionKeys,
    `${chosen.action}|${Math.max(0, Math.trunc(now))}`,
  ])
  seen.ambientNextAt = now + drawAmbientIntervalMs(policy, rng)
  return action
}

/** 归约一拍：高优先级事件先消费，低优先级状态留到后续拍继续处理。 */
export function reduceTriggers(input: ReduceTriggersInput): TriggerEffects {
  const seen = cloneSeen(input.seen)
  const steady = steadyMotion(input.state)
  const rng = input.rng ?? Math.random
  const now = Number.isFinite(input.now) ? input.now : 0
  const local = localDay(now)
  const policy = input.config?.ambient ?? null
  const quiet = validQuietHours(input.config)

  if (policy !== null) {
    if (seen.ambientMode !== policy.mode) {
      seen.ambientMode = policy.mode
      seen.ambientNextAt = null
      seen.ambientIdleSince = null
      seen.ambientIdleCount = 0
      seen.ambientLastAt = null
      seen.ambientActionKeys = []
    }
    if (seen.ambientDayKey !== local.dayKey) {
      seen.ambientDayKey = local.dayKey
      seen.ambientCountToday = 0
      // 跨日时若正处在空闲段但已被每日上限压住，重新武装一次，避免要等下一次交互。
      if (
        seen.ambientIdleSince !== null
        && seen.ambientNextAt === null
        && ambientPolicyEligible(input.state, policy)
      ) {
        seen.ambientNextAt = now + drawAmbientIntervalMs(policy, rng)
      }
    }
  }

  const ambientEligible = policy !== null
    ? ambientPolicyEligible(input.state, policy)
    : isAmbientState(input.state)

  // 任何非 ambient 状态都算一次离开空闲；提前返回也要重新武装下一次 ambient。
  if (!ambientEligible) {
    seen.ambientConsumed = false
    if (policy !== null) endAmbientIdle(seen)
  }

  if (input.manualBusy) {
    // 用户手动动作先占据播放器；只暂时卸下 scene loop，事件游标保持待消费。
    if (seen.sceneLoopActive) seen.sceneLoopActive = false
    seen.ambientConsumed = false
    if (policy !== null) endAmbientIdle(seen)
    return { steady, seen }
  }

  if (input.actionBusy) {
    // 一次性动作完成前，后续 cue/transition 与 scene loop 都继续排队。
    return { steady, seen }
  }

  const cues = Array.isArray(input.state?.cues) ? input.state.cues : []
  for (const cue of cues) {
    const id = typeof cue?.id === 'string' ? cue.id.trim() : ''
    if (id === '') continue
    const when = cueWhen(cue.kind)
    const text = typeof cue.text === 'string' ? cue.text.trim() : ''
    const at = Number(cue.at)
    const ttlMs = Number(cue.ttlMs)
    const alive = Number.isFinite(at) && Number.isFinite(ttlMs) && ttlMs > 0
      && now - at < ttlMs
    if (seen.cueIds.includes(id)) continue
    if (!alive) {
      rememberCue(seen, id)
      continue
    }

    seen.ambientConsumed = false
    if (policy !== null) endAmbientIdle(seen)
    rememberCue(seen, id)
    const action = when === null
      ? null
      : takeAction(selectAction(when, input.triggers, input.actions, rng), seen, now)
    if (action !== null) seen.sceneLoopActive = false
    return {
      steady,
      seen,
      ...(text === '' ? {} : { bubble: { id, text } }),
      ...(action === null
        ? {}
        : { action: { type: 'startAction' as const, actionId: action.id, loop: false } }),
    }
  }

  const activityState = typeof input.state?.activity?.state === 'string'
    ? input.state.activity.state
    : null
  const scene = input.state?.scene
  const sceneKind = scene?.kind === 'rest' || scene?.kind === 'out'
    ? scene.kind
    : null

  if (activityState === 'waiting' && seen.lastActivityState !== 'waiting') {
    const action = takeAction(
      selectAction('activity:waiting', input.triggers, input.actions, rng),
      seen,
      now,
    )
    const shouldStop = action === null && seen.sceneLoopActive
    seen.lastActivityState = 'waiting'
    seen.sceneLoopActive = false
    const effect: TriggerActionEffect | undefined = action !== null
      ? { type: 'startAction', actionId: action.id, loop: false }
      : shouldStop
        ? { type: 'stopAction' }
        : undefined
    return { steady, seen, ...(effect === undefined ? {} : { action: effect }) }
  }

  if (activityState === 'waiting') {
    // waiting 已经消费过，但仍高于 scene/activity transition；让它们继续排队。
    return { steady, seen }
  }

  if (sceneKind !== seen.lastSceneKind) {
    const exiting = seen.lastSceneKind !== null
    const when = exiting
      ? `scene:${seen.lastSceneKind}:exit`
      : `scene:${sceneKind}:enter`
    const action = takeAction(selectAction(when, input.triggers, input.actions, rng), seen, now)
    const effect: TriggerActionEffect | undefined = action !== null
      ? {
          type: 'startAction',
          actionId: action.id,
          loop: !exiting && action.loop,
        }
      : exiting && seen.sceneLoopActive
        ? { type: 'stopAction' }
        : undefined

    if (exiting) {
      seen.lastSceneKind = null
      seen.sceneLoopActionId = null
      seen.sceneLoopActive = false
      seen.sceneLoopNeedsRevalidation = false
    } else {
      seen.lastSceneKind = sceneKind
      seen.sceneLoopActionId = action !== null && action.loop ? action.id : null
      seen.sceneLoopActive = action !== null && action.loop
      seen.sceneLoopNeedsRevalidation = false
    }
    // scene 压住 activity：记住它但不让低优先级 transition 抢占 scene 动作。
    seen.lastActivityState = activityState
    return { steady, seen, ...(effect === undefined ? {} : { action: effect }) }
  }

  if (activityState !== seen.lastActivityState) {
    if (activityState === null) {
      seen.lastActivityState = null
    } else if (sceneKind !== null) {
      seen.lastActivityState = activityState
    } else {
      const action = takeAction(
        selectAction(`activity:${activityState}`, input.triggers, input.actions, rng),
        seen,
        now,
      )
      seen.lastActivityState = activityState
      return {
        steady,
        seen,
        ...(action === null
          ? {}
          : { action: { type: 'startAction' as const, actionId: action.id, loop: false } }),
      }
    }
  }

  if (
    sceneKind !== null
    && activityState !== 'waiting'
    && seen.sceneLoopActionId !== null
    && !seen.sceneLoopActive
  ) {
    const selected = seen.sceneLoopNeedsRevalidation
      ? selectAction(`scene:${sceneKind}:enter`, input.triggers, input.actions, rng)
      : null
    const action = selected !== null
      ? takeAction(selected, seen, now)
      : input.actions.find((entry) => entry.id === seen.sceneLoopActionId) ?? null
    seen.sceneLoopNeedsRevalidation = false
    if (action === null || !action.loop) {
      seen.sceneLoopActionId = null
      seen.sceneLoopActive = false
    } else {
      seen.sceneLoopActionId = action.id
      seen.sceneLoopActive = true
      return {
        steady,
        seen,
        action: { type: 'startAction', actionId: action.id, loop: true },
      }
    }
  }

  // 安静时段只压旧 ambient 分支；策略路径在调度里推进 nextAt。
  if (policy === null && ambientEligible && inQuietHours(input.config, local.minute)) {
    return { steady, seen }
  }

  // 日期触发优先占用空闲拍；inAmbient 日期只在真正空闲时参与。
  // 安静时段对 date 同样生效（旧路径在上面已提前返回，这里覆盖策略路径）。
  const quietNow = inQuietHours(input.config, local.minute)
  for (const trigger of input.triggers) {
    if (!trigger.when.startsWith('date:') || trigger.when.slice('date:'.length) !== local.monthDay) {
      continue
    }
    if (quietNow) continue
    if (trigger.inAmbient && !ambientEligible) continue
    if (hasDate(seen, trigger.when, local.dayKey)) continue

    rememberDate(seen, trigger.when, local.dayKey)
    // 旧游标只在 legacy 路径维护；策略路径不碰它。
    if (policy === null && ambientEligible) seen.ambientConsumed = true
    if (!triggerCooldownElapsed(trigger, seen, now)) return { steady, seen }
    const action = actionForTrigger(trigger, input.actions, rng)
    if (action === null) return { steady, seen }
    rememberFire(seen, trigger.when, now)
    return {
      steady,
      seen,
      action: { type: 'startAction', actionId: action.id, loop: false },
    }
  }

  if (policy !== null) {
    if (!ambientEligible) return { steady, seen }
    const ambientAction = ambientPolicyAction(
      policy,
      seen,
      now,
      input.actions,
      rng,
      quiet,
      local.minute,
    )
    if (ambientAction === null) return { steady, seen }
    return {
      steady,
      seen,
      action: { type: 'startAction', actionId: ambientAction.id, loop: false },
    }
  }

  if (!ambientEligible) return { steady, seen }
  if (!seen.ambientConsumed) {
    const selected = selectAction('ambient', input.triggers, input.actions, rng)
    if (selected !== null && !triggerCooldownElapsed(selected.trigger, seen, now)) {
      return { steady, seen }
    }
    seen.ambientConsumed = true
    const action = takeAction(selected, seen, now)
    if (action !== null) {
      return {
        steady,
        seen,
        action: { type: 'startAction', actionId: action.id, loop: false },
      }
    }
  }

  return { steady, seen }
}
