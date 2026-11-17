import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PetState, PlaybackAction } from '../renderer/controller.ts'
import {
  emptyTriggerSeen,
  reduceTriggers,
  type TriggerDefinition,
} from '../renderer/trigger-engine.ts'

function action(id: string, loop = false): PlaybackAction {
  return { id, label: id, anim: `${id}-file`, loop, group: '测试' }
}

function trigger(
  when: string,
  pool: string[],
  w: number[] = pool.map(() => 1),
  overrides: Partial<Pick<TriggerDefinition, 'once' | 'minGapSec' | 'inAmbient'>> = {},
): TriggerDefinition {
  return { when, pool, w, once: false, minGapSec: 0, inAmbient: false, ...overrides }
}

function state(overrides: Partial<PetState> = {}): PetState {
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

test('cue 优先于 waiting，并强制一次性播放和原话气泡', () => {
  const current = state({
    scene: { kind: 'rest', at: 1 },
    activity: { state: 'waiting', at: 1, sessionId: 's' },
    cues: [{ id: 'cue-1', kind: 'speak', text: '她刚说的话', at: 1000, ttlMs: 15_000 }],
  })
  const result = reduceTriggers({
    state: current,
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('activity:waiting', ['waiting-loop']),
      trigger('speak', ['cue-loop']),
    ],
    actions: [action('rest-loop', true), action('waiting-loop', true), action('cue-loop', true)],
    seen: emptyTriggerSeen(),
    now: 2000,
    manualBusy: false,
    rng: () => 0,
  })

  assert.deepEqual(result.action, { type: 'startAction', actionId: 'cue-loop', loop: false })
  assert.deepEqual(result.bubble, { id: 'cue-1', text: '她刚说的话' })
  assert.equal(result.steady, 'waiting')
  assert.ok(result.seen.cueIds.includes('cue-1'))
  assert.equal(result.seen.lastSceneKind, null)
})

test('activity transition 只触发一次，loop 动作也被强制一次性', () => {
  const current = state({ activity: { state: 'working', at: 10, sessionId: 's' } })
  const input = {
    state: current,
    triggers: [trigger('activity:working', ['working-loop'])],
    actions: [action('working-loop', true)],
    seen: emptyTriggerSeen(),
    now: 20,
    manualBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers(input)
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'working-loop', loop: false })
  assert.equal(first.steady, 'working')

  const second = reduceTriggers({ ...input, seen: first.seen })
  assert.equal(second.action, undefined)
})

test('scene transition 优先于其他 activity，scene enter 可保持 loop', () => {
  const current = state({
    scene: { kind: 'rest', at: 30 },
    activity: { state: 'working', at: 31, sessionId: 's' },
  })
  const input = {
    state: current,
    triggers: [
      trigger('activity:working', ['activity-loop']),
      trigger('scene:rest:enter', ['rest-loop']),
    ],
    actions: [action('activity-loop', true), action('rest-loop', true)],
    seen: emptyTriggerSeen(),
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers(input)
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'rest-loop', loop: true })
  assert.equal(first.steady, 'idle')
  assert.equal(first.seen.lastSceneKind, 'rest')
  assert.equal(first.seen.lastActivityState, 'working')
  assert.equal(first.seen.sceneLoopActionId, 'rest-loop')
  assert.equal(first.seen.sceneLoopActive, true)

  const second = reduceTriggers({ ...input, seen: first.seen })
  assert.equal(second.action, undefined)
})

