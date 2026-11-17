import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DshPetConfig } from 'dsh-pet-component'
import {
  decideEffects,
  emptySeen,
  reducePlayback,
  PLAYBACK_SLOT,
  type PetState,
  type PlaybackAction,
} from '../renderer/controller.ts'
import {
  applyManualRestIntent,
  borrowActionConfig,
  chatReplyPlaybackDecision,
  chatThinkingPlan,
  cueDispatchIsFresh,
  createActionErrorOwner,
  createPlaybackCallbackArbiter,
  emptyPetSeen,
  interruptSceneLoop,
  isPetDragGesture,
  manualMotionLeaseBusy,
  noteManualMotionChange,
  parsePetSeen,
  pendingServerActionAfterPlaybackEvent,
  petErrorTarget,
  petStateSnapshotIsStale,
  restClickBubble,
  restoreCompletedEvent,
  petUriProp,
  petMotionProp,
  restoreActionConfig,
  shouldOpenPetDialogue,
  startManualMotionLease,
  triggerPlaybackBusy,
  withoutPresenceComments,
} from '../renderer/playback-adapter.ts'
import { emptyTriggerSeen, reduceTriggers, type TriggerDefinition } from '../renderer/trigger-engine.ts'

const wave: PlaybackAction = {
  id: 'wave',
  label: '挥手',
  anim: 'wave-file',
  loop: false,
  group: '回应',
}

function petState(overrides: Partial<PetState> = {}): PetState {
  return {
    at: 1,
    presence: null,
    activity: null,
    action: null,
    scene: null,
    cues: [],
    ...overrides,
  }
}

function trigger(when: string, pool: string[]): TriggerDefinition {
  return { when, pool, w: pool.map(() => 1), once: false, minGapSec: 0, inAmbient: false }
}

function borrowedFixture(): DshPetConfig {
  return {
    size: 462,
    animations: {
      idle: ['idle-a'],
      clicks: ['click-a'],
      motions: {
        idle: 'animations-idle',
        waving: 'animations-wave',
        working: 'animations-work',
      },
    },
    motions: {
      idle: 'idle-a',
      waving: 'original-wave',
      working: 'work-a',
    },
  }
}

test('借用 config 只改 waving，原对象不变且能恢复原 mapping', () => {
  const original = borrowedFixture()
  const before = structuredClone(original)
  const borrowed = borrowActionConfig(original, wave, PLAYBACK_SLOT)

  assert.notEqual(borrowed, original)
  assert.notEqual(borrowed.motions, original.motions)
  assert.strictEqual(borrowed.animations, original.animations)
  assert.deepEqual(borrowed, {
    ...before,
    motions: {
      idle: 'idle-a',
      waving: 'wave-file',
      working: 'work-a',
    },
  })
  assert.deepEqual(original, before)

  const restored = restoreActionConfig(borrowed, PLAYBACK_SLOT)
  assert.notEqual(restored, borrowed)
  assert.notEqual(restored.motions, borrowed.motions)
  assert.deepEqual(restored, before)
})

test('顺序动作借用当前段；原来没有 motions 时恢复后仍没有', () => {
  const original: DshPetConfig = {
    animations: { idle: ['idle-a'], clicks: ['click-a'] },
  }
  const sleep: PlaybackAction = {
    id: 'sleep',
    label: '睡觉',
    seq: ['sleep-start', 'sleep-loop'],
    loop: true,
    group: '休息',
  }

  const first = borrowActionConfig(original, sleep, PLAYBACK_SLOT)
  assert.deepEqual(first.motions, { waving: 'sleep-start' })
  assert.strictEqual(first.animations, original.animations)

  const second = borrowActionConfig(original, 'sleep-loop', PLAYBACK_SLOT)
  assert.deepEqual(second.motions, { waving: 'sleep-loop' })

  const restored = restoreActionConfig(first, PLAYBACK_SLOT)
  assert.deepEqual(restored, original)
  assert.equal(Object.hasOwn(restored, 'motions'), false)
})

