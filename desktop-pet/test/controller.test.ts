import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideEffects, emptySeen, performedMotion } from '../renderer/controller.ts'
import * as controller from '../renderer/controller.ts'

const base = { at: 1, presence: null, activity: null, action: null }

function commentState(event = 'scene_change', at = '2026-11-14T08:00:00Z') {
  return {
    ...base,
    presence: {
      on: true,
      mode: 'event',
      busy: false,
      snapshot: null,
      recent: [{ at, mode: 'event', event, text: '你好' }],
    },
  }
}

test('显式动作优先，过期不播', () => {
  const r = decideEffects(emptySeen(), {
    ...base, action: { id: 'a1', motion: 'success', text: null, at: 1000, ttlMs: 15000 },
  }, 2000)
  assert.equal(r.motion, 'success')
  const stale = decideEffects(emptySeen(), {
    ...base, action: { id: 'a2', motion: 'error', text: null, at: 0, ttlMs: 1000 },
  }, 2000)
  assert.notEqual(stale.motion, 'error')
})

test('同一评论只弹一次，新评论弹气泡', () => {
  const state = commentState()
  const a = decideEffects(emptySeen(), state, 1)
  assert.equal(a.bubble?.text, '你好')
  const b = decideEffects(a.seen, state, 2)
  assert.equal(b.bubble, undefined)
})

test('评论一次性播完回落 activity 稳态，不是 idle', () => {
  const state = { ...commentState(), activity: { state: 'thinking', at: 1, sessionId: 's' } }
  const first = decideEffects(emptySeen(), state, 1)
  assert.equal(first.motion, 'waving')
  assert.equal(first.steady, 'thinking')
  const later = decideEffects(first.seen, state, 2)
  assert.equal(later.motion, undefined)
  assert.equal(later.steady, 'thinking')
})

test('activity 走声明式稳态，不重复下发命令', () => {
  const state = { ...base, activity: { state: 'thinking', at: 1, sessionId: 's' } }
  const a = decideEffects(emptySeen(), state, 2)
  assert.equal(a.steady, 'thinking')
  assert.equal(a.motion, undefined)
  const b = decideEffects(a.seen, state, 3)
  assert.equal(b.steady, 'thinking')
  assert.equal(b.motion, undefined)
})

test('动作过期后稳态仍回 activity，不靠一次性命令', () => {
  const state = { ...base, activity: { state: 'thinking', at: 1, sessionId: 's' } }
  const act = decideEffects(emptySeen(), {
    ...state, action: { id: 'a1', motion: 'success', text: '好耶', at: 10, ttlMs: 100 },
  }, 20)
  assert.equal(act.motion, 'success')
  assert.equal(act.steady, 'thinking')
  assert.equal(act.bubble?.text, '好耶')
  const back = decideEffects(act.seen, state, 200)
  assert.equal(back.motion, undefined)
  assert.equal(back.steady, 'thinking')
})

test('presence 开启无活动 → thinking，关闭 → idle，activity 优先', () => {
  const on = {
    ...base,
    presence: { on: true, mode: 'event', busy: false, snapshot: null, recent: [] },
  }
  assert.equal(decideEffects(emptySeen(), on, 1).steady, 'thinking')
  const off = { ...on, presence: { ...on.presence, on: false } }
  assert.equal(decideEffects(emptySeen(), off, 1).steady, 'idle')
  const working = { ...on, activity: { state: 'working', at: 1, sessionId: 's' } }
  assert.equal(decideEffects(emptySeen(), working, 1).steady, 'working')
})

test('重启后不依赖持久化的 activity：稳态按当前状态直接下发', () => {
  const state = { ...base, activity: { state: 'working', at: 1, sessionId: 's' } }
  const restart = decideEffects(emptySeen(), state, 1)
  assert.equal(restart.steady, 'working')
  assert.equal(restart.motion, undefined)
  assert.equal(Object.hasOwn(emptySeen(), 'activity'), false)
})

