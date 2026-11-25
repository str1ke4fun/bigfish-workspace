import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PetState, PlaybackAction } from '../renderer/controller.ts'
import type { AmbientModePolicy } from '../shared/ambient-model.ts'
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

// ---------------------------------------------------------------------------
// 策略驱动的 ambient 调度（presence policy）
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const AMBIENT_T0 = new Date(2026, 10, 18, 12, 0, 0, 0).getTime()

function ambientPolicy(overrides: Partial<AmbientModePolicy> = {}): AmbientModePolicy {
  return {
    mode: 'work',
    enabled: true,
    items: [{ action: 'a', weight: 1, enabled: true, cooldownSec: 0, minIdleSec: 0 }],
    frequency: {
      intervalMinSec: 1200,
      intervalMaxSec: 1200,
      minGapSec: 300,
      maxPerIdle: 4,
      maxPerDay: 16,
      settleSec: 300,
      actionCooldownSec: 7200,
    },
    ...overrides,
  }
}

function ambientFrequency(
  overrides: Partial<AmbientModePolicy['frequency']> = {},
): AmbientModePolicy['frequency'] {
  return { ...ambientPolicy().frequency, ...overrides }
}

test('event 模式即使空闲也不播 ambient', () => {
  const policy = ambientPolicy({ mode: 'event', enabled: false })
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const first = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  assert.equal(first.action, undefined)
  assert.equal(first.seen.ambientIdleSince, null)

  const later = reduceTriggers({
    ...base,
    seen: first.seen,
    now: AMBIENT_T0 + 60 * MINUTE,
  })
  assert.equal(later.action, undefined)
  assert.equal(later.seen.ambientCountToday, 0)
})

test('work 模式进入空闲后等 interval 才播一次', () => {
  const policy = ambientPolicy()
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  assert.equal(entered.action, undefined)
  assert.equal(entered.seen.ambientMode, 'work')
  assert.equal(entered.seen.ambientIdleSince, AMBIENT_T0)
  assert.equal(entered.seen.ambientIdleCount, 0)
  assert.equal(entered.seen.ambientNextAt, AMBIENT_T0 + 20 * MINUTE)

  const early = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE - 1,
  })
  assert.equal(early.action, undefined)

  const fired = reduceTriggers({
    ...base,
    seen: early.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })
  assert.equal(fired.seen.ambientIdleCount, 1)
  assert.equal(fired.seen.ambientCountToday, 1)
  assert.equal(fired.seen.ambientLastAt, AMBIENT_T0 + 20 * MINUTE)
  assert.deepEqual(fired.seen.ambientActionKeys, [`a|${AMBIENT_T0 + 20 * MINUTE}`])
  assert.equal(fired.seen.ambientNextAt, AMBIENT_T0 + 40 * MINUTE)
})

test('同一拍重复归约不会连续触发两次', () => {
  const policy = ambientPolicy()
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  const fired = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })

  const again = reduceTriggers({
    ...base,
    seen: fired.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.equal(again.action, undefined)
  assert.equal(again.seen.ambientIdleCount, 1)
  assert.equal(again.seen.ambientCountToday, 1)
})

test('maxPerIdle 用尽后同一空闲段不再播', () => {
  const policy = ambientPolicy({ frequency: ambientFrequency({ maxPerIdle: 1 }) })
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  const fired = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })

  const capped = reduceTriggers({
    ...base,
    seen: fired.seen,
    now: AMBIENT_T0 + 40 * MINUTE,
  })
  assert.equal(capped.action, undefined)
  assert.equal(capped.seen.ambientNextAt, null)
  assert.equal(capped.seen.ambientIdleCount, 1)

  const later = reduceTriggers({
    ...base,
    seen: capped.seen,
    now: AMBIENT_T0 + 80 * MINUTE,
  })
  assert.equal(later.action, undefined)
})