test('holding-loop 冻结 motion prop，stop 后交给最新 steady', () => {
  const action: PlaybackAction = {
    id: 'loop',
    label: '循环',
    anim: 'loop-file',
    loop: true,
    group: '测试',
  }
  const started = reducePlayback(null, { type: 'startAction', actionId: action.id }, {
    actions: [action],
    steady: 'thinking',
    now: 10,
  })

  assert.equal(started.state.status, 'holding-loop')
  assert.equal(petMotionProp(started.state, 'working'), 'thinking')
  assert.equal(petMotionProp(started.state, 'thinking'), 'thinking')

  // 循环播放期间组件仍可能补发 animationChanged；reducer 要记住停止时最新的
  // steady，但声明式 prop 必须继续停在进入循环时的安全值。
  const loopCallback = reducePlayback(started.state, {
    type: 'animationChanged',
    generation: started.state.generation,
    animation: { name: 'loop-file', once: false },
  }, {
    actions: [action],
    steady: 'working',
    now: 15,
  })
  assert.equal(loopCallback.state.steady, 'working')
  assert.equal(petMotionProp(loopCallback.state, 'working'), 'thinking')

  const stopped = reducePlayback(loopCallback.state, { type: 'stopAction' }, {
    actions: [action],
    steady: 'working',
    now: 20,
  })
  assert.equal(stopped.state.status, 'restoring')
  assert.equal(petMotionProp(stopped.state, 'working'), 'working')
})

test('默认动作借用时切到默认媒体源，恢复后回到当前皮肤媒体源', () => {
  const defaultWave: PlaybackAction = {
    id: 'default-wave',
    label: '默认挥手',
    anim: 'default-wave-file',
    loop: false,
    group: '回应',
    mediaUri: 'pet-asset://local/webm',
  }
  const skinWave: PlaybackAction = {
    id: 'skin-wave',
    label: '皮肤挥手',
    anim: 'skin-wave-file',
    loop: false,
    group: '回应',
    mediaUri: 'pet-asset://local/skins/rest/webm',
  }
  const actions = [defaultWave, skinWave]
  const skinUri = 'pet-asset://local/skins/rest/webm'
  const options = { actions, steady: 'idle' as const, now: 10 }

  const defaultStarted = reducePlayback(null, {
    type: 'startAction', actionId: defaultWave.id,
  }, options)
  assert.equal(petUriProp(defaultStarted.state, actions, skinUri), 'pet-asset://local/webm')

  const restored = reducePlayback(defaultStarted.state, { type: 'stopAction' }, {
    ...options,
    now: 20,
  })
  assert.equal(petUriProp(restored.state, actions, skinUri), skinUri)

  const skinStarted = reducePlayback(null, {
    type: 'startAction', actionId: skinWave.id,
  }, options)
  assert.equal(petUriProp(skinStarted.state, actions, skinUri), skinUri)
})

test('App clear-only 停止路径显式完成 restoring，不依赖组件回调', () => {
  const action: PlaybackAction = {
    id: 'loop',
    label: '循环',
    anim: 'loop-file',
    loop: true,
    group: '测试',
  }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const started = reducePlayback(null, { type: 'startAction', actionId: action.id }, options)
  const stopped = reducePlayback(started.state, { type: 'stopAction' }, {
    ...options,
    steady: 'working',
    now: 20,
  })

  assert.equal(stopped.state.status, 'restoring')
  const completion = restoreCompletedEvent(stopped.state)
  assert.deepEqual(completion, {
    type: 'restoreCompleted',
    generation: stopped.state.generation,
  })

  const settled = reducePlayback(stopped.state, completion!, {
    ...options,
    steady: 'working',
    now: 30,
  })
  assert.equal(settled.state.status, 'idle')
  assert.equal(settled.state.steady, 'working')
})

test('聊天 thinking 遇到借用播放时先显式停止，不再用 bubble motion 抢命令面', () => {
  const action: PlaybackAction = {
    id: 'loop',
    label: '循环',
    anim: 'loop-file',
    loop: true,
    group: '测试',
  }
  const options = { actions: [action], steady: 'thinking' as const, now: 10 }
  const started = reducePlayback(null, { type: 'startAction', actionId: action.id }, options)

  assert.deepEqual(chatThinkingPlan(started.state), { preemptMotion: 'thinking' })
  assert.deepEqual(chatThinkingPlan(null), { bubbleMotion: 'thinking' })

  const stopped = reducePlayback(started.state, { type: 'stopAction' }, {
    ...options,
    steady: 'working',
    now: 20,
  })
  const completion = restoreCompletedEvent(stopped.state)
  const settled = reducePlayback(stopped.state, completion!, {
    ...options,
    steady: 'working',
    now: 30,
  })
  assert.equal(settled.state.status, 'idle')
  assert.equal(settled.state.steady, 'working')
})