test('settlement 评论用 success，其余用 waving', () => {
  assert.equal(decideEffects(emptySeen(), commentState('settlement'), 1).bubble?.motion, 'success')
  assert.equal(decideEffects(emptySeen(), commentState('scene_change'), 1).bubble?.motion, 'waving')
})

test('菜单动作一次性播放并回落到稳态', () => {
  for (const name of ['thinking', 'working', 'result', 'waiting', 'waving', 'success', 'error']) {
    const options = performedMotion(name)
    assert.equal(options?.type, name)
    assert.equal(options?.loop, false)
    assert.equal(options?.replay, true)
  }
  assert.equal(performedMotion('nope'), null)
})

test('播放器：一次性动作借 waving 播放，结束后恢复最新稳态', () => {
  const action = { id: 'wave', label: '挥手', anim: 'wave-file', loop: false, group: '日常' }
  const start = controller.reducePlayback(null, { type: 'startAction', actionId: 'wave' }, {
    actions: [action],
    steady: 'thinking',
    now: 10,
  })

  assert.equal(start.state.status, 'playing-once')
  assert.equal(start.state.generation, 1)
  assert.equal(start.state.steady, 'thinking')
  assert.deepEqual(start.effects, [
    { type: 'bind-slot', slot: 'waving', animation: 'wave-file' },
    { type: 'play-motion', motion: 'waving', loop: false, replay: true },
  ])

  const target = controller.reducePlayback(start.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'wave-file', once: true, src: null },
  }, { actions: [action], steady: 'thinking', now: 20 })
  assert.equal(target.state.status, 'playing-once')
  assert.deepEqual(target.effects, [])

  const ended = controller.reducePlayback(target.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'thinking-file', once: false, src: null },
  }, { actions: [action], steady: 'thinking', now: 30 })
  assert.equal(ended.state.status, 'restoring')
  assert.equal(ended.state.steady, 'thinking')
  assert.deepEqual(ended.effects, [
    { type: 'clear-motion' },
    { type: 'restore-slot', slot: 'waving', steady: 'thinking' },
  ])

  const restored = controller.reducePlayback(ended.state, {
    type: 'motionChanged',
    generation: ended.state.generation,
    motion: 'thinking',
  }, { actions: [action], steady: 'thinking', now: 40 })
  assert.equal(restored.state.status, 'idle')
  assert.deepEqual(restored.effects, [])
})

test('播放器：顺序动作逐段推进，最后一段 loop 保持', () => {
  const action = {
    id: 'sleep',
    label: '睡觉',
    seq: ['sleep-start', 'sleep-enter', 'sleep-loop'],
    loop: true,
    group: '休息',
  }
  const options: controller.PlaybackContext = { actions: [action], steady: 'working', now: 10 }
  const start = controller.reducePlayback(null, { type: 'startAction', actionId: 'sleep' }, options)
  assert.equal(start.state.status, 'playing-seq')
  assert.equal(start.state.index, 0)
  assert.deepEqual(start.effects, [
    { type: 'bind-slot', slot: 'waving', animation: 'sleep-start' },
    { type: 'play-motion', motion: 'waving', loop: false, replay: true },
  ])

  const firstTarget = controller.reducePlayback(start.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'sleep-start', once: true, src: null },
  }, options)
  const firstEnded = controller.reducePlayback(firstTarget.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'work-loop', once: false, src: null },
  }, options)
  assert.equal(firstEnded.state.status, 'playing-seq')
  assert.equal(firstEnded.state.index, 1)
  assert.equal(firstEnded.state.expectedAnimation, 'sleep-enter')
  assert.deepEqual(firstEnded.effects, [
    { type: 'bind-slot', slot: 'waving', animation: 'sleep-enter' },
    { type: 'play-motion', motion: 'waving', loop: false, replay: true },
  ])

  const secondTarget = controller.reducePlayback(firstEnded.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'sleep-enter', once: true, src: null },
  }, options)
  const secondEnded = controller.reducePlayback(secondTarget.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'work-loop', once: false, src: null },
  }, options)
  assert.equal(secondEnded.state.status, 'holding-loop')
  assert.equal(secondEnded.state.index, 2)
  assert.equal(secondEnded.state.expectedAnimation, 'sleep-loop')
  assert.deepEqual(secondEnded.effects, [
    { type: 'bind-slot', slot: 'waving', animation: 'sleep-loop' },
    { type: 'play-motion', motion: 'waving', loop: true, replay: true },
  ])

  const held = controller.reducePlayback(secondEnded.state, {
    type: 'animationChanged',
    generation: start.state.generation,
    animation: { name: 'sleep-loop', once: false, src: null },
  }, options)
  assert.equal(held.state.status, 'holding-loop')
  assert.deepEqual(held.effects, [])
})

