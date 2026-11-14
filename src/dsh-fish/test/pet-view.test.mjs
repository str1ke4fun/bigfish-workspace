import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PET_MOTIONS, PET_ACTION_MOTIONS, reduceActivity, pickActivity,
  createPetView, petSurfaceAllowed, ACTIVITY_TTL_MS,
} from '../lib/pet-view.js'

test('六档映射与清空语义', () => {
  assert.equal(reduceActivity({ type: 'turn/start' }), 'thinking')
  assert.equal(reduceActivity({ type: 'tool/call', data: { name: 'read_image' } }), 'working')
  assert.equal(reduceActivity({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting')
  assert.equal(reduceActivity({ type: 'tool/result' }), 'result')
  assert.equal(reduceActivity({ type: 'approval/asked' }), 'waiting')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'success')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'error')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), 'error')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), 'waiting')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null)
  assert.equal(reduceActivity({ type: 'meta', text: 'x' }), undefined)
})

test('优先级与同档最近', () => {
  const entries = [
    { state: 'success', at: 1, seq: 1, sessionId: 'a' },
    { state: 'thinking', at: 2, seq: 2, sessionId: 'b' },
    { state: 'working', at: 3, seq: 3, sessionId: 'c' },
    { state: 'working', at: 4, seq: 4, sessionId: 'd' },
  ]
  assert.equal(pickActivity(entries).sessionId, 'd')
  assert.equal(pickActivity([{ state: 'waiting', at: 1, seq: 1, sessionId: 'x' }]).state, 'waiting')
})

test('只接受 web/screen', () => {
  assert.equal(petSurfaceAllowed('web'), true)
  assert.equal(petSurfaceAllowed('screen'), true)
  assert.equal(petSurfaceAllowed('bili'), false)
  assert.equal(petSurfaceAllowed('wx'), false)
  assert.equal(petSurfaceAllowed(''), false)
})

test('动作槽校验、覆盖与过期', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  assert.equal(pv.act({ motion: 'nope' }).ok, false)
  assert.equal(pv.act({ motion: 'waving', text: 'x'.repeat(121) }).ok, false)
  assert.equal(pv.act({ motion: 'waving', ttlMs: 10 }).action.ttlMs, 1000)
  const a = pv.act({ motion: 'waving', text: ' 你好 ' }).action
  assert.equal(a.text, '你好')
  assert.equal(pv.snapshot().action.id, a.id)
  t += 1000
  const b = pv.act({ motion: 'success' }).action
  assert.notEqual(b.id, a.id)
  assert.equal(pv.snapshot().action.motion, 'success')
  t += 60_000
  assert.equal(pv.snapshot().action, null)
})

test('noteSessionEvent 忽略非她面/非六档事件', () => {
  const pv = createPetView({ now: () => 1 })
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'bili' }, { type: 'turn/start' }), false)
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'meta' }), false)
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'turn/start' }), true)
  assert.equal(pv.snapshot().activity.state, 'thinking')
  pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(pv.snapshot().activity, null)
})

test('过期条目从快照剔除：旧 error 不永久压住当前 working', () => {
  let t = 0
  const pv = createPetView({ now: () => t })
  pv.noteSessionEvent({ sessionId: 'old-screen', surface: 'screen' },
    { type: 'turn/end', data: { reason: { kind: 'error' } } })
  t = 1000
  pv.noteSessionEvent({ sessionId: 'current-web', surface: 'web' },
    { type: 'tool/call', data: { name: 'read_image' } })
  // 未过期时高阶状态仍按优先级优先。
  assert.equal(pv.snapshot().activity.sessionId, 'old-screen')
  // error 过期后旧会话被剔除，当前 working 回来。
  t = 1000 + ACTIVITY_TTL_MS.error
  const snap = pv.snapshot()
  assert.equal(snap.activity.state, 'working')
  assert.equal(snap.activity.sessionId, 'current-web')
})

test('过期 waiting 不再压住当前 working', () => {
  let t = 0
  const pv = createPetView({ now: () => t })
  pv.noteSessionEvent({ sessionId: 'old-screen', surface: 'screen' },
    { type: 'approval/asked' })
  t = 1000
  pv.noteSessionEvent({ sessionId: 'current-web', surface: 'web' },
    { type: 'tool/call', data: { name: 'read_image' } })
  assert.equal(pv.snapshot().activity.sessionId, 'old-screen')
  t = 1000 + ACTIVITY_TTL_MS.waiting
  const snap = pv.snapshot()
  assert.equal(snap.activity.state, 'working')
  assert.equal(snap.activity.sessionId, 'current-web')
})

test('活跃档位 TTL 长于 waiting，终态最短', () => {
  assert.ok(ACTIVITY_TTL_MS.working > ACTIVITY_TTL_MS.waiting)
  assert.ok(ACTIVITY_TTL_MS.thinking >= ACTIVITY_TTL_MS.working)
  assert.ok(ACTIVITY_TTL_MS.result >= ACTIVITY_TTL_MS.working)
  assert.ok(ACTIVITY_TTL_MS.waiting > ACTIVITY_TTL_MS.error)
  assert.equal(ACTIVITY_TTL_MS.success, ACTIVITY_TTL_MS.error)
})

test('MOTIONS 白名单与 dsh-pet-component 一致', () => {
  assert.deepEqual(PET_MOTIONS, [
    'idle', 'turn', 'moving-left', 'moving-right', 'waving',
    'thinking', 'working', 'result', 'waiting', 'running',
    'review', 'failed', 'success', 'error',
  ])
  assert.equal(PET_ACTION_MOTIONS.includes('dragging'), false)
})