test('临近结束的旧一次性动作被抢占后，新素材就绪前不能绑定任何结束回调', () => {
  const first: PlaybackAction = {
    id: 'first',
    label: '第一段',
    anim: 'first-file',
    loop: false,
    group: '测试',
  }
  const second: PlaybackAction = {
    id: 'second',
    label: '第二段',
    anim: 'second-file',
    loop: false,
    group: '测试',
  }
  const options = { actions: [first, second], steady: 'idle' as const, now: 10 }
  const mediaUri = 'pet-asset://local/webm'
  const callbacks = createPlaybackCallbackArbiter()

  const started = reducePlayback(null, { type: 'startAction', actionId: first.id }, options)
  callbacks.expectTarget(started.state.generation, started.state.expectedAnimation!, mediaUri, true)
  assert.equal(callbacks.animationChanged({
    name: 'first-file', once: true, src: `${mediaUri}/first-file.webm`,
  }), null)
  const firstTarget = callbacks.ready()
  assert.ok(firstTarget)
  const nearEnd = reducePlayback(started.state, firstTarget!, { ...options, now: 20 }).state
  assert.equal(nearEnd.targetSeen, true)

  const preempted = reducePlayback(nearEnd, { type: 'startAction', actionId: second.id }, {
    ...options,
    now: 30,
  })
  callbacks.expectTarget(preempted.state.generation, preempted.state.expectedAnimation!, mediaUri, true)

  // 旧视频的 idle/end 回调可能落在目标选择前后，但 loadeddata 前都不能借新 generation 完成第二段。
  assert.equal(callbacks.motionChanged('idle'), null)
  assert.equal(callbacks.animationChanged({
    name: 'idle', once: false, src: `${mediaUri}/idle.webm`,
  }), null)
  assert.equal(callbacks.animationChanged({
    name: 'second-file', once: true, src: `${mediaUri}/second-file.webm`,
  }), null)
  assert.equal(callbacks.motionChanged('idle'), null)
  assert.equal(callbacks.animationChanged({
    name: 'idle', once: false, src: `${mediaUri}/idle.webm`,
  }), null)
  assert.equal(preempted.state.actionId, second.id)
  assert.equal(preempted.state.targetSeen, false)

  const secondTarget = callbacks.ready()
  assert.deepEqual(secondTarget, {
    type: 'animationChanged',
    generation: preempted.state.generation,
    animation: {
      name: 'second-file',
      once: true,
      src: `${mediaUri}/second-file.webm`,
    },
  })
  assert.ok(secondTarget)
  const secondNearEnd = reducePlayback(preempted.state, secondTarget!, { ...options, now: 40 }).state
  assert.equal(secondNearEnd.targetSeen, true)

  const secondEnd = callbacks.animationChanged({
    name: 'idle', once: false, src: `${mediaUri}/idle.webm`,
  })
  assert.ok(secondEnd)
  const restored = reducePlayback(secondNearEnd, secondEnd!, { ...options, now: 50 })
  assert.equal(restored.state.status, 'restoring')
})

test('自定义动作素材错误只停止动作，不按皮肤错误处理', () => {
  const action: PlaybackAction = {
    id: 'bad-media',
    label: '坏素材',
    anim: 'bad-media-file',
    loop: true,
    group: '测试',
    mediaUri: 'pet-asset://local/webm',
  }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const started = reducePlayback(null, { type: 'startAction', actionId: action.id }, options)
  assert.equal(petErrorTarget(started.state), 'action')

  const stopped = reducePlayback(started.state, { type: 'stopAction' }, options)
  assert.equal(petErrorTarget(stopped.state), 'skin')
  assert.equal(petErrorTarget(null), 'skin')
})