test('播放器：顺序动作最后一段非 loop 时恢复稳态', () => {
  const action = { id: 'wake', label: '起来', seq: ['sit', 'stand'], loop: false, group: '休息' }
  const options: controller.PlaybackContext = { actions: [action], steady: 'thinking', now: 10 }
  const start = controller.reducePlayback(null, { type: 'startAction', actionId: 'wake' }, options)
  const firstTarget = controller.reducePlayback(start.state, {
    type: 'animationChanged', generation: start.state.generation,
    animation: { name: 'sit', once: true },
  }, options)
  const secondStarted = controller.reducePlayback(firstTarget.state, {
    type: 'animationChanged', generation: start.state.generation,
    animation: { name: 'idle-file', once: false },
  }, options)
  const secondTarget = controller.reducePlayback(secondStarted.state, {
    type: 'animationChanged', generation: start.state.generation,
    animation: { name: 'stand', once: true },
  }, options)
  const ended = controller.reducePlayback(secondTarget.state, {
    type: 'animationChanged', generation: start.state.generation,
    animation: { name: 'idle-file', once: false },
  }, options)

  assert.equal(ended.state.status, 'restoring')
  assert.deepEqual(ended.effects, [
    { type: 'clear-motion' },
    { type: 'restore-slot', slot: 'waving', steady: 'thinking' },
  ])
})

test('播放器：新动作抢占并递增 generation，旧回调不能覆盖新动作', () => {
  const first = { id: 'first', label: '第一段', anim: 'first-file', loop: false, group: '测试' }
  const second = { id: 'second', label: '第二段', anim: 'second-file', loop: true, group: '测试' }
  const options = { actions: [first, second], steady: 'idle' as const, now: 10 }
  const started = controller.reducePlayback(null, { type: 'startAction', actionId: 'first' }, options)
  const steady = controller.reducePlayback(started.state, {
    type: 'steadyChanged', steady: 'working',
  }, { ...options, steady: 'working', now: 20 })
  const preempted = controller.reducePlayback(steady.state, {
    type: 'startAction', actionId: 'second',
  }, { ...options, steady: 'working', now: 30 })

  assert.equal(preempted.state.status, 'holding-loop')
  assert.equal(preempted.state.actionId, 'second')
  assert.equal(preempted.state.generation, started.state.generation + 1)
  assert.equal(preempted.state.steady, 'working')
  assert.deepEqual(preempted.effects, [
    { type: 'clear-motion' },
    { type: 'bind-slot', slot: 'waving', animation: 'second-file' },
    { type: 'play-motion', motion: 'waving', loop: true, replay: true },
  ])

  const stale = controller.reducePlayback(preempted.state, {
    type: 'animationChanged',
    generation: started.state.generation,
    animation: { name: 'idle-file', once: false },
  }, { ...options, steady: 'working', now: 40 })
  assert.deepEqual(stale.state, preempted.state)
  assert.deepEqual(stale.effects, [])

  const staleRestore = controller.reducePlayback(preempted.state, {
    type: 'motionChanged',
    generation: started.state.generation,
    motion: 'idle',
  }, { ...options, steady: 'working', now: 50 })
  assert.deepEqual(staleRestore.state, preempted.state)
  assert.deepEqual(staleRestore.effects, [])
})