test('waiting 动作完成后才恢复 scene loop', () => {
  const sceneOnly = state({ scene: { kind: 'rest', at: 30 } })
  const input = {
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('activity:waiting', ['waiting-once']),
    ],
    actions: [action('rest-loop', true), action('waiting-once', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...input, state: sceneOnly, seen: emptyTriggerSeen() })
  assert.deepEqual(entered.action, { type: 'startAction', actionId: 'rest-loop', loop: true })

  const waiting = reduceTriggers({
    ...input,
    state: { ...sceneOnly, activity: { state: 'waiting', at: 41, sessionId: 's' } },
    seen: entered.seen,
  })
  assert.deepEqual(waiting.action, { type: 'startAction', actionId: 'waiting-once', loop: false })
  assert.equal(waiting.steady, 'waiting')
  assert.equal(waiting.seen.lastActivityState, 'waiting')
  assert.equal(waiting.seen.sceneLoopActive, false)
  assert.equal(waiting.seen.sceneLoopActionId, 'rest-loop')

  const busy = reduceTriggers({
    ...input,
    state: sceneOnly,
    seen: waiting.seen,
    actionBusy: true,
  })
  assert.equal(busy.action, undefined)
  assert.equal(busy.seen.sceneLoopActive, false)

  const resumed = reduceTriggers({
    ...input,
    state: sceneOnly,
    seen: busy.seen,
    actionBusy: false,
  })
  assert.deepEqual(resumed.action, { type: 'startAction', actionId: 'rest-loop', loop: true })
  assert.equal(resumed.steady, 'idle')
  assert.equal(resumed.seen.sceneLoopActive, true)
})

test('rest 中 cue 只覆盖一次性动作，不改变 scene，完成后恢复 scene loop', () => {
  const resting = state({ scene: { kind: 'rest', at: 30 } })
  const input = {
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('speak', ['cue-once']),
    ],
    actions: [action('rest-loop', true), action('cue-once', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...input, state: resting, seen: emptyTriggerSeen() })
  const overlaid = reduceTriggers({
    ...input,
    state: {
      ...resting,
      cues: [{ id: 'cue-rest', kind: 'speak', text: '醒着说一句', at: 41, ttlMs: 15_000 }],
    },
    seen: entered.seen,
  })

  assert.equal(overlaid.steady, 'idle')
  assert.deepEqual(overlaid.action, { type: 'startAction', actionId: 'cue-once', loop: false })
  assert.deepEqual(overlaid.bubble, { id: 'cue-rest', text: '醒着说一句' })
  assert.equal(overlaid.seen.lastSceneKind, 'rest')
  assert.equal(overlaid.seen.sceneLoopActionId, 'rest-loop')
  assert.equal(overlaid.seen.sceneLoopActive, false)

  const busy = reduceTriggers({
    ...input,
    state: resting,
    seen: overlaid.seen,
    actionBusy: true,
  })
  assert.equal(busy.action, undefined)
  assert.equal(busy.bubble, undefined)
  assert.equal(busy.seen.sceneLoopActive, false)

  const resumed = reduceTriggers({
    ...input,
    state: resting,
    seen: busy.seen,
    actionBusy: false,
  })
  assert.deepEqual(resumed.action, { type: 'startAction', actionId: 'rest-loop', loop: true })
  assert.equal(resumed.steady, 'idle')
})

test('manual/cue 高于 activity 和 presence', () => {
  const presence = {
    on: true,
    mode: 'event',
    busy: false,
    snapshot: null,
    recent: [],
  }
  const current = state({
    activity: { state: 'working', at: 10, sessionId: 's' },
    presence,
    cues: [{ id: 'cue-priority', kind: 'speak', text: '先说这句', at: 20, ttlMs: 15_000 }],
  })
  const input = {
    state: current,
    triggers: [
      trigger('activity:working', ['activity-once']),
      trigger('speak', ['cue-once']),
      trigger('ambient', ['ambient-once']),
    ],
    actions: [action('activity-once'), action('cue-once'), action('ambient-once')],
    now: 30,
    actionBusy: false,
    rng: () => 0,
  }

  const manual = reduceTriggers({
    ...input,
    seen: emptyTriggerSeen(),
    manualBusy: true,
  })
  assert.equal(manual.action, undefined)
  assert.equal(manual.bubble, undefined)
  assert.equal(manual.steady, 'working')
  assert.equal(manual.seen.cueIds.includes('cue-priority'), false)

  const cued = reduceTriggers({
    ...input,
    seen: manual.seen,
    manualBusy: false,
  })
  assert.deepEqual(cued.action, { type: 'startAction', actionId: 'cue-once', loop: false })
  assert.deepEqual(cued.bubble, { id: 'cue-priority', text: '先说这句' })
  assert.equal(cued.steady, 'working')
})