test('maxPerDay 用尽后重新进入空闲也不再播', () => {
  const policy = ambientPolicy({ frequency: ambientFrequency({ maxPerDay: 1 }) })
  const working = state({ activity: { state: 'working', at: AMBIENT_T0 + 21 * MINUTE, sessionId: 's' } })
  const base = {
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, state: state(), seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  const fired = reduceTriggers({
    ...base,
    state: state(),
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })
  assert.equal(fired.seen.ambientCountToday, 1)

  const away = reduceTriggers({
    ...base,
    state: working,
    seen: fired.seen,
    now: AMBIENT_T0 + 21 * MINUTE,
  })
  assert.equal(away.seen.ambientIdleSince, null)
  assert.equal(away.seen.ambientNextAt, null)
  assert.equal(away.seen.ambientCountToday, 1)

  const back = reduceTriggers({
    ...base,
    state: state(),
    seen: away.seen,
    now: AMBIENT_T0 + 22 * MINUTE,
  })
  assert.equal(back.seen.ambientIdleSince, AMBIENT_T0 + 22 * MINUTE)
  assert.equal(back.seen.ambientNextAt, AMBIENT_T0 + 42 * MINUTE)

  const attempt = reduceTriggers({
    ...base,
    state: state(),
    seen: back.seen,
    now: AMBIENT_T0 + 42 * MINUTE,
  })
  assert.equal(attempt.action, undefined)
  assert.equal(attempt.seen.ambientNextAt, null)
  assert.equal(attempt.seen.ambientCountToday, 1)
})

test('quiet hours 不播，并把 nextAt 推到结束后', () => {
  const policy = ambientPolicy()
  const quietStart = new Date(2026, 10, 18, 23, 30, 0, 0).getTime()
  const quietEnd = new Date(2026, 10, 19, 7, 0, 0, 0).getTime()
  const config = {
    ambient: policy,
    quietHours: { startMinute: 23 * 60, endMinute: 7 * 60, afterJitterSec: 600 },
  }
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config,
    rng: () => 0,
  }

  const night = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: quietStart })
  assert.equal(night.action, undefined)
  assert.equal(night.seen.ambientNextAt, quietEnd + 10 * MINUTE)

  const stillNight = reduceTriggers({
    ...base,
    seen: night.seen,
    now: quietEnd - MINUTE,
  })
  assert.equal(stillNight.action, undefined)
  assert.equal(stillNight.seen.ambientNextAt, quietEnd + 10 * MINUTE)

  const morning = reduceTriggers({
    ...base,
    seen: stillNight.seen,
    now: quietEnd + 10 * MINUTE,
  })
  assert.deepEqual(morning.action, { type: 'startAction', actionId: 'a', loop: false })
})

test('manualBusy 结束空闲段，之后必须重新等满 interval', () => {
  const policy = ambientPolicy()
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({
    ...base,
    seen: emptyTriggerSeen(),
    now: AMBIENT_T0,
    manualBusy: false,
  })
  assert.equal(entered.seen.ambientNextAt, AMBIENT_T0 + 20 * MINUTE)

  const manual = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 10 * MINUTE,
    manualBusy: true,
  })
  assert.equal(manual.action, undefined)
  assert.equal(manual.seen.ambientIdleSince, null)
  assert.equal(manual.seen.ambientNextAt, null)
  assert.equal(manual.seen.ambientIdleCount, 0)

  const resumed = reduceTriggers({
    ...base,
    seen: manual.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
    manualBusy: false,
  })
  assert.equal(resumed.action, undefined)
  assert.equal(resumed.seen.ambientIdleSince, AMBIENT_T0 + 20 * MINUTE)
  assert.equal(resumed.seen.ambientNextAt, AMBIENT_T0 + 40 * MINUTE)

  const fired = reduceTriggers({
    ...base,
    seen: resumed.seen,
    now: AMBIENT_T0 + 40 * MINUTE,
    manualBusy: false,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })
})