test('同一动作的重复素材错误在 restoring 完成前仍归动作，不能回退皮肤', () => {
  const action: PlaybackAction = {
    id: 'bad-video',
    label: '坏视频',
    anim: 'bad-video-file',
    loop: true,
    group: '测试',
    mediaUri: 'pet-asset://local/webm',
  }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const started = reducePlayback(null, { type: 'startAction', actionId: action.id }, options)

  const owner = createActionErrorOwner(started.state)
  assert.deepEqual(owner, {
    generation: started.state.generation,
    restoreGeneration: started.state.generation + 1,
    actionId: action.id,
    source: 'bad-video-file',
  })
  assert.equal(petErrorTarget(started.state, owner), 'action')
  const stopped = reducePlayback(started.state, { type: 'stopAction' }, options)
  assert.equal(stopped.state.status, 'restoring')
  assert.equal(petErrorTarget(stopped.state, owner), 'action')
  assert.equal(petErrorTarget(stopped.state, owner), 'action')

  const completion = restoreCompletedEvent(stopped.state)
  assert.ok(completion)
  const settled = reducePlayback(stopped.state, completion!, options)
  assert.equal(settled.state.status, 'idle')
  assert.equal(petErrorTarget(settled.state, owner), 'skin')
})

test('A 动作的错误归属不会串到 B 的恢复段', () => {
  const a: PlaybackAction = {
    id: 'action-a',
    label: '动作 A',
    anim: 'a-file',
    loop: false,
    group: '测试',
  }
  const b: PlaybackAction = {
    id: 'action-b',
    label: '动作 B',
    anim: 'b-file',
    loop: true,
    group: '测试',
  }
  const options = { actions: [a, b], steady: 'idle' as const, now: 10 }
  const aStarted = reducePlayback(null, { type: 'startAction', actionId: a.id }, options).state
  const ownerA = createActionErrorOwner(aStarted)
  assert.ok(ownerA)
  assert.equal(ownerA.actionId, 'action-a')
  assert.equal(ownerA.source, 'a-file')

  const aStopped = reducePlayback(aStarted, { type: 'stopAction' }, options).state
  const bStarted = reducePlayback(aStopped, { type: 'startAction', actionId: b.id }, {
    ...options,
    now: 20,
  }).state
  const bStopped = reducePlayback(bStarted, { type: 'stopAction' }, {
    ...options,
    now: 30,
  }).state

  assert.equal(aStopped.status, 'restoring')
  assert.equal(bStopped.status, 'restoring')
  assert.equal(petErrorTarget(bStopped, ownerA), 'skin')
})

test('停止、拖动、换皮肤和更新动作都会清掉待补目录的服务端动作', () => {
  const pending = 'asset-042'
  for (const event of [
    { type: 'startAction' as const, actionId: 'asset-043' },
    { type: 'stopAction' as const },
    { type: 'dragStarted' as const },
    { type: 'skinChanged' as const },
  ]) {
    assert.equal(pendingServerActionAfterPlaybackEvent(pending, event), null)
  }
  assert.equal(
    pendingServerActionAfterPlaybackEvent(pending, { type: 'steadyChanged', steady: 'working' }),
    pending,
  )
})

test('延迟回复只在自己仍是当前请求且动作代次未变时才播放 waving', () => {
  const action: PlaybackAction = {
    id: 'loop',
    label: '循环',
    anim: 'loop-file',
    loop: true,
    group: '测试',
  }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const newerLoop = reducePlayback(null, { type: 'startAction', actionId: action.id }, options).state

  assert.deepEqual(chatReplyPlaybackDecision({
    requestGeneration: 1,
    latestRequestGeneration: 1,
    playbackGeneration: 0,
    playback: newerLoop,
  }), { current: true })
  assert.deepEqual(chatReplyPlaybackDecision({
    requestGeneration: 1,
    latestRequestGeneration: 2,
    playbackGeneration: 0,
    playback: newerLoop,
  }), { current: false })
  assert.deepEqual(chatReplyPlaybackDecision({
    requestGeneration: 2,
    latestRequestGeneration: 2,
    playbackGeneration: newerLoop.generation,
    playback: newerLoop,
  }), { current: true, motion: 'waving' })
})

test('持久化 Seen 兼容旧记录，并把 cue/occurrence 游标限制为有界数组', () => {
  const cueIds = Array.from({ length: 70 }, (_, index) => `cue-${index}`)
  const occurrenceKeys = Array.from({ length: 70 }, (_, index) => `occurrence-${index}`)
  const seen = parsePetSeen({
    lastActionId: 'action-7',
    lastCommentAt: '2026-11-18T08:00:00Z',
    cueIds,
    occurrenceKeys,
  })

  assert.equal(seen.lastActionId, 'action-7')
  assert.equal(seen.lastCommentAt, '2026-11-18T08:00:00Z')
  assert.deepEqual(seen.cueIds, cueIds.slice(-64))
  assert.deepEqual(seen.occurrenceKeys, occurrenceKeys.slice(-64))
  assert.deepEqual(parsePetSeen(null), emptyPetSeen())
})

