import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AMBIENT_MODES, emptyAmbientConfig, effectiveAmbientModes,
  normalizeAmbientConfig, applyAmbientOp,
} from '../lib/pet-ambient.js'

const actionIds = new Set(['asset-109', 'asset-087', 'asset-070'])
const defaults = {
  version: 1,
  quietHours: { start: '23:00', end: '07:00', afterJitterSec: 600 },
  modes: {
    work: {
      enabled: true,
      items: [{ action: 'asset-109', weight: 1, enabled: true, cooldownSec: 7200, minIdleSec: 0 }],
      frequency: {
        intervalMinSec: 1200, intervalMaxSec: 2400, minGapSec: 300,
        maxPerIdle: 4, maxPerDay: 16, settleSec: 300, actionCooldownSec: 7200,
      },
    },
  },
}

test('add-item 以 defaults 为基线，写完整 mode 并推进 revision', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 3,
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes.work.items.map((x) => x.action), ['asset-109', 'asset-087'])
  assert.equal(r.config.modes.work.items[1].weight, 3)
  assert.equal(r.config.revision, 1)
  assert.notEqual(r.config, defaults)
})

test('remove-item / set-item / set-frequency / set-enabled / reset', () => {
  let r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 2,
  }, { actionIds })
  r = applyAmbientOp(r.config, defaults, { op: 'set-item', mode: 'work', action: 'asset-087', patch: { weight: 5, enabled: false } }, { actionIds })
  assert.equal(r.config.modes.work.items[1].weight, 5)
  assert.equal(r.config.modes.work.items[1].enabled, false)
  r = applyAmbientOp(r.config, defaults, { op: 'set-frequency', mode: 'work', patch: { intervalMinSec: 2400, intervalMaxSec: 1200 } }, { actionIds })
  assert.equal(r.config.modes.work.frequency.intervalMinSec, 1200)
  assert.equal(r.config.modes.work.frequency.intervalMaxSec, 2400)
  r = applyAmbientOp(r.config, defaults, { op: 'set-enabled', mode: 'work', enabled: false }, { actionIds })
  assert.equal(r.config.modes.work.enabled, false)
  r = applyAmbientOp(r.config, defaults, { op: 'reset', mode: 'work' }, { actionIds })
  assert.equal(r.config.modes.work, undefined)
})

test('replace-mode 存完整 mode，未知 item 丢弃并报告', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'replace-mode', mode: 'off',
    policy: {
      enabled: true,
      items: [
        { action: 'asset-109', weight: 2 },
        { action: 'nope', weight: 1 },
      ],
      frequency: { intervalMinSec: 480, intervalMaxSec: 1200, maxPerIdle: 10, maxPerDay: 30 },
    },
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes.off.items.map((x) => x.action), ['asset-109'])
  assert.ok(r.errors.some((e) => e.includes('nope')))
})

test('未知 action、坏 weight、空 items、未知 mode 的边界', () => {
  assert.equal(applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'nope', weight: 1,
  }, { actionIds }).ok, false)
  const zero = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'set-item', mode: 'work', action: 'asset-109', patch: { weight: -1 },
  }, { actionIds })
  assert.equal(zero.ok, true)
  assert.equal(zero.config.modes.work.items[0].weight, 1)
  const empty = applyAmbientOp(emptyAmbientConfig(), { modes: { work: { ...defaults.modes.work, items: [] } } }, {
    op: 'set-enabled', mode: 'work', enabled: true,
  }, { actionIds })
  assert.equal(empty.ok, false)
  assert.equal(empty.why, 'EMPTY_POOL')
  assert.equal(applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'reset', mode: 'boss',
  }, { actionIds }).ok, false)
  assert.equal(applyAmbientOp(emptyAmbientConfig(), null, {
    op: 'add-item', mode: 'work', action: 'asset-109',
  }, { actionIds }).why, 'NO_BASE_POLICY')
})

test('effectiveAmbientModes：override 覆盖 defaults，缺失 mode 回落', () => {
  const config = {
    version: 1, revision: 2,
    modes: { work: { ...defaults.modes.work, enabled: false } },
  }
  const modes = effectiveAmbientModes(config, defaults)
  assert.equal(modes.work.enabled, false)
  assert.equal(modes.off, undefined)
  assert.deepEqual(AMBIENT_MODES, ['off', 'event', 'ambient', 'work'])
})

test('replace-mode 省略的频率字段用设计默认值补齐', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'replace-mode', mode: 'event',
    policy: { enabled: true, items: [{ action: 'asset-109' }], frequency: {} },
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.equal(r.config.modes.event.frequency.minGapSec, 300)
  assert.equal(r.config.modes.event.frequency.settleSec, 300)
  assert.equal(r.config.modes.event.frequency.actionCooldownSec, 7200)
})

test('replace-mode 重复 action 后者覆盖前者并保留首次位置', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'replace-mode', mode: 'ambient',
    policy: {
      enabled: true,
      items: [
        { action: 'asset-109', weight: 1 },
        { action: 'asset-070', weight: 2 },
        { action: 'asset-109', weight: 7 },
      ],
      frequency: {},
    },
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes.ambient.items.map((x) => x.action), ['asset-109', 'asset-070'])
  assert.equal(r.config.modes.ambient.items[0].weight, 7)
})

test('reset 不带 mode 清空全部覆盖并推进 revision', () => {
  let r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 2,
  }, { actionIds })
  r = applyAmbientOp(r.config, defaults, { op: 'reset' }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes, {})
  assert.equal(r.config.revision, 2)
})

test('actionIds 为 null 时跳过动作校验照样写入；空 Set 仍然严格', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-unseen', weight: 2,
  }, { actionIds: null })
  assert.equal(r.ok, true)
  assert.equal(r.config.modes.work.items.at(-1).action, 'asset-unseen')
  const strict = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-unseen',
  }, { actionIds: new Set() })
  assert.equal(strict.ok, false)
  assert.equal(strict.why, 'UNKNOWN_ACTION')
})

test('set-item 只在 enabled 是布尔时改动它', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'set-item', mode: 'work', action: 'asset-109', patch: { enabled: 0 },
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.equal(r.config.modes.work.items[0].enabled, true)
  const off = applyAmbientOp(r.config, defaults, {
    op: 'set-item', mode: 'work', action: 'asset-109', patch: { enabled: false },
  }, { actionIds })
  assert.equal(off.config.modes.work.items[0].enabled, false)
  const stayed = applyAmbientOp(off.config, defaults, {
    op: 'set-item', mode: 'work', action: 'asset-109', patch: { enabled: 'false' },
  }, { actionIds })
  assert.equal(stayed.config.modes.work.items[0].enabled, false)
})

test('normalizeAmbientConfig 拒绝不存在的钟点，保留合法值', () => {
  const bad = normalizeAmbientConfig({ quietHours: { start: '99:99', end: '07:00' } })
  assert.equal(bad.config.quietHours, null)
  const good = normalizeAmbientConfig({
    quietHours: { start: '23:00', end: '07:30', afterJitterSec: 60 },
  })
  assert.deepEqual(good.config.quietHours, { start: '23:00', end: '07:30', afterJitterSec: 60 })
})