test('消费 cue 会结束当前空闲段，之后重新等满 interval', () => {
  const policy = ambientPolicy()
  const cue = {
    id: 'cue-ambient',
    kind: 'speak' as const,
    text: '先说一句',
    at: AMBIENT_T0 + 10 * MINUTE,
    ttlMs: 15 * MINUTE,
  }
  const input = {
    triggers: [trigger('speak', ['cue-answer'])],
    actions: [action('a'), action('cue-answer')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({
    ...input,
    state: state(),
    seen: emptyTriggerSeen(),
    now: AMBIENT_T0,
  })
  const cued = reduceTriggers({
    ...input,
    state: state({ cues: [cue] }),
    seen: entered.seen,
    now: AMBIENT_T0 + 10 * MINUTE,
  })
  assert.deepEqual(cued.action, { type: 'startAction', actionId: 'cue-answer', loop: false })
  assert.equal(cued.seen.ambientIdleSince, null)
  assert.equal(cued.seen.ambientNextAt, null)

  const resumed = reduceTriggers({
    ...input,
    state: state(),
    seen: cued.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.equal(resumed.action, undefined)
  assert.equal(resumed.seen.ambientNextAt, AMBIENT_T0 + 40 * MINUTE)

  const fired = reduceTriggers({
    ...input,
    state: state(),
    seen: resumed.seen,
    now: AMBIENT_T0 + 40 * MINUTE,
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })
})

test('mode 变化重置调度', () => {
  const work = ambientPolicy()
  const ambient = ambientPolicy({ mode: 'ambient' })
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    rng: () => 0,
  }

  const entered = reduceTriggers({
    ...base,
    seen: emptyTriggerSeen(),
    now: AMBIENT_T0,
    config: { ambient: work },
  })
  assert.equal(entered.seen.ambientNextAt, AMBIENT_T0 + 20 * MINUTE)

  const switched = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
    config: { ambient },
  })
  assert.equal(switched.action, undefined)
  assert.equal(switched.seen.ambientMode, 'ambient')
  assert.equal(switched.seen.ambientIdleSince, AMBIENT_T0 + 20 * MINUTE)
  assert.equal(switched.seen.ambientIdleCount, 0)
  assert.equal(switched.seen.ambientLastAt, null)
  assert.deepEqual(switched.seen.ambientActionKeys, [])
  assert.equal(switched.seen.ambientNextAt, AMBIENT_T0 + 40 * MINUTE)

  const fired = reduceTriggers({
    ...base,
    seen: switched.seen,
    now: AMBIENT_T0 + 40 * MINUTE,
    config: { ambient },
  })
  assert.deepEqual(fired.action, { type: 'startAction', actionId: 'a', loop: false })
})

test('items 的 minIdleSec 在满足前跳过，满足后触发', () => {
  const policy = ambientPolicy({
    items: [{ action: 'a', weight: 1, enabled: true, cooldownSec: 0, minIdleSec: 600 }],
    frequency: ambientFrequency({
      intervalMinSec: 300,
      intervalMaxSec: 300,
      minGapSec: 0,
      settleSec: 0,
    }),
  })
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  assert.equal(entered.seen.ambientNextAt, AMBIENT_T0 + 5 * MINUTE)

  const tooSoon = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 5 * MINUTE,
  })
  assert.equal(tooSoon.action, undefined)
  assert.equal(tooSoon.seen.ambientNextAt, AMBIENT_T0 + 6 * MINUTE)

  const ready = reduceTriggers({
    ...base,
    seen: tooSoon.seen,
    now: AMBIENT_T0 + 10 * MINUTE,
  })
  assert.deepEqual(ready.action, { type: 'startAction', actionId: 'a', loop: false })
})

test('items 的 cooldownSec 冷却中跳过，改选其他可用 item', () => {
  const policy = ambientPolicy({
    items: [
      { action: 'a', weight: 1, enabled: true, cooldownSec: 3600, minIdleSec: 0 },
      { action: 'b', weight: 1, enabled: true, cooldownSec: 0, minIdleSec: 0 },
    ],
    frequency: ambientFrequency({
      intervalMinSec: 600,
      intervalMaxSec: 600,
      minGapSec: 0,
      settleSec: 0,
    }),
  })
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a'), action('b')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  const first = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 10 * MINUTE,
  })
  assert.deepEqual(first.action, { type: 'startAction', actionId: 'a', loop: false })

  const second = reduceTriggers({
    ...base,
    seen: first.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.deepEqual(second.action, { type: 'startAction', actionId: 'b', loop: false })
  assert.ok(second.seen.ambientActionKeys.includes(`a|${AMBIENT_T0 + 10 * MINUTE}`))
  assert.ok(second.seen.ambientActionKeys.includes(`b|${AMBIENT_T0 + 20 * MINUTE}`))
})

