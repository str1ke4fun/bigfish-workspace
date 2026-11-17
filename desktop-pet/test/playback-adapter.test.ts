import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DshPetConfig } from 'dsh-pet-component'
import { reducePlayback, PLAYBACK_SLOT, type PlaybackAction } from '../renderer/controller.ts'
import {
  borrowActionConfig,
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