test('冷启动把持久化 scene loop 标成待恢复，不把旧进程的 active 当成仍在播放', () => {
  const loopAction: PlaybackAction = {
    id: 'rest-loop', label: '休息循环', anim: 'rest-loop-file', loop: true, group: '休息',
  }
  const seen = parsePetSeen({
    lastSceneKind: 'rest',
    sceneLoopActionId: loopAction.id,
    sceneLoopActive: true,
  })

  assert.equal(seen.lastSceneKind, 'rest')
  assert.equal(seen.sceneLoopActionId, loopAction.id)
  assert.equal(seen.sceneLoopActive, false)

  const restarted = reduceTriggers({
    state: petState({ scene: { kind: 'rest', at: 20 } }),
    triggers: [trigger('scene:rest:enter', [loopAction.id])],
    actions: [loopAction],
    seen,
    now: 30,
    manualBusy: false,
  })
  assert.deepEqual(restarted.action, { type: 'startAction', actionId: loopAction.id, loop: true })
})

test('cue dispatch 前再次核对当前状态里的 TTL', () => {
  const state = petState({
    cues: [{ id: 'cue-stale', kind: 'speak', text: '过期了', at: 1000, ttlMs: 1000 }],
  })

  assert.equal(cueDispatchIsFresh(state, 'cue-stale', 1999), true)
  assert.equal(cueDispatchIsFresh(state, 'cue-stale', 2000), false)
  assert.equal(cueDispatchIsFresh(state, 'cue-missing', 1200), false)
})

test('presence.recent 不再绕过 cue 链独立触发 waving', () => {
  const state = petState({
    cues: [{ id: 'cue-speak', kind: 'speak', text: '她刚说的话', at: 100, ttlMs: 15_000 }],
    presence: {
      on: true,
      mode: 'event',
      busy: false,
      snapshot: null,
      recent: [{ at: '2026-11-18T08:00:00Z', mode: 'event', event: 'scene_change', text: '同一句话' }],
    },
  })
  const legacyOnly = decideEffects(emptySeen(), withoutPresenceComments(state), 200)

  assert.equal(legacyOnly.bubble, undefined)
  assert.equal(legacyOnly.motion, undefined)
  assert.equal(legacyOnly.steady, 'thinking')
})

test('休息点击只显示固定短句并拦住对话；拖动阈值后仍按拖动处理', () => {
  assert.deepEqual(restClickBubble(), { id: 'resting', title: '在休息' })
  assert.equal(shouldOpenPetDialogue(petState({ scene: { kind: 'rest', at: 1 } })), false)
  assert.equal(shouldOpenPetDialogue(petState()), true)
  assert.equal(isPetDragGesture({ x: 10, y: 10 }, { x: 13, y: 12 }), false)
  assert.equal(isPetDragGesture({ x: 10, y: 10 }, { x: 16, y: 10 }), true)
})

test('manual sleep/wake 标记对应 scene 已消费，不再次触发 scene transition', () => {
  const sleepAction: PlaybackAction = {
    id: 'sleep', label: '睡觉', seq: ['sleep-start', 'sleep-loop'], loop: true, group: '休息',
  }
  const wakeAction: PlaybackAction = {
    id: 'wake', label: '起来', anim: 'wake-file', loop: false, group: '休息',
  }
  const triggers = [
    trigger('scene:rest:enter', [sleepAction.id]),
    trigger('scene:rest:exit', [wakeAction.id]),
  ]

  const sleptSeen = applyManualRestIntent(emptyPetSeen(), 'sleep', sleepAction.id, 'rest')
  const slept = reduceTriggers({
    state: petState({ scene: { kind: 'rest', at: 20 } }),
    triggers,
    actions: [sleepAction, wakeAction],
    seen: sleptSeen,
    now: 30,
    manualBusy: false,
  })
  assert.equal(slept.action, undefined)

  const wokeSeen = applyManualRestIntent(sleptSeen, 'wake', wakeAction.id, null)
  const woke = reduceTriggers({
    state: petState(),
    triggers,
    actions: [sleepAction, wakeAction],
    seen: wokeSeen,
    now: 40,
    manualBusy: false,
  })
  assert.equal(woke.action, undefined)
  assert.equal(woke.seen.lastSceneKind, null)
})