test('加权选择可复现，跳过 disabled / 冷却中的 item', () => {
  const policy = ambientPolicy({
    items: [
      { action: 'a', weight: 3, enabled: true, cooldownSec: 0, minIdleSec: 0 },
      { action: 'b', weight: 1, enabled: true, cooldownSec: 0, minIdleSec: 0 },
      { action: 'disabled', weight: 100, enabled: false, cooldownSec: 0, minIdleSec: 0 },
      { action: 'zero', weight: 0, enabled: true, cooldownSec: 0, minIdleSec: 0 },
    ],
  })
  const actions = [action('a'), action('b'), action('disabled'), action('zero')]

  const fireWith = (roll: number): string | undefined => {
    const base = {
      state: state(),
      triggers: [],
      actions,
      manualBusy: false,
      config: { ambient: policy },
      rng: () => roll,
    }
    const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
    const fired = reduceTriggers({
      ...base,
      seen: entered.seen,
      now: AMBIENT_T0 + 20 * MINUTE,
    })
    return fired.action?.type === 'startAction' ? fired.action.actionId : undefined
  }

  assert.equal(fireWith(0), 'a')
  assert.equal(fireWith(0.9), 'b')
})

test('policy 缺失时保留 legacy ambient trigger 兼容', () => {
  const result = reduceTriggers({
    state: state(),
    triggers: [trigger('ambient', ['ambient-once'])],
    actions: [action('ambient-once')],
    seen: emptyTriggerSeen(),
    now: AMBIENT_T0,
    manualBusy: false,
    config: { ambient: null },
    rng: () => 0,
  })

  assert.deepEqual(result.action, { type: 'startAction', actionId: 'ambient-once', loop: false })
  assert.equal(result.seen.ambientConsumed, true)
})

test('policy 存在时 legacy ambient trigger 不再触发', () => {
  const policy = ambientPolicy({ mode: 'event', enabled: false })
  const base = {
    state: state(),
    triggers: [trigger('ambient', ['ambient-once'])],
    actions: [action('ambient-once'), action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const first = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  assert.equal(first.action, undefined)

  const later = reduceTriggers({
    ...base,
    seen: first.seen,
    now: AMBIENT_T0 + 60 * MINUTE,
  })
  assert.equal(later.action, undefined)
})

test('date inAmbient 在 event 模式下不播', () => {
  const now = new Date(2026, 11, 25, 12, 0, 0, 0).getTime()
  const result = reduceTriggers({
    state: state(),
    triggers: [trigger('date:12-25', ['xmas-loop'], [1], { inAmbient: true })],
    actions: [action('xmas-loop'), action('a')],
    seen: emptyTriggerSeen(),
    now,
    manualBusy: false,
    config: { ambient: ambientPolicy({ mode: 'event', enabled: false }) },
    rng: () => 0,
  })

  assert.equal(result.action, undefined)
  assert.equal(result.seen.occurrenceKeys.length, 0)
})

test('跨本地日重置每日计数', () => {
  const policy = ambientPolicy()
  const nextDay = new Date(2026, 10, 19, 0, 0, 1, 0).getTime()
  const base = {
    state: state(),
    triggers: [],
    actions: [action('a')],
    manualBusy: false,
    config: { ambient: policy },
    rng: () => 0,
  }

  const entered = reduceTriggers({ ...base, seen: emptyTriggerSeen(), now: AMBIENT_T0 })
  const fired = reduceTriggers({
    ...base,
    seen: entered.seen,
    now: AMBIENT_T0 + 20 * MINUTE,
  })
  assert.equal(fired.seen.ambientCountToday, 1)

  const rollover = reduceTriggers({ ...base, seen: fired.seen, now: nextDay })
  assert.deepEqual(rollover.action, { type: 'startAction', actionId: 'a', loop: false })
  assert.equal(rollover.seen.ambientCountToday, 1)
  assert.equal(rollover.seen.ambientDayKey, '2026-11-19')
})
