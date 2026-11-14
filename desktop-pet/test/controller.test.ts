import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideEffects, emptySeen, performedMotion } from '../renderer/controller.ts'

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
