import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  actionAnimationNames,
  mergeActionCatalogs,
  parseActions,
  type ActionDefinition,
} from '../electron/actions.ts'

const MEDIA_DIR = join('virtual', 'pet', 'webm')

function available(...names: string[]) {
  const files = new Set(names.map((name) => resolve(MEDIA_DIR, `${name}.webm`)))
  const logs: string[] = []
  return {
    mediaDir: MEDIA_DIR,
    exists: (file: string) => files.has(file),
    log: (message: string) => logs.push(message),
    logs,
  }
}

test('合法 anim/seq 动作补齐缺省 loop/group，并提供动画名列表', () => {
  const fixture = available('点击回应-元气挥手', '睡觉-开始', '睡觉-循环')

  const result = parseActions(
    {
      actions: [
        { id: 'alpha-wave', label: ' 挥手 ', anim: ' 点击回应-元气挥手 ' },
        {
          id: 'sleep',
          label: '睡觉',
          seq: ['睡觉-开始', '睡觉-循环'],
          loop: true,
          group: '休息',
        },
      ],
    },
    fixture,
  )

  assert.deepEqual(result, {
    actions: [
      {
        id: 'alpha-wave',
        label: '挥手',
        anim: '点击回应-元气挥手',
        loop: false,
        group: '其他',
      },
      {
        id: 'sleep',
        label: '睡觉',
        seq: ['睡觉-开始', '睡觉-循环'],
        loop: true,
        group: '休息',
      },
    ],
    errors: [],
  })
  assert.deepEqual(actionAnimationNames(result.actions[0]), ['点击回应-元气挥手'])
  assert.deepEqual(actionAnimationNames(result.actions[1]), ['睡觉-开始', '睡觉-循环'])
  assert.deepEqual(fixture.logs, [])
})

test('anim 与 seq 同时出现或都缺失时整条丢弃', () => {
  const result = parseActions(
    {
      actions: [
        { id: 'both', label: '双份', anim: 'a', seq: ['b'] },
        { id: 'neither', label: '空动作' },
      ],
    },
    { mediaDir: MEDIA_DIR, exists: () => true, log: () => {} },
  )

  assert.deepEqual(result.actions, [])
  assert.equal(result.errors.length, 2)
})

test('缺 label、非法 id 与非对象条目只丢弃本条目', () => {
  const result = parseActions(
    {
      actions: [
        { id: 'no-label', anim: 'ok' },
        { id: '../escape', label: '坏 id', anim: 'ok' },
        { id: 'UPPER', label: '坏 id', anim: 'ok' },
        null,
        { id: 'good', label: '保留', anim: 'ok' },
      ],
    },
    { mediaDir: MEDIA_DIR, exists: () => true, log: () => {} },
  )

  assert.deepEqual(result.actions.map((action) => action.id), ['good'])
  assert.equal(result.errors.length, 4)
})

test('anim 与 seq 的路径穿越都整条拒绝，且不查询越界文件', () => {
  let checkedTraversal = false
  const result = parseActions(
    {
      actions: [
        { id: 'good', label: '保留', anim: 'safe' },
        { id: 'bad-anim', label: '越界', anim: '../escape' },
        { id: 'bad-seq', label: '越界序列', seq: ['safe', '..\\escape'] },
      ],
    },
    {
      mediaDir: MEDIA_DIR,
      exists: (file: string) => {
        if (file.includes('escape')) checkedTraversal = true
        return true
      },
      log: () => {},
    },
  )

  assert.deepEqual(result.actions.map((action) => action.id), ['good'])
  assert.equal(result.errors.length, 2)
  assert.equal(checkedTraversal, false)
})

test('缺失 webm 的单段动作整条丢弃，其它登记继续可用', () => {
  const fixture = available('safe')
  const result = parseActions(
    {
      actions: [
        { id: 'safe', label: '可用', anim: 'safe' },
        { id: 'missing', label: '缺素材', anim: 'not-there' },
      ],
    },
    fixture,
  )

  assert.deepEqual(result.actions.map((action) => action.id), ['safe'])
  assert.equal(result.errors.length, 1)
  assert.equal(fixture.logs.length, 1)
  assert.match(fixture.logs[0], /not-there/)
})

test('seq 必须非空且每一段都存在', () => {
  const fixture = available('start')
  const result = parseActions(
    {
      actions: [
        { id: 'empty', label: '空序列', seq: [] },
        { id: 'partial', label: '缺后段', seq: ['start', 'missing'] },
        { id: 'bad-part', label: '坏段', seq: ['start', 42] },
      ],
    },
    fixture,
  )

  assert.deepEqual(result.actions, [])
  assert.equal(result.errors.length, 3)
  assert.equal(fixture.logs.length, 3)
})

test('重复 id 以后者覆盖前者，并保留首次出现的稳定位置', () => {
  const result = parseActions(
    {
      actions: [
        { id: 'dup', label: '旧标签', anim: 'old', group: '旧组' },
        { id: 'middle', label: '中间', anim: 'middle' },
        { id: 'dup', label: '新标签', anim: 'new', loop: true, group: '新组' },
      ],
    },
    { mediaDir: MEDIA_DIR, exists: () => true, log: () => {} },
  )

  assert.deepEqual(result.actions, [
    { id: 'dup', label: '新标签', anim: 'new', loop: true, group: '新组' },
    { id: 'middle', label: '中间', anim: 'middle', loop: false, group: '其他' },
  ])
})

test('合并默认与皮肤目录时同 id 由皮肤覆盖，新动作追加，输入不变', () => {
  const defaults: ActionDefinition[] = [
    { id: 'common', label: '默认共同', anim: 'default-common', loop: false, group: '默认' },
    { id: 'default-only', label: '仅默认', seq: ['a', 'b'], loop: false, group: '默认' },
  ]
  const skin: ActionDefinition[] = [
    { id: 'skin-only', label: '仅皮肤', anim: 'skin-only', loop: false, group: '皮肤' },
    { id: 'common', label: '皮肤共同', anim: 'skin-common', loop: true, group: '皮肤' },
  ]
  const defaultsBefore = structuredClone(defaults)
  const skinBefore = structuredClone(skin)

  const merged = mergeActionCatalogs(defaults, skin)

  assert.deepEqual(merged, [
    { id: 'common', label: '皮肤共同', anim: 'skin-common', loop: true, group: '皮肤' },
    { id: 'default-only', label: '仅默认', seq: ['a', 'b'], loop: false, group: '默认' },
    { id: 'skin-only', label: '仅皮肤', anim: 'skin-only', loop: false, group: '皮肤' },
  ])
  assert.deepEqual(defaults, defaultsBefore)
  assert.deepEqual(skin, skinBefore)
})

test('无 actions 数组的注册表返回空目录和错误，不抛出', () => {
  const result = parseActions({ actions: 'not-an-array' }, {
    mediaDir: MEDIA_DIR,
    exists: () => true,
    log: () => {},
  })

  assert.deepEqual(result.actions, [])
  assert.equal(result.errors.length, 1)
})
