import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DshPetConfig } from 'dsh-pet-component'
import { reducePlayback, PLAYBACK_SLOT, type PlaybackAction } from '../renderer/controller.ts'
import {
  borrowActionConfig,
  chatReplyPlaybackDecision,
  chatThinkingPlan,
  createActionErrorOwner,
  createPlaybackCallbackArbiter,
  pendingServerActionAfterPlaybackEvent,
  petErrorTarget,
  restoreCompletedEvent,
  petUriProp,
  petMotionProp,
  restoreActionConfig,
} from '../renderer/playback-adapter.ts'

const wave: PlaybackAction = {
  id: 'wave',
  label: '挥手',
  anim: 'wave-file',
  loop: false,
  group: '回应',
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
