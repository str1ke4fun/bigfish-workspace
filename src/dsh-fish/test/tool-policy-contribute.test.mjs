/**
 * tool-policy-contribute.test.mjs —— 工具策略贡献（A1.4）
 *
 * 策略表从「冻结常量」变成「内置表 + 贡献表」的合并视图。这里钉住贡献的几条
 * 硬约束：
 *   - 整次校验、整次生效或整次拒绝，不会只进去半个 payload；
 *   - 同一个 id 重复贡献是替换/幂等，旧 off 变空操作；
 *   - 名字不能跟内置表或别的 id 撞；
 *   - 宿主没注册的名字不许混进来；
 *   - 该面已经有 agent 时晚贡献被拒（同 id 同名字的幂等重试除外）。
 *
 * 模块是进程级单例；node --test 每个文件一个进程。每个用例自己撤销贡献，
 * afterEach 再兜一次，保证用例之间不互相污染。
 */

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  OWN_TOOL_NAMES,
  SURFACES,
  catalog,
  contribute,
  entriesFor,
  groupsFor,
  ownTools,
  resolveAllow,
  setAgentProbe,
  setHostNamesProvider,
  status,
} from '../lib/tool-policy.js'

const caps = { hasImageRoute: true }

const BILI = [
  { name: 'bili_look', summary: '看 B 站列表', tier: 'always', kind: 'read' },
  { name: 'bili_watch', summary: '看一条视频的画面', tier: 'always', kind: 'read' },
  { name: 'bili_speak', summary: '在评论区说话', tier: 'always', kind: 'send', safety: 'send' },
]
const BILI_NAMES = BILI.map((t) => t.name)
const HOST = new Set(BILI_NAMES)

const tracked = []
/** 断言这次贡献成功，并把 off 收进来兜底撤销。 */
function accept(result) {
  assert.equal(result.ok, true, result.why)
  tracked.push(result.off)
  return result
}

afterEach(() => {
  while (tracked.length) {
    try { tracked.pop()() } catch { /* ignore */ }
  }
  setAgentProbe(null)
  setHostNamesProvider(null)
})

test('贡献 3 个 bili 工具：8 条可见；撤销后回到 5', () => {
  assert.equal(OWN_TOOL_NAMES.length, 8, '内置自有工具是 8 个（新增 presence_speak）')
  const r = accept(contribute({ id: 't1-bili', tools: BILI }, { hostNames: HOST }))

  assert.equal(entriesFor('bili').length, 8, 'bili core 5 条 + 贡献 3 条')
  const allow = resolveAllow({ surface: 'bili', caps })
  assert.equal(allow.length, 8)
  for (const n of [...BILI_NAMES, 'growth_commit', 'read_image']) {
    assert.ok(allow.includes(n), `可见集合里少了 ${n}`)
  }
  for (const n of BILI_NAMES) assert.ok(ownTools().includes(n), `ownTools 里少了 ${n}`)

  r.off()
  assert.equal(entriesFor('bili').length, 5, '撤销后只剩 coreEntries')
  assert.equal(resolveAllow({ surface: 'bili', caps }).length, 5)
  for (const n of BILI_NAMES) assert.equal(ownTools().includes(n), false, `${n} 不该还在 ownTools 里`)
})

test('一个名字没注册：整次拒绝，一个好名字也不进去', () => {
  const before = entriesFor('bili').length
  const r = contribute(
    {
      id: 't2-bili',
      tools: [
        { name: 'bili_look', summary: '看 B 站列表', tier: 'always', kind: 'read' },
        { name: 'bili_watch', summary: '看一条视频的画面', tier: 'always', kind: 'read' },
      ],
    },
    { hostNames: new Set(['bili_look']) }, // bili_watch 没注册
  )
  assert.equal(r.ok, false)
  assert.equal(r.why, 'NOT_REGISTERED')
  assert.equal(r.detail, 'bili_watch')
  assert.equal(entriesFor('bili').length, before, '整次拒绝，视图不变')
  assert.equal(entriesFor('bili').some((e) => e.name === 'bili_look'), false, '好名字也不能半截进去')
})

test('同 id 同 payload 重复贡献是替换：旧 off 变空操作', () => {
  const first = accept(contribute({ id: 't3-bili', tools: BILI }, { hostNames: HOST }))
  assert.equal(entriesFor('bili').length, 8)

  const second = accept(contribute({ id: 't3-bili', tools: BILI }, { hostNames: HOST }))
  assert.equal(entriesFor('bili').length, 8)
  assert.equal(status().contributions.filter((c) => c.id === 't3-bili').length, 1, '同 id 只有一条')

  first.off()
  assert.equal(entriesFor('bili').length, 8, '被替换的旧 off 不该撤掉新贡献')

  second.off()
  assert.equal(entriesFor('bili').length, 5)
})

