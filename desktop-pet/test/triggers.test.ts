import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mergeTriggers,
  parseTriggers,
  pickTriggerAction,
  readTriggerCatalog,
  type TriggerDefinition,
} from '../electron/triggers.ts'

const ACTION_IDS = new Set(['asset-001', 'asset-002', 'asset-003'])
const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

function trigger(entry: unknown): TriggerDefinition {
  return {
    when: 'speak',
    pool: ['asset-001'],
    w: [1],
    once: false,
    minGapSec: 0,
    inAmbient: false,
    ...entry,
  }
}

function parse(raw: unknown, actionIds: ReadonlySet<string> = ACTION_IDS) {
  const logs: string[] = []
  const result = parseTriggers(raw, { actionIds, log: (message) => logs.push(message) })
  return { ...result, logs }
}

test('合法 trigger 规范化缺省字段，并保留权重', () => {
  const result = parse({
    triggers: [
      { when: ' speak ', pool: ['asset-001', 'asset-002'], w: [3, 1] },
      {
        when: 'ambient',
        pool: ['asset-003'],
        once: true,
        minGapSec: 300,
        inAmbient: true,
      },
    ],
  })

  assert.deepEqual(result, {
    triggers: [
      {
        when: 'speak',
        pool: ['asset-001', 'asset-002'],
        w: [3, 1],
        once: false,
        minGapSec: 0,
        inAmbient: false,
      },
      {
        when: 'ambient',
        pool: ['asset-003'],
        w: [1],
        once: true,
        minGapSec: 300,
        inAmbient: true,
      },
    ],
    errors: [],
    logs: [],
  })
})

test('非法 trigger 逐条丢弃，合法条目仍保留', () => {
  const result = parse({
    triggers: [
      { when: 'activity:unknown', pool: ['asset-001'] },
      { when: 'date:02-30', pool: ['asset-001'] },
      { when: 'speak', pool: [] },
      { when: 'speak', pool: ['asset-404'] },
      { when: 'speak', pool: ['asset-001'], w: [1, 2] },
      { when: 'speak', pool: ['asset-001', 'asset-002'], w: [1, -1] },
      { when: 'speak', pool: ['asset-001', 'asset-002'], w: [0, 0] },
      { when: 'speak', pool: ['asset-001'], once: 'yes' },
      { when: 'speak', pool: ['asset-001'], minGapSec: -1 },
      { when: 'speak', pool: ['asset-001'], inAmbient: 'yes' },
      null,
      { when: ' date:12-25 ', pool: ['asset-003'] },
    ],
  })

  assert.deepEqual(result.triggers, [{
    when: 'date:12-25',
    pool: ['asset-003'],
    w: [1],
    once: false,
    minGapSec: 0,
    inAmbient: false,
  }])
  assert.equal(result.errors.length, 11)
  assert.equal(result.logs.length, 11)
  assert.ok(result.errors.some((message) => /when/.test(message)))
  assert.ok(result.errors.some((message) => /pool/.test(message)))
  assert.ok(result.errors.some((message) => /动作/.test(message)))
  assert.ok(result.errors.some((message) => /w/.test(message)))
  assert.ok(result.errors.some((message) => /once/.test(message)))
  assert.ok(result.errors.some((message) => /minGapSec/.test(message)))
  assert.ok(result.errors.some((message) => /inAmbient/.test(message)))
})

test('缺省权重等权，显式权重按注入随机源选择且不选中零权重', () => {
  const equal = parse({ triggers: [{ when: 'speak', pool: ['asset-001', 'asset-002'] }] }).triggers[0]
  assert.equal(pickTriggerAction(equal, () => 0.49), 'asset-001')
  assert.equal(pickTriggerAction(equal, () => 0.5), 'asset-002')

  const weighted = parse({
    triggers: [{
      when: 'speak',
      pool: ['asset-001', 'asset-002', 'asset-003'],
      w: [0, 3, 1],
    }],
  }).triggers[0]
  assert.equal(pickTriggerAction(weighted, () => 0), 'asset-002')
  assert.equal(pickTriggerAction(weighted, () => 0.74), 'asset-002')
  assert.equal(pickTriggerAction(weighted, () => 0.75), 'asset-003')
})

