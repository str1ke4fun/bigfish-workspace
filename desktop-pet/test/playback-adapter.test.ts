import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DshPetConfig } from 'dsh-pet-component'
import { reducePlayback, PLAYBACK_SLOT, type PlaybackAction } from '../renderer/controller.ts'
import {
  borrowActionConfig,
  chatThinkingPlan,
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