test('播放器：stop 使用最新 steady，当前 generation 的恢复回调回到 idle', () => {
  const action = { id: 'loop', label: '循环', anim: 'loop-file', loop: true, group: '测试' }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const started = controller.reducePlayback(null, { type: 'startAction', actionId: 'loop' }, options)
  const steady = controller.reducePlayback(started.state, {
    type: 'steadyChanged', steady: 'success',
  }, { ...options, steady: 'success', now: 20 })
  const stopped = controller.reducePlayback(steady.state, { type: 'stopAction' }, {
    ...options,
    steady: 'success',
    now: 30,
  })

  assert.equal(stopped.state.status, 'restoring')
  assert.equal(stopped.state.steady, 'success')
  assert.ok(stopped.state.generation > started.state.generation)
  assert.deepEqual(stopped.effects, [
    { type: 'clear-motion' },
    { type: 'restore-slot', slot: 'waving', steady: 'success' },
  ])

  const restored = controller.reducePlayback(stopped.state, {
    type: 'motionChanged', generation: stopped.state.generation, motion: 'success',
  }, { ...options, steady: 'success', now: 40 })
  assert.equal(restored.state.status, 'idle')
})

test('播放器：拖动和 skin 切换抢占动作并保留最新 steady', () => {
  const action = { id: 'loop', label: '循环', anim: 'loop-file', loop: true, group: '测试' }
  const baseOptions = { actions: [action], steady: 'idle' as const, now: 10 }

  for (const event of [{ type: 'dragStarted' as const }, { type: 'skinChanged' as const }]) {
    const started = controller.reducePlayback(null, { type: 'startAction', actionId: 'loop' }, baseOptions)
    const steady = controller.reducePlayback(started.state, {
      type: 'steadyChanged', steady: 'waiting',
    }, { ...baseOptions, steady: 'waiting', now: 20 })
    const interrupted = controller.reducePlayback(steady.state, event, {
      ...baseOptions,
      steady: 'waiting',
      now: 30,
    })

    assert.equal(interrupted.state.status, 'restoring')
    assert.equal(interrupted.state.steady, 'waiting')
    assert.deepEqual(interrupted.effects, [
      { type: 'clear-motion' },
      { type: 'restore-slot', slot: 'waving', steady: 'waiting' },
    ])
  }
})

test('播放器：animationChanged 只在目标动画 once:true 出现后认可结束', () => {
  const action = { id: 'once', label: '一次', anim: 'once-file', loop: false, group: '测试' }
  const options = { actions: [action], steady: 'idle' as const, now: 10 }
  const started = controller.reducePlayback(null, { type: 'startAction', actionId: 'once' }, options)

  const notOnce = controller.reducePlayback(started.state, {
    type: 'animationChanged', generation: started.state.generation,
    animation: { name: 'once-file', once: false },
  }, options)
  const prematureFallback = controller.reducePlayback(notOnce.state, {
    type: 'animationChanged', generation: started.state.generation,
    animation: { name: 'idle-file', once: false },
  }, options)
  assert.equal(prematureFallback.state.status, 'playing-once')
  assert.equal(prematureFallback.state.targetSeen, false)

  const target = controller.reducePlayback(prematureFallback.state, {
    type: 'animationChanged', generation: started.state.generation,
    animation: { name: 'once-file', once: true },
  }, options)
  assert.equal(target.state.targetSeen, true)

  const endedByMotion = controller.reducePlayback(target.state, {
    type: 'motionChanged', generation: started.state.generation, motion: 'idle',
  }, options)
  assert.equal(endedByMotion.state.status, 'restoring')
  assert.deepEqual(endedByMotion.effects, [
    { type: 'clear-motion' },
    { type: 'restore-slot', slot: 'waving', steady: 'idle' },
  ])
})