test('默认与皮肤 trigger 按 when 合并：皮肤覆盖默认位置，新条目追加，输入不变', () => {
  const defaults: TriggerDefinition[] = [
    trigger({ when: 'speak', pool: ['asset-001'], w: [1] }),
    trigger({ when: 'ambient', pool: ['asset-002'], w: [1], minGapSec: 300 }),
    trigger({ when: 'date:12-25', pool: ['asset-003'], w: [1], inAmbient: true }),
  ]
  const skin: TriggerDefinition[] = [
    trigger({ when: 'activity:success', pool: ['asset-003'], w: [1], once: true }),
    trigger({ when: 'ambient', pool: ['asset-001', 'asset-003'], w: [2, 1], minGapSec: 60 }),
  ]
  const defaultsBefore = structuredClone(defaults)
  const skinBefore = structuredClone(skin)

  const merged = mergeTriggers(defaults, skin)

  assert.deepEqual(merged, [
    trigger({ when: 'speak', pool: ['asset-001'], w: [1] }),
    trigger({ when: 'ambient', pool: ['asset-001', 'asset-003'], w: [2, 1], minGapSec: 60 }),
    trigger({ when: 'date:12-25', pool: ['asset-003'], w: [1], inAmbient: true }),
    trigger({ when: 'activity:success', pool: ['asset-003'], w: [1], once: true }),
  ])
  assert.deepEqual(defaults, defaultsBefore)
  assert.deepEqual(skin, skinBefore)
})

test('读取默认与皮肤文件后合并，皮肤文件缺失时沿用默认 trigger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bigfish-pet-triggers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  await mkdir(join(assets, 'skins', 'rest'), { recursive: true })
  await writeFile(join(assets, 'triggers.json'), JSON.stringify({
    triggers: [
      { when: 'speak', pool: ['asset-001'] },
      { when: 'ambient', pool: ['asset-002'], minGapSec: 300 },
    ],
  }))

  assert.deepEqual((await readTriggerCatalog(assets, 'rest', ACTION_IDS)).map((item) => item.when), [
    'speak',
    'ambient',
  ])

  await writeFile(join(assets, 'skins', 'rest', 'triggers.json'), JSON.stringify({
    triggers: [
      { when: 'scene:rest:enter', pool: ['asset-003'] },
      { when: 'ambient', pool: ['asset-001'], minGapSec: 30 },
    ],
  }))
  assert.deepEqual(await readTriggerCatalog(assets, 'rest', ACTION_IDS), [
    trigger({ when: 'speak', pool: ['asset-001'], w: [1] }),
    trigger({ when: 'ambient', pool: ['asset-001'], w: [1], minGapSec: 30 }),
    trigger({ when: 'scene:rest:enter', pool: ['asset-003'], w: [1] }),
  ])
})

test('trigger JSON 整体损坏时抛错，调用方才能保留上一份目录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bigfish-pet-triggers-bad-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  await mkdir(assets, { recursive: true })
  await writeFile(join(assets, 'triggers.json'), '{ nope')

  await assert.rejects(() => readTriggerCatalog(assets, '', ACTION_IDS), /JSON/)
})

test('默认 trigger 文件缺失视为加载失败，皮肤 trigger 文件仍可省略', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bigfish-pet-triggers-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  await mkdir(join(assets, 'skins', 'rest'), { recursive: true })

  await assert.rejects(() => readTriggerCatalog(assets, '', ACTION_IDS), /读不了/)

  await writeFile(join(assets, 'triggers.json'), JSON.stringify({
    triggers: [{ when: 'speak', pool: ['asset-001'] }],
  }))
  assert.deepEqual((await readTriggerCatalog(assets, 'rest', ACTION_IDS)).map((item) => item.when), ['speak'])
})

test('仓库默认 triggers.json 的每条动作 id 都能在动作目录中找到', async () => {
  const actions = JSON.parse(await readFile(join(ASSETS_ROOT, 'actions.json'), 'utf8')) as {
    actions: Array<{ id: string }>
  }
  const raw = JSON.parse(await readFile(join(ASSETS_ROOT, 'triggers.json'), 'utf8'))
  const result = parse(raw, new Set(actions.actions.map((action) => action.id)))

  assert.deepEqual(result.errors, [])
  assert.ok(result.triggers.length > 0)
})
