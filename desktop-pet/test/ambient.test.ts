import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAmbientCatalog,
  mergeAmbientCatalogs,
  filterAmbientCatalog,
  readAmbientCatalog,
} from '../electron/ambient.ts'
import { selectAmbientPolicy } from '../shared/ambient-model.ts'

const ids = new Set(['asset-109', 'asset-087'])
const base = {
  version: 1,
  quietHours: { start: '23:00', end: '07:00', afterJitterSec: 600 },
  modes: {
    work: {
      enabled: true,
      items: [{ action: 'asset-109', weight: 2 }],
      frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 },
    },
  },
}

test('parse 丢弃未知 action、重复 action 后者覆盖、坏 weight 归 1', () => {
  const raw = {
    ...base,
    modes: { work: { ...base.modes.work, items: [
      { action: 'asset-109', weight: 2 },
      { action: 'nope', weight: 5 },
      { action: 'asset-109', weight: -1 },
    ] } },
  }
  const { catalog, errors } = parseAmbientCatalog(raw, { actionIds: ids, log: () => {} })
  assert.equal(catalog.modes.work.items.length, 1)
  assert.equal(catalog.modes.work.items[0].action, 'asset-109')
  assert.equal(catalog.modes.work.items[0].weight, 1)
  assert.ok(errors.some((e) => e.includes('nope')))
})

test('皮肤同 mode 覆盖默认，缺失 mode 回落', () => {
  const skin = { ...base, modes: { work: { ...base.modes.work, enabled: false } } }
  const merged = mergeAmbientCatalogs(base, skin)
  assert.equal(merged.modes.work.enabled, false)
})

test('filter 按动作目录裁 item；空池保留但 enabled 不动', () => {
  const filtered = filterAmbientCatalog(base, new Set(['asset-087']))
  assert.equal(filtered.modes.work.items.length, 0)
  assert.equal(filtered.modes.work.enabled, true)
})

test('selectAmbientPolicy：presence off 用 off，未知 mode 返回 null', () => {
  const catalog = { ...base, modes: { ...base.modes, off: base.modes.work } }
  assert.equal(selectAmbientPolicy(catalog, null, 'work', false)!.mode, 'off')
  assert.equal(selectAmbientPolicy(catalog, null, 'unknown', true), null)
})

test('parse 补齐频率默认值并交换 min/max，负数夹到 0', () => {
  const raw = {
    ...base,
    modes: {
      work: {
        ...base.modes.work,
        frequency: { intervalMinSec: 2400, intervalMaxSec: 1200, maxPerIdle: 4, maxPerDay: 16, settleSec: -5 },
      },
    },
  }
  const { catalog } = parseAmbientCatalog(raw, { actionIds: ids, log: () => {} })
  const frequency = catalog.modes.work.frequency
  assert.equal(frequency.intervalMinSec, 1200)
  assert.equal(frequency.intervalMaxSec, 2400)
  assert.equal(frequency.minGapSec, 300)
  assert.equal(frequency.settleSec, 0)
  assert.equal(frequency.actionCooldownSec, 7200)
  assert.equal(frequency.maxPerIdle, 4)
  assert.equal(frequency.maxPerDay, 16)
  assert.equal(catalog.modes.work.mode, 'work')
})

test('mergeAmbientCatalogs 不改写输入，缺失 mode 用默认', () => {
  const withOff = {
    ...base,
    modes: { ...base.modes, off: { ...base.modes.work, enabled: true } },
  }
  const skin = { ...base, modes: { work: { ...base.modes.work, enabled: false } } }
  const merged = mergeAmbientCatalogs(withOff, skin)
  assert.deepEqual(merged.modes.off, parseAmbientCatalog(withOff, { actionIds: ids }).catalog.modes.off)
  assert.equal(withOff.modes.work.enabled, true)
  assert.equal(skin.modes.work.enabled, false)
  assert.notEqual(merged.modes.work.items, skin.modes.work.items)
})

test('selectAmbientPolicy 合并用户覆盖：items 替换、frequency 逐字段、enabled 覆盖', () => {
  const { catalog } = parseAmbientCatalog(base, { actionIds: ids })
  const policy = selectAmbientPolicy(
    catalog,
    {
      modes: {
        work: {
          enabled: false,
          items: [{ action: 'asset-087', weight: 3 }],
          frequency: { intervalMinSec: 60 },
        },
      },
    },
    'work',
    true,
  )!
  assert.equal(policy.mode, 'work')
  assert.equal(policy.enabled, false)
  assert.deepEqual(policy.items.map((item) => item.action), ['asset-087'])
  assert.equal(policy.items[0].weight, 3)
  assert.equal(policy.items[0].enabled, true)
  assert.equal(policy.items[0].cooldownSec, 0)
  assert.equal(policy.items[0].minIdleSec, 0)
  assert.equal(policy.frequency.intervalMinSec, 60)
  assert.equal(policy.frequency.intervalMaxSec, 2400)
  assert.equal(policy.frequency.minGapSec, 300)
  assert.equal(policy.frequency.maxPerDay, 16)
})

test('readAmbientCatalog：默认文件必填、皮肤文件可选、非法 skin id 抛错', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pet-ambient-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await assert.rejects(() => readAmbientCatalog(root, '', ids, () => {}))

  writeFileSync(join(root, 'ambient.json'), JSON.stringify(base))
  const plain = await readAmbientCatalog(root, '', ids, () => {})
  assert.equal(plain.modes.work.enabled, true)

  // 皮肤目录里没有 ambient.json 时不算错误，继续用默认。
  const noSkin = await readAmbientCatalog(root, 'maid-blue', ids, () => {})
  assert.equal(noSkin.modes.work.enabled, true)

  mkdirSync(join(root, 'skins', 'maid-blue'), { recursive: true })
  writeFileSync(
    join(root, 'skins', 'maid-blue', 'ambient.json'),
    JSON.stringify({ modes: { work: { ...base.modes.work, enabled: false } } }),
  )
  const withSkin = await readAmbientCatalog(root, 'maid-blue', ids, () => {})
  assert.equal(withSkin.modes.work.enabled, false)
  // 皮肤只覆盖同名 mode：quietHours 仍来自默认文件。
  assert.deepEqual(withSkin.quietHours, base.quietHours)

  await assert.rejects(() => readAmbientCatalog(root, '../escape', ids, () => {}))
})