test('出门时手动睡觉保留服务端返回的 out scene，不伪造 rest 退出', () => {
  const sleepAction: PlaybackAction = {
    id: 'sleep', label: '睡觉', seq: ['sleep-start', 'sleep-loop'], loop: true, group: '休息',
  }
  const wakeAction: PlaybackAction = {
    id: 'wake', label: '起来', anim: 'wake-file', loop: false, group: '休息',
  }
  const outScene = { kind: 'out' as const, at: 90 }
  const sleptSeen = applyManualRestIntent(emptyPetSeen(), 'sleep', sleepAction.id, outScene)
  const next = reduceTriggers({
    state: petState({ scene: outScene }),
    triggers: [
      trigger('scene:rest:exit', [wakeAction.id]),
      trigger('scene:out:enter', [wakeAction.id]),
    ],
    actions: [sleepAction, wakeAction],
    seen: sleptSeen,
    now: 100,
    manualBusy: false,
  })

  assert.equal(sleptSeen.lastSceneKind, 'out')
  assert.equal(sleptSeen.sceneLoopActive, false)
  assert.equal(next.action, undefined)
  assert.equal(next.seen.lastSceneKind, 'out')
})

test('手动变更之后到达的旧 state snapshot 被拒绝，新 snapshot 才允许归约', () => {
  const intentAt = 200
  const stale = petState({ at: 199, scene: null })
  const sameTick = petState({ at: 200, scene: null })
  const fresh = petState({ at: 201, scene: { kind: 'rest', at: 201 } })

  assert.equal(petStateSnapshotIsStale(stale, intentAt), true)
  assert.equal(petStateSnapshotIsStale(sameTick, intentAt), false)
  assert.equal(petStateSnapshotIsStale(fresh, intentAt), false)
  assert.equal(petStateSnapshotIsStale(null, intentAt), false)
})

test('trigger 的一次性动作完成前 actionBusy，scene loop 与手动动作分别走各自闸', () => {
  const action: PlaybackAction = {
    id: 'once', label: '一次', anim: 'once-file', loop: false, group: '测试',
  }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const once = reducePlayback(null, { type: 'startAction', actionId: action.id }, options).state
  const loopAction: PlaybackAction = {
    id: 'loop', label: '循环', anim: 'loop-file', loop: true, group: '测试',
  }
  const loop = reducePlayback(null, { type: 'startAction', actionId: loopAction.id }, {
    actions: [loopAction], steady: 'idle', now: 10,
  }).state

  assert.deepEqual(triggerPlaybackBusy(once, 'trigger'), { manualBusy: false, actionBusy: true })
  assert.deepEqual(triggerPlaybackBusy(loop, 'scene'), { manualBusy: false, actionBusy: false })
  const restoring = reducePlayback(loop, { type: 'skinChanged' }, {
    actions: [loopAction], steady: 'idle', now: 20,
  }).state
  assert.deepEqual(triggerPlaybackBusy(restoring, 'scene'), { manualBusy: true, actionBusy: false })
  assert.deepEqual(triggerPlaybackBusy(loop, 'manual'), { manualBusy: true, actionBusy: false })
})

test('直接下发的 legacy motion 在完成前占用 manualBusy，cue 不会被自动触发抢占', () => {
  const cueAction: PlaybackAction = {
    id: 'cue-wave', label: '回应', anim: 'cue-wave-file', loop: false, group: '回应',
  }
  const current = petState({
    cues: [{ id: 'cue-1', kind: 'speak', text: '她刚说话', at: 100, ttlMs: 15_000 }],
  })
  const input = {
    state: current,
    triggers: [trigger('speak', [cueAction.id])],
    actions: [cueAction],
    seen: emptyTriggerSeen(),
    now: 200,
    manualBusy: false,
  }
  const lease = startManualMotionLease('waving', 100, 1000)

  const held = reduceTriggers({ ...input, manualBusy: manualMotionLeaseBusy(lease, 200) })
  const confirmed = noteManualMotionChange(lease, 'waving', 300)
  const completed = noteManualMotionChange(confirmed, 'idle', 400)
  const released = reduceTriggers({ ...input, seen: held.seen, manualBusy: false })

  assert.equal(manualMotionLeaseBusy(lease, 200), true)
  assert.equal(held.action, undefined)
  assert.equal(held.bubble, undefined)
  assert.deepEqual(held.seen.cueIds, [])
  assert.equal(manualMotionLeaseBusy(completed, 400), false)
  assert.deepEqual(released.action, { type: 'startAction', actionId: cueAction.id, loop: false })
  assert.deepEqual(released.bubble, { id: 'cue-1', text: '她刚说话' })
})