test('重名整次拒绝：payload 内、内置表、别的 id 都算', () => {
  const before = entriesFor('bili').length

  const dupInPayload = contribute(
    {
      id: 't4-dup',
      tools: [
        { name: 'bili_same', summary: '一', tier: 'always', kind: 'read' },
        { name: 'bili_same', summary: '二', tier: 'always', kind: 'read' },
      ],
    },
    { hostNames: new Set(['bili_same']) },
  )
  assert.equal(dupInPayload.ok, false)
  assert.equal(dupInPayload.why, 'NAME_TAKEN')

  const builtinClash = contribute(
    { id: 't4-builtin', tools: [{ name: 'wx_peek', summary: '看微信里有没有新消息', tier: 'always', kind: 'read' }] },
    { hostNames: new Set(['wx_peek']) },
  )
  assert.equal(builtinClash.ok, false)
  assert.equal(builtinClash.why, 'NAME_TAKEN')

  const other = accept(contribute(
    { id: 't4-a', tools: [{ name: 'bili_shared', summary: '共用名字', tier: 'always', kind: 'read' }] },
    { hostNames: new Set(['bili_shared']) },
  ))
  const crossId = contribute(
    { id: 't4-b', tools: [{ name: 'bili_shared', summary: '共用名字', tier: 'always', kind: 'read' }] },
    { hostNames: new Set(['bili_shared']) },
  )
  assert.equal(crossId.ok, false)
  assert.equal(crossId.why, 'NAME_TAKEN')

  assert.equal(entriesFor('bili').length, before + 1, '只有那条成功的贡献进了视图')
  other.off()
  assert.equal(entriesFor('bili').length, before)
})

test('形状校验：BAD_SURFACE / BAD_ID / BAD_TOOL；deferred 的组要进目录', () => {
  const one = { name: 'bili_x', summary: '某件事', tier: 'always', kind: 'read' }
  const host = new Set(['bili_x'])

  assert.equal(contribute({ id: 't5', tools: [one] }, { surface: 'nope', hostNames: host }).why, 'BAD_SURFACE')
  assert.equal(contribute({ id: '', tools: [one] }, { hostNames: host }).why, 'BAD_ID')
  assert.equal(
    contribute({ id: 't5', tools: [{ ...one, tier: 'deferred' }] }, { hostNames: host }).why,
    'BAD_TOOL',
    'deferred 必须有非空 group',
  )

  const r = accept(contribute(
    {
      id: 't5-deferred',
      tools: [{ name: 'bili_deep', summary: '翻更早的评论', tier: 'deferred', kind: 'read', group: 'bili.history' }],
    },
    { hostNames: new Set(['bili_deep']) },
  ))
  assert.equal(entriesFor('bili').length, 6)
  assert.ok(groupsFor('bili').includes('bili.history'), 'groupsFor 要列出贡献的组')
  assert.ok(catalog({ surface: 'bili', caps }).some((e) => e.name === 'bili_deep'), 'deferred 要进 catalog')

  r.off()
  assert.equal(groupsFor('bili').includes('bili.history'), false)
  assert.equal(entriesFor('bili').length, 5)
})

test('晚贡献被拒；同 id 同名字集合在探测为真时幂等成功', () => {
  setAgentProbe(() => true)
  const late = contribute({ id: 't6-late', tools: BILI }, { hostNames: HOST })
  assert.equal(late.ok, false)
  assert.equal(late.why, 'LATE_CONTRIBUTION')
  assert.equal(late.pending, true, '要告诉调用方需要重建会话')
  assert.equal(entriesFor('bili').length, 5, '晚贡献不改变视图')

  // 先正常贡献一份，再把探测打开，同 id 同名字重试 → 幂等成功。
  setAgentProbe(() => false)
  const early = accept(contribute({ id: 't6-bili', tools: BILI }, { hostNames: HOST }))
  setAgentProbe(() => true)
  const again = contribute({ id: 't6-bili', tools: BILI }, { hostNames: HOST })
  assert.equal(again.ok, true)
  assert.equal(entriesFor('bili').length, 8)
  assert.equal(status().contributions.filter((c) => c.id === 't6-bili').length, 1)

  again.off()
  assert.equal(entriesFor('bili').length, 5)
  early.off() // 已被 again.off 撤掉，再调一次不出事
  assert.equal(entriesFor('bili').length, 5)
})

test('status 给出贡献摘要', () => {
  const r = accept(contribute({ id: 't7-bili', tools: BILI, groups: [] }, { hostNames: HOST }))
  const contribution = status().contributions.find((c) => c.id === 't7-bili')
  assert.deepEqual(contribution, {
    id: 't7-bili',
    surface: 'bili',
    names: ['bili_look', 'bili_watch', 'bili_speak'],
    groups: [],
  })
  assert.deepEqual(status().surfaces, [...SURFACES])
  r.off()
  assert.equal(status().contributions.some((c) => c.id === 't7-bili'), false)
})

test('宿主名字：两个来源都没有时报 HOST_NAMES_UNKNOWN；只给一个就用那一个；都给就求交集', () => {
  assert.equal(contribute({ id: 't8-none', tools: BILI }, {}).why, 'HOST_NAMES_UNKNOWN')

  // 只有 provider：provider 就是有效集合。
  setHostNamesProvider(() => new Set(BILI_NAMES))
  const onlyProvider = accept(contribute({ id: 't8-provider', tools: BILI }, {}))
  onlyProvider.off()

  // 两个都给：交集。bili_speak 只在 hostNames 里、provider 不认 → 拒绝。
  setHostNamesProvider(() => new Set(['bili_look', 'bili_watch']))
  const intersect = contribute({ id: 't8-intersect', tools: BILI }, { hostNames: HOST })
  assert.equal(intersect.ok, false)
  assert.equal(intersect.why, 'NOT_REGISTERED')
  assert.equal(intersect.detail, 'bili_speak')
})