test('同一 cue id 不会产生第二次动作或气泡', () => {
  const current = state({
    cues: [{ id: 'cue-duplicate', kind: 'speak', text: '只说一次', at: 20, ttlMs: 15_000 }],
  })
  const input = {
    state: current,
    triggers: [trigger('speak', ['cue-once'])],
    actions: [action('cue-once')],
    now: 30,
    manualBusy: false,
    actionBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers({ ...input, seen: emptyTriggerSeen() })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'cue-once', loop: false })
  assert.deepEqual(first.bubble, { id: 'cue-duplicate', text: '只说一次' })

  const second = reduceTriggers({ ...input, seen: first.seen })
  assert.equal(second.action, undefined)
  assert.equal(second.bubble, undefined)
})

test('scene exit 只唤醒一次，循环定义也按一次性退出动作播放', () => {
  const resting = state({ scene: { kind: 'rest', at: 30 } })
  const input = {
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('scene:rest:exit', ['wake-loop']),
    ],
    actions: [action('rest-loop', true), action('wake-loop', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...input, state: resting, seen: emptyTriggerSeen() })
  const woke = reduceTriggers({ ...input, state: state(), seen: entered.seen })
  assert.deepEqual(woke.action, { type: 'startAction', actionId: 'wake-loop', loop: false })
  assert.equal(woke.steady, 'idle')
  assert.equal(woke.seen.lastSceneKind, null)
  assert.equal(woke.seen.sceneLoopActionId, null)
  assert.equal(woke.seen.sceneLoopActive, false)

  const settled = reduceTriggers({ ...input, state: state(), seen: woke.seen })
  assert.equal(settled.action, undefined)
})

test('manualBusy 压住 cue 和 scene loop，手动结束后再消费同一 cue', () => {
  const resting = state({ scene: { kind: 'rest', at: 30 } })
  const baseInput = {
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('speak', ['cue-once']),
    ],
    actions: [action('rest-loop', true), action('cue-once', true)],
    now: 40,
    rng: () => 0,
  }
  const entered = reduceTriggers({
    ...baseInput,
    state: resting,
    seen: emptyTriggerSeen(),
    manualBusy: false,
  })
  const cuedState = {
    ...resting,
    cues: [{ id: 'cue-manual', kind: 'speak' as const, text: '稍后再说', at: 41, ttlMs: 15_000 }],
  }

  const manual = reduceTriggers({
    ...baseInput,
    state: cuedState,
    seen: entered.seen,
    manualBusy: true,
  })
  assert.equal(manual.action, undefined)
  assert.equal(manual.bubble, undefined)
  assert.equal(manual.seen.sceneLoopActive, false)
  assert.equal(manual.seen.cueIds.includes('cue-manual'), false)

  const after = reduceTriggers({
    ...baseInput,
    state: cuedState,
    seen: manual.seen,
    manualBusy: false,
  })
  assert.deepEqual(after.action, { type: 'startAction', actionId: 'cue-once', loop: false })
  assert.deepEqual(after.bubble, { id: 'cue-manual', text: '稍后再说' })
})

