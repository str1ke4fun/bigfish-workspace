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
import {
  isPetMotion,
  type PetState,
  type PetMotion,
  type PlaybackAction,
} from './controller.ts'

export type { TriggerDefinition } from '../shared/trigger-model.ts'

export const TRIGGER_SEEN_LIMIT = 64

export interface TriggerSeen {
  /** 已消费的 cue id；有界，避免 localStorage 无限增长。 */
  cueIds: string[]
  lastActivityState: string | null
  lastSceneKind: 'rest' | 'out' | null
  sceneLoopActionId: string | null
  sceneLoopActive: boolean
  /** 旧 playback 已丢失/被打断；恢复前必须按当前 trigger 目录重新选择。 */
  sceneLoopNeedsRevalidation: boolean
  ambientConsumed: boolean
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
  rng?: () => number
}

export function emptyTriggerSeen(): TriggerSeen {
  return {
    cueIds: [],
    lastActivityState: null,
    lastSceneKind: null,
    sceneLoopActionId: null,
    sceneLoopActive: false,
    sceneLoopNeedsRevalidation: false,
    ambientConsumed: false,
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

function cloneSeen(seen: TriggerSeen): TriggerSeen {
  return {
    cueIds: boundedSeen(seen?.cueIds ?? []),
    lastActivityState: typeof seen?.lastActivityState === 'string' ? seen.lastActivityState : null,
    lastSceneKind: seen?.lastSceneKind === 'rest' || seen?.lastSceneKind === 'out'
      ? seen.lastSceneKind
      : null,
    sceneLoopActionId: typeof seen?.sceneLoopActionId === 'string' ? seen.sceneLoopActionId : null,
    sceneLoopActive: seen?.sceneLoopActive === true,
    sceneLoopNeedsRevalidation: seen?.sceneLoopNeedsRevalidation === true,
    ambientConsumed: seen?.ambientConsumed === true,
  }
}

function rememberCue(seen: TriggerSeen, id: string): void {
  if (seen.cueIds.includes(id)) return
  seen.cueIds = boundedSeen([...seen.cueIds, id])
}

function selectAction(
  when: string,
  triggers: readonly TriggerDefinition[],
  actions: readonly PlaybackAction[],
  rng: () => number,
): PlaybackAction | null {
  const trigger = triggers.find((entry) => entry?.when === when)
  if (!trigger) return null
  const actionId = pickTriggerAction(trigger, rng)
  if (actionId === null) return null
  return actions.find((entry) => entry?.id === actionId) ?? null
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

/** 归约一拍：高优先级事件先消费，低优先级状态留到后续拍继续处理。 */
export function reduceTriggers(input: ReduceTriggersInput): TriggerEffects {
  const seen = cloneSeen(input.seen)
  const steady = steadyMotion(input.state)
  const rng = input.rng ?? Math.random
  const now = Number.isFinite(input.now) ? input.now : 0
  const ambientEligible = isAmbientState(input.state)

  // 任何非 ambient 状态都算一次离开空闲；提前返回也要重新武装下一次 ambient。
  if (!ambientEligible) seen.ambientConsumed = false

  if (input.manualBusy) {
    // 用户手动动作先占据播放器；只暂时卸下 scene loop，事件游标保持待消费。
    if (seen.sceneLoopActive) seen.sceneLoopActive = false
    seen.ambientConsumed = false
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
    rememberCue(seen, id)
    const action = when === null ? null : selectAction(when, input.triggers, input.actions, rng)
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
    const action = selectAction('activity:waiting', input.triggers, input.actions, rng)
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
    const action = selectAction(when, input.triggers, input.actions, rng)
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
      const action = selectAction(`activity:${activityState}`, input.triggers, input.actions, rng)
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
    const action = seen.sceneLoopNeedsRevalidation
      ? selectAction(`scene:${sceneKind}:enter`, input.triggers, input.actions, rng)
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

  if (!ambientEligible) return { steady, seen }
  if (!seen.ambientConsumed) {
    seen.ambientConsumed = true
    const action = selectAction('ambient', input.triggers, input.actions, rng)
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