test('皮肤切换后 scene loop 按新 trigger 重新选择动作', () => {
  const oldAction: PlaybackAction = {
    id: 'old-rest-loop', label: '旧休息', anim: 'old-rest', loop: true, group: '休息',
  }
  const newAction: PlaybackAction = {
    id: 'new-rest-loop', label: '新休息', anim: 'new-rest', loop: true, group: '休息',
  }
  const triggers = [trigger('scene:rest:enter', [oldAction.id])]
  const resting = petState({ scene: { kind: 'rest', at: 20 } })
  const entered = reduceTriggers({
    state: resting,
    triggers,
    actions: [oldAction],
    seen: emptyTriggerSeen(),
    now: 30,
    manualBusy: false,
  })
  assert.deepEqual(entered.action, { type: 'startAction', actionId: oldAction.id, loop: true })

  const interrupted = interruptSceneLoop(entered.seen)
  assert.equal(interrupted.sceneLoopActive, false)
  assert.equal(interrupted.lastSceneKind, 'rest')

  const switched = reduceTriggers({
    state: resting,
    triggers: [trigger('scene:rest:enter', [newAction.id])],
    actions: [oldAction, newAction],
    seen: interrupted,
    now: 40,
    manualBusy: false,
  })
  assert.deepEqual(switched.action, { type: 'startAction', actionId: newAction.id, loop: true })
  assert.equal(switched.seen.sceneLoopActionId, newAction.id)
  assert.equal(switched.seen.sceneLoopActive, true)
  assert.equal(switched.seen.lastSceneKind, 'rest')
})

test('皮肤移除旧 scene loop 动作后不恢复已经不存在的 owner', () => {
  const oldAction: PlaybackAction = {
    id: 'removed-rest-loop', label: '旧休息', anim: 'old-rest', loop: true, group: '休息',
  }
  const resting = petState({ scene: { kind: 'rest', at: 20 } })
  const entered = reduceTriggers({
    state: resting,
    triggers: [trigger('scene:rest:enter', [oldAction.id])],
    actions: [oldAction],
    seen: emptyTriggerSeen(),
    now: 30,
    manualBusy: false,
  })

  const switched = reduceTriggers({
    state: resting,
    triggers: [],
    actions: [],
    seen: interruptSceneLoop(entered.seen),
    now: 40,
    manualBusy: false,
  })

  assert.equal(switched.action, undefined)
  assert.equal(switched.seen.sceneLoopActionId, null)
  assert.equal(switched.seen.sceneLoopActive, false)
})

test('同一 scene action 改成一次性后不再按旧 loop 语义恢复', () => {
  const loopAction: PlaybackAction = {
    id: 'rest-action', label: '休息', anim: 'rest-loop', loop: true, group: '休息',
  }
  const oneShotAction: PlaybackAction = { ...loopAction, loop: false }
  const resting = petState({ scene: { kind: 'rest', at: 20 } })
  const entered = reduceTriggers({
    state: resting,
    triggers: [trigger('scene:rest:enter', [loopAction.id])],
    actions: [loopAction],
    seen: emptyTriggerSeen(),
    now: 30,
    manualBusy: false,
  })

  const switched = reduceTriggers({
    state: resting,
    triggers: [trigger('scene:rest:enter', [oneShotAction.id])],
    actions: [oneShotAction],
    seen: interruptSceneLoop(entered.seen),
    now: 40,
    manualBusy: false,
  })

  assert.equal(switched.action, undefined)
  assert.equal(switched.seen.sceneLoopActionId, null)
  assert.equal(switched.seen.sceneLoopActive, false)
})
