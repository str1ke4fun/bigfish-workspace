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

test('cue 使用环形缓冲且按 id 去重', () => {
  const pv = createPetView({ now: () => 1000 })

  for (let i = 1; i <= 9; i += 1) {
    assert.equal(pv.noteCue({ id: `cue-${i}`, kind: 'speak', text: `第 ${i} 条`, at: 1000, ttlMs: 60_000 }), true)
  }
  assert.equal(pv.noteCue({ id: 'cue-9', kind: 'speak', text: '重复事件', at: 1000, ttlMs: 60_000 }), false)

  const cues = pv.snapshot().cues
  assert.deepEqual(cues.map((cue) => cue.id), [
    'cue-2', 'cue-3', 'cue-4', 'cue-5', 'cue-6', 'cue-7', 'cue-8', 'cue-9',
  ])
  assert.equal(new Set(cues.map((cue) => cue.id)).size, 8)
})

test('cue 按各自 TTL 过期且文本最多 120 字', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })

  assert.equal(pv.noteCue({ id: 'cue-long', kind: 'replied', text: '啊'.repeat(121), at: 1000, ttlMs: 5000 }), true)
  t = 5999
  const cue = pv.snapshot().cues[0]
  assert.equal(cue.text.length, 120)
  assert.equal(cue.kind, 'replied')
  assert.equal(cue.at, 1000)
  assert.equal(cue.ttlMs, 5000)

  t = 6000
  assert.deepEqual(pv.snapshot().cues, [])
})

test('scene 由日程和手动覆盖决定，出门优先于休息', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })

  assert.equal(pv.snapshot().scene, null)
  assert.equal(pv.setScheduleRest({ rest: true, at: 900 }), true)
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 900 })

  t = 1100
  pv.setRestOverride('wake')
  assert.equal(pv.snapshot().scene, null)

  t = 1200
  pv.setRestOverride('sleep')
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 1200 })

  t = 1300
  pv.setOuting({ active: true, at: 1250 })
  assert.deepEqual(pv.snapshot().scene, { kind: 'out', at: 1250 })
  pv.setRestOverride('wake')
  assert.deepEqual(pv.snapshot().scene, { kind: 'out', at: 1250 })

  t = 1400
  pv.setOuting({ active: false, at: 1350 })
  assert.equal(pv.snapshot().scene, null)
  pv.setRestOverride('auto')
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 900 })
})

test('日程下一次 tick 会清除手动休息覆盖', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  pv.setScheduleRest({ rest: true, at: 900 })

  pv.setRestOverride('wake')
  assert.equal(pv.snapshot().scene, null)

  t = 2000
  pv.setScheduleRest({ rest: true, at: 2000 })
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 2000 })

  pv.setRestOverride('sleep')
  assert.equal(pv.snapshot().scene.kind, 'rest')
  t = 3000
  pv.setScheduleRest({ rest: false, at: 3000 })
  assert.equal(pv.snapshot().scene, null)
})

test('awake 长唤醒：跨过日程 tick、12 小时到期、显式结束', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  pv.setScheduleRest({ rest: true, at: 900 })
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 900 })

  t = 2000
  assert.equal(pv.setRestOverride('awake'), true)
  assert.equal(pv.snapshot().scene, null)
  const until = pv.snapshot().awakeUntil
  assert.equal(until, 2000 + 12 * 60 * 60 * 1000)

  // 日程 tick 不再收回
  t = 62_000
  pv.setScheduleRest({ rest: true, at: 62_000 })
  assert.equal(pv.snapshot().scene, null)
  assert.equal(pv.snapshot().awakeUntil, until)

  // 出门仍优先
  pv.setOuting({ active: true, at: 63_000 })
  assert.equal(pv.snapshot().scene.kind, 'out')
  pv.setOuting({ active: false, at: 64_000 })
  assert.equal(pv.snapshot().scene, null)

  // 显式 sleep 结束长唤醒
  t = 65_000
  pv.setRestOverride('sleep')
  assert.equal(pv.snapshot().awakeUntil, null)
  assert.equal(pv.snapshot().scene.kind, 'rest')

  // wake / auto 也会清掉长唤醒
  t = 66_000
  pv.setRestOverride('awake')
  t = 67_000
  pv.setRestOverride('wake')
  assert.equal(pv.snapshot().awakeUntil, null)
  t = 68_000
  pv.setRestOverride('awake')
  t = 69_000
  pv.setRestOverride('auto')
  assert.equal(pv.snapshot().awakeUntil, null)

  // 重新 awake，到期自动回日程
  t = 70_000
  pv.setRestOverride('awake')
  t = 70_000 + 12 * 60 * 60 * 1000
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 62_000 })
  assert.equal(pv.snapshot().awakeUntil, null)
})