test('waiting 已激活时 scene transition 保持待处理，waiting 结束后再进入', () => {
  const waitingScene = state({
    scene: { kind: 'rest', at: 30 },
    activity: { state: 'waiting', at: 31, sessionId: 's' },
  })
  const input = {
    triggers: [
      trigger('scene:rest:enter', ['rest-loop']),
      trigger('activity:waiting', ['waiting-once']),
    ],
    actions: [action('rest-loop', true), action('waiting-once', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers({ ...input, state: waitingScene, seen: emptyTriggerSeen() })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'waiting-once', loop: false })
  assert.equal(first.seen.lastSceneKind, null)

  const stillWaiting = reduceTriggers({ ...input, state: waitingScene, seen: first.seen })
  assert.equal(stillWaiting.action, undefined)
  assert.equal(stillWaiting.seen.lastSceneKind, null)

  const entered = reduceTriggers({
    ...input,
    state: state({ scene: waitingScene.scene }),
    seen: stillWaiting.seen,
  })
  assert.deepEqual(entered.action, { type: 'startAction', actionId: 'rest-loop', loop: true })
  assert.equal(entered.seen.lastSceneKind, 'rest')
})

test('presence 高于 idle/ambient；ambient 只在进入空闲后按权重播放一次', () => {
  const idle = state()
  const presence = {
    on: true,
    mode: 'event',
    busy: false,
    snapshot: null,
    recent: [],
  }
  const baseInput = {
    triggers: [trigger('ambient', ['ambient-a', 'ambient-b'], [3, 1])],
    actions: [action('ambient-a', true), action('ambient-b', true)],
    now: 40,
    manualBusy: false,
  }

  const first = reduceTriggers({ ...baseInput, state: idle, seen: emptyTriggerSeen(), rng: () => 0 })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'ambient-a', loop: false })
  assert.equal(first.steady, 'idle')
  assert.equal(first.seen.ambientConsumed, true)

  const stillIdle = reduceTriggers({ ...baseInput, state: idle, seen: first.seen, rng: () => 0.75 })
  assert.equal(stillIdle.action, undefined)

  const present = reduceTriggers({
    ...baseInput,
    state: { ...idle, presence },
    seen: stillIdle.seen,
    rng: () => 0.75,
  })
  assert.equal(present.action, undefined)
  assert.equal(present.steady, 'thinking')
  assert.equal(present.seen.ambientConsumed, false)

  const idleAgain = reduceTriggers({
    ...baseInput,
    state: idle,
    seen: present.seen,
    rng: () => 0.75,
  })
  assert.deepEqual(idleAgain.action, { type: 'startAction', actionId: 'ambient-b', loop: false })
})