test('hello 动作目录按 id 去重、排序并截断 256 条', () => {
  const pv = createPetView({ now: () => 1000 })
  const actions = []
  for (let i = 256; i >= 0; i -= 1) {
    const id = `action-${String(i).padStart(3, '0')}`
    actions.push({ id, label: `动作 ${i}`, group: '测试' })
  }
  // 后出现的同 id 条目覆盖前一条，且不应额外占用目录名额。
  actions.push({ id: 'action-127', label: '更新后的动作', group: '更新组' })

  pv.noteHello({ actions })

  assert.equal(pv.act({ action: 'action-000' }).ok, true)
  assert.equal(pv.act({ action: 'action-255' }).ok, true)
  assert.equal(pv.act({ action: 'action-256' }).ok, false)
})

test('合法 action 生成 action 事件', () => {
  const pv = createPetView({ now: () => 1000 })
  pv.noteHello({ actions: [{ id: 'wave', label: '挥手', group: '回应' }] })

  const r = pv.act({ action: 'wave', text: ' 你好 ', ttlMs: 10 })

  assert.equal(r.ok, true)
  assert.equal(typeof r.action.id, 'string')
  assert.equal(r.action.action, 'wave')
  assert.equal(r.action.motion, undefined)
  assert.equal(r.action.text, '你好')
  assert.equal(r.action.at, 1000)
  assert.equal(r.action.ttlMs, 1000)
  assert.deepEqual(pv.snapshot().action, r.action)
})

test('未知 action 失败且不覆盖旧 action', () => {
  const pv = createPetView({ now: () => 1000 })
  pv.noteHello({ actions: [{ id: 'wave', label: '挥手', group: '回应' }] })
  const current = pv.act({ action: 'wave' }).action

  const r = pv.act({ action: 'missing' })

  assert.equal(r.ok, false)
  assert.deepEqual(pv.snapshot().action, current)
})

test('最新的 hello 动作目录生效，缺省或非法 actions 清空旧目录', () => {
  const pv = createPetView({ now: () => 1000 })
  pv.noteHello({ actions: [{ id: 'old', label: '旧动作', group: '测试' }] })
  pv.noteHello({ actions: [{ id: 'new', label: '新动作', group: '测试' }] })

  assert.equal(pv.act({ action: 'old' }).ok, false)
  assert.equal(pv.act({ action: 'new' }).ok, true)

  pv.noteHello({ version: '0.1.1' })
  assert.equal(pv.act({ action: 'new' }).ok, false)

  pv.noteHello({ actions: [{ id: 'new', label: '新动作', group: '测试' }] })
  assert.equal(pv.act({ action: 'new' }).ok, true)

  pv.noteHello({ actions: { id: 'new', label: '新动作', group: '测试' } })
  assert.equal(pv.act({ action: 'new' }).ok, false)
})

test('snapshot 暴露最近 hello 的已校验动作目录', () => {
  const pv = createPetView({ now: () => 1000 })
  pv.noteHello({ actions: [
    { id: 'z-wave', label: ' 挥手 ', group: ' 回应 ' },
    { id: 'a-rest', label: '睡觉', group: '休息' },
    { id: 'invalid id', label: '忽略', group: '其他' },
  ] })

  assert.deepEqual(pv.snapshot().actions, [
    { id: 'a-rest', label: '睡觉', group: '休息' },
    { id: 'z-wave', label: '挥手', group: '回应' },
  ])
})

test('action 请求与 motion 请求必须二选一', () => {
  const pv = createPetView({ now: () => 1000 })
  pv.noteHello({ actions: [{ id: 'wave', label: '挥手', group: '回应' }] })

  assert.equal(pv.act({}).ok, false)
  assert.equal(pv.act({ motion: 'success', action: 'wave' }).ok, false)
  assert.equal(pv.act({ motion: 'success' }).ok, true)
  assert.equal(pv.act({ action: 'wave' }).ok, true)
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

test('心跳与轮询是易失的；online 只看 hello', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  assert.equal(pv.snapshot().helloAt, null)
  pv.noteHello({ version: '0.1.0', skins: [{ id: '', name: '默认' }] })
  pv.markPolled()
  assert.equal(pv.snapshot().version, '0.1.0')
  assert.equal(pv.snapshot().skins.length, 1)
  assert.equal(pv.snapshot().lastPollAt, 1000)
  assert.equal(pv.snapshot().helloAt, 1000)
  t += 91_000
  assert.equal(pv.snapshot().helloAt, 1000, 'hello 时间戳不随轮询刷新')
})

test('MOTIONS 白名单与 dsh-pet-component 一致', () => {
  assert.deepEqual(PET_MOTIONS, [
    'idle', 'turn', 'moving-left', 'moving-right', 'waving',
    'thinking', 'working', 'result', 'waiting', 'running',
    'review', 'failed', 'success', 'error',
  ])
  assert.equal(PET_ACTION_MOTIONS.includes('dragging'), false)
})