test('ambient 被 activity 打断后重新武装，且 activity 高于 ambient', () => {
  const idle = state()
  const working = state({ activity: { state: 'working', at: 10, sessionId: 's' } })
  const input = {
    triggers: [
      trigger('activity:working', ['activity-once']),
      trigger('ambient', ['ambient-once']),
    ],
    actions: [action('activity-once'), action('ambient-once')],
    now: 40,
    manualBusy: false,
    actionBusy: false,
    rng: () => 0,
  }

  const firstAmbient = reduceTriggers({ ...input, state: idle, seen: emptyTriggerSeen() })
  assert.deepEqual(firstAmbient.action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
  assert.equal(firstAmbient.seen.ambientConsumed, true)

  const activity = reduceTriggers({ ...input, state: working, seen: firstAmbient.seen })
  assert.deepEqual(activity.action, {
    type: 'startAction', actionId: 'activity-once', loop: false,
  })
  assert.equal(activity.seen.ambientConsumed, false)

  const secondAmbient = reduceTriggers({ ...input, state: idle, seen: activity.seen })
  assert.deepEqual(secondAmbient.action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
})

test('idle cue 播放完成后重新武装 ambient', () => {
  const idle = state()
  const cue = {
    id: 'cue-fresh',
    kind: 'speak' as const,
    text: '过来说一句',
    at: 100,
    ttlMs: 15_000,
  }
  const input = {
    triggers: [
      trigger('speak', ['cue-once']),
      trigger('ambient', ['ambient-once']),
    ],
    actions: [action('cue-once'), action('ambient-once')],
    now: 200,
    manualBusy: false,
    rng: () => 0,
  }

  const firstAmbient = reduceTriggers({ ...input, state: idle, seen: emptyTriggerSeen() })
  assert.deepEqual(firstAmbient.action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
  assert.equal(firstAmbient.seen.ambientConsumed, true)

  const queued = reduceTriggers({
    ...input,
    state: { ...idle, cues: [cue] },
    seen: firstAmbient.seen,
    actionBusy: true,
  })
  assert.equal(queued.action, undefined)
  assert.equal(queued.seen.ambientConsumed, true)

  const cued = reduceTriggers({
    ...input,
    state: { ...idle, cues: [cue] },
    seen: queued.seen,
    actionBusy: false,
  })
  assert.deepEqual(cued.action, { type: 'startAction', actionId: 'cue-once', loop: false })
  assert.deepEqual(cued.bubble, { id: 'cue-fresh', text: '过来说一句' })
  assert.equal(cued.seen.ambientConsumed, false)

  const cueBusy = reduceTriggers({
    ...input,
    state: { ...idle, cues: [cue] },
    seen: cued.seen,
    actionBusy: true,
  })
  assert.equal(cueBusy.action, undefined)

  const completed = reduceTriggers({
    ...input,
    state: { ...idle, cues: [cue] },
    seen: cueBusy.seen,
    actionBusy: false,
  })
  assert.deepEqual(completed.action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
  assert.equal(completed.steady, 'idle')
})

test('过期 cue 不播放、不阻塞 ambient，并记入有界已消费游标', () => {
  const current = state({
    cues: [{ id: 'cue-stale', kind: 'speak', text: '早就过期', at: 1000, ttlMs: 1000 }],
  })
  const result = reduceTriggers({
    state: current,
    triggers: [
      trigger('speak', ['cue-once']),
      trigger('ambient', ['ambient-once']),
    ],
    actions: [action('cue-once'), action('ambient-once')],
    seen: emptyTriggerSeen(),
    now: 5000,
    manualBusy: false,
    rng: () => 0,
  })

  assert.equal(result.bubble, undefined)
  assert.deepEqual(result.action, { type: 'startAction', actionId: 'ambient-once', loop: false })
  assert.ok(result.seen.cueIds.includes('cue-stale'))
})

test('date 按本地 MM-DD 每天只播一次，同日不重播、跨日与跨年重新计算', () => {
  const localNoon = (year: number, month: number, day: number, hour = 12): number =>
    new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
  const triggers = [
    trigger('date:12-25', ['xmas-loop'], [1], { inAmbient: true }),
    trigger('date:12-26', ['boxing-loop'], [1], { inAmbient: true }),
  ]
  const actions = [action('xmas-loop', true), action('boxing-loop', true)]
  const base = { triggers, actions, manualBusy: false, rng: () => 0 }

  const xmas = reduceTriggers({
    ...base,
    state: state(),
    seen: emptyTriggerSeen(),
    now: localNoon(2026, 12, 25),
  })
  assert.deepEqual(xmas.action, { type: 'startAction', actionId: 'xmas-loop', loop: false })
  assert.ok(xmas.seen.occurrenceKeys.some((key) => key.includes('date:12-25')))

  const xmasReplay = reduceTriggers({
    ...base,
    state: state(),
    seen: xmas.seen,
    now: localNoon(2026, 12, 25, 23),
  })
  assert.equal(xmasReplay.action, undefined)

  const boxingDay = reduceTriggers({
    ...base,
    state: state(),
    seen: xmasReplay.seen,
    now: localNoon(2026, 12, 26),
  })
  assert.deepEqual(boxingDay.action, { type: 'startAction', actionId: 'boxing-loop', loop: false })

  const nextYear = reduceTriggers({
    ...base,
    state: state(),
    seen: boxingDay.seen,
    now: localNoon(2027, 12, 25),
  })
  assert.deepEqual(nextYear.action, { type: 'startAction', actionId: 'xmas-loop', loop: false })
})

test('inAmbient 日期不压过 presence，且日期游标保持在有界 occurrenceKeys 内', () => {
  const now = new Date(2026, 11, 25, 12, 0, 0, 0).getTime()
  const presence = {
    on: true,
    mode: 'event' as const,
    busy: false,
    snapshot: null,
    recent: [],
  }
  const historic = Array.from({ length: 70 }, (_, index) => `fire|old-${index}|1`)
  const seen = { ...emptyTriggerSeen(), occurrenceKeys: historic }
  const base = {
    triggers: [trigger('date:12-25', ['xmas-loop'], [1], { inAmbient: true })],
    actions: [action('xmas-loop', true)],
    now,
    manualBusy: false,
    rng: () => 0,
  }

  const present = reduceTriggers({ ...base, state: state({ presence }), seen })
  assert.equal(present.action, undefined)
  assert.ok(present.seen.occurrenceKeys.every((key) => !key.includes('date:12-25')))

  const idle = reduceTriggers({ ...base, state: state(), seen: present.seen })
  assert.deepEqual(idle.action, { type: 'startAction', actionId: 'xmas-loop', loop: false })
  assert.equal(idle.seen.occurrenceKeys.length, 64)
  assert.ok(idle.seen.occurrenceKeys.at(-1)?.includes('date:12-25'))
})

test('ambient minGap 跨重启保留，离线超过 gap 后才重新允许', () => {
  const start = new Date(2026, 10, 18, 12, 0, 0, 0).getTime()
  const idle = state()
  const working = state({ activity: { state: 'working', at: start + 1, sessionId: 's' } })
  const input = {
    triggers: [trigger('ambient', ['ambient-once'], [1], { minGapSec: 300 })],
    actions: [action('ambient-once', true)],
    manualBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers({ ...input, state: idle, seen: emptyTriggerSeen(), now: start })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'ambient-once', loop: false })

  const interrupted = reduceTriggers({
    ...input,
    state: working,
    seen: first.seen,
    now: start + 1_000,
  })
  assert.equal(interrupted.seen.ambientConsumed, false)

  const restartedWithinGap = reduceTriggers({
    ...input,
    state: idle,
    seen: interrupted.seen,
    now: start + 100_000,
  })
  assert.equal(restartedWithinGap.action, undefined)
  assert.equal(restartedWithinGap.seen.ambientConsumed, false)

  const offlineExpired = reduceTriggers({
    ...input,
    state: idle,
    seen: restartedWithinGap.seen,
    now: start + 301_000,
  })
  assert.deepEqual(offlineExpired.action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
})

test('quiet hours 由注入配置控制，按本地分钟支持跨午夜窗口', () => {
  const at = (hour: number, minute: number): number =>
    new Date(2026, 10, 18, hour, minute, 0, 0).getTime()
  const input = {
    state: state(),
    triggers: [trigger('ambient', ['ambient-once'])],
    actions: [action('ambient-once')],
    manualBusy: false,
    rng: () => 0,
    config: { quietHours: { startMinute: 23 * 60, endMinute: 7 * 60 } },
  }

  assert.deepEqual(reduceTriggers({ ...input, seen: emptyTriggerSeen(), now: at(22, 59) }).action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
  assert.equal(reduceTriggers({ ...input, seen: emptyTriggerSeen(), now: at(23, 0) }).action, undefined)
  assert.equal(reduceTriggers({ ...input, seen: emptyTriggerSeen(), now: at(6, 59) }).action, undefined)
  assert.deepEqual(reduceTriggers({ ...input, seen: emptyTriggerSeen(), now: at(7, 0) }).action, {
    type: 'startAction', actionId: 'ambient-once', loop: false,
  })
})

test('多条未消费 cue 按状态顺序逐拍消费，不丢后一条', () => {
  const current = state({
    cues: [
      { id: 'cue-first', kind: 'speak', text: '第一句', at: 1000, ttlMs: 15_000 },
      { id: 'cue-second', kind: 'replied', text: '第二句', at: 1001, ttlMs: 15_000 },
    ],
  })
  const input = {
    state: current,
    triggers: [trigger('speak', ['speak-once']), trigger('bili_replied', ['reply-once'])],
    actions: [action('speak-once'), action('reply-once')],
    now: 2000,
    manualBusy: false,
    rng: () => 0,
  }

  const first = reduceTriggers({ ...input, seen: emptyTriggerSeen() })
  assert.deepEqual(first.bubble, { id: 'cue-first', text: '第一句' })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'speak-once', loop: false })

  const second = reduceTriggers({ ...input, seen: first.seen })
  assert.deepEqual(second.bubble, { id: 'cue-second', text: '第二句' })
  assert.deepEqual(second.action, { type: 'startAction', actionId: 'reply-once', loop: false })
})

test('稳态优先级 waiting > scene > activity > presence > idle', () => {
  const presence = {
    on: true,
    mode: 'event',
    busy: false,
    snapshot: null,
    recent: [],
  }
  const cases: Array<[PetState, string]> = [
    [state({
      scene: { kind: 'rest', at: 1 },
      activity: { state: 'waiting', at: 2, sessionId: 's' },
      presence,
    }), 'waiting'],
    [state({
      scene: { kind: 'rest', at: 1 },
      activity: { state: 'working', at: 2, sessionId: 's' },
      presence,
    }), 'idle'],
    [state({ activity: { state: 'working', at: 2, sessionId: 's' }, presence }), 'working'],
    [state({ presence }), 'thinking'],
    [state(), 'idle'],
  ]

  for (const [current, expected] of cases) {
    const result = reduceTriggers({
      state: current,
      triggers: [],
      actions: [],
      seen: emptyTriggerSeen(),
      now: 10,
      manualBusy: false,
      rng: () => 0,
    })
    assert.equal(result.steady, expected)
  }
})

test('waiting 没有专属动作时用 stopAction 卸下 scene loop，解除后恢复', () => {
  const sceneOnly = state({ scene: { kind: 'rest', at: 30 } })
  const input = {
    triggers: [trigger('scene:rest:enter', ['rest-loop'])],
    actions: [action('rest-loop', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...input, state: sceneOnly, seen: emptyTriggerSeen() })
  const waiting = reduceTriggers({
    ...input,
    state: { ...sceneOnly, activity: { state: 'waiting', at: 41, sessionId: 's' } },
    seen: entered.seen,
  })
  assert.deepEqual(waiting.action, { type: 'stopAction' })
  assert.equal(waiting.seen.sceneLoopActive, false)
  assert.equal(waiting.seen.sceneLoopActionId, 'rest-loop')

  const resumed = reduceTriggers({ ...input, state: sceneOnly, seen: waiting.seen })
  assert.deepEqual(resumed.action, { type: 'startAction', actionId: 'rest-loop', loop: true })
})

test('scene exit 没有唤醒动作时用 stopAction 结束 scene loop', () => {
  const sceneOnly = state({ scene: { kind: 'rest', at: 30 } })
  const input = {
    triggers: [trigger('scene:rest:enter', ['rest-loop'])],
    actions: [action('rest-loop', true)],
    now: 40,
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...input, state: sceneOnly, seen: emptyTriggerSeen() })
  const exited = reduceTriggers({ ...input, state: state(), seen: entered.seen })
  assert.deepEqual(exited.action, { type: 'stopAction' })
  assert.equal(exited.seen.lastSceneKind, null)
  assert.equal(exited.seen.sceneLoopActionId, null)
  assert.equal(exited.seen.sceneLoopActive, false)
})
