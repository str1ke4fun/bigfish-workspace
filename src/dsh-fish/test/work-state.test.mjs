import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkState,
  mapSettlement,
  newUnitId,
  sanitizeGuardHit,
  sanitizeReport,
  truncateSummary,
} from '../lib/work-state.js'

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'fish-work-state-'))
}

function unitInput(over = {}, dir = '/tmp/proj') {
  return {
    id: 'wu_test',
    dir,
    bossSessionId: 'boss-1',
    bossKind: 'fish',
    backend: 'subagent',
    mode: 'inspect',
    label: '看看',
    ...over,
  }
}

test('newUnitId 稳定带 wu_ 前缀', () => {
  assert.match(newUnitId(1000), /^wu_[a-z0-9]+$/)
  assert.notEqual(newUnitId(1000), newUnitId(1000))
})

test('mapSettlement 按 stopReason / blocker 映射', () => {
  assert.deepEqual(
    mapSettlement({ stopReason: 'completed', structured: { summary: '好了', done: true } }),
    { status: 'done', stopReason: 'completed', failureKind: null, summary: '好了', report: { summary: '好了', done: true } },
  )
  assert.equal(
    mapSettlement({ stopReason: 'completed', structured: { summary: '差点', done: false, blockers: ['缺权限'] } }).status,
    'blocked',
  )
  assert.equal(mapSettlement({ stopReason: 'completed', structured: { summary: '差点', blockers: ['x'] } }).status, 'blocked')
  assert.equal(mapSettlement({ stopReason: 'aborted' }).status, 'aborted')
  assert.equal(mapSettlement({ stopReason: 'error' }).status, 'failed')
  assert.equal(mapSettlement({ stopReason: 'max-tokens' }).status, 'failed')
  assert.equal(mapSettlement({ stopReason: 'refusal' }).status, 'failed')
  assert.equal(mapSettlement({ stopReason: 'completed', structured: null, requestedSchema: true }).status, 'failed')
  assert.equal(
    mapSettlement({ stopReason: 'completed', structured: null, requestedSchema: true }).failureKind,
    'structured-missing-or-error',
  )
})

test('summary / report / guardHits 都有界', () => {
  assert.equal(truncateSummary('a\nb'.repeat(2000)).includes('\n'), false)
  assert.ok([...truncateSummary('字'.repeat(5000))].length <= 2000)
  const report = sanitizeReport({
    summary: 's',
    filesChanged: Array.from({ length: 30 }, (_, i) => `f${i}`),
    verification: ['v'.repeat(900)],
    teammates: Array.from({ length: 20 }, () => ({ name: 'x', summary: 'y' })),
  })
  assert.equal(report.filesChanged.length, 20)
  assert.ok(report.verification[0].length <= 500)
  assert.equal(report.teammates.length, 16)
  assert.equal(sanitizeGuardHit('  读 ~/.ssh/id_rsa  ').includes('id_rsa'), false)
  assert.ok(sanitizeGuardHit('x'.repeat(500)).length <= 200)
})

test('WorkUnit 原子落盘、0600、读回一致', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  await state.createUnit(unitInput())
  const file = state.unitsPath
  const st = await stat(file)
  assert.equal(st.mode & 0o777, 0o600)
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.units.length, 1)
  assert.equal(raw.units[0].status, 'queued')
  assert.equal(raw.units[0].id, 'wu_test')
  assert.equal(state.readUnits().units.length, 1)
})

test('结算只写一次，重复结算被忽略', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  await state.createUnit(unitInput({ id: 'wu_1' }))
  const first = await state.settleUnit('wu_1', {
    stopReason: 'completed',
    structured: { summary: '好了', done: true },
    requestedSchema: true,
  })
  assert.equal(first.status, 'done')
  const second = await state.settleUnit('wu_1', { stopReason: 'error', closingText: '迟到' })
  assert.equal(second, null)
  assert.equal(state.readUnits().units[0].summary, '好了')
})

test('活跃计数只算 queued/running，unknown 不占名额', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  await state.createUnit(unitInput({ id: 'wu_a', mode: 'build' }))
  await state.createUnit(unitInput({ id: 'wu_b', mode: 'inspect' }))
  await state.updateUnit('wu_a', { status: 'running' })
  await state.updateUnit('wu_b', { status: 'unknown' })
  assert.deepEqual(state.activeCounts('boss-1'), { active: 1, build: 1 })
})

test('保留 200 条，先淘汰最旧的已结算', async () => {
  const root = await tempRoot()
  let t = 1
  const state = createWorkState({ root, now: () => t++ })
  await state.createUnit(unitInput({ id: 'wu_active' }))
  await state.updateUnit('wu_active', { status: 'running' })
  for (let i = 0; i < 205; i += 1) {
    await state.createUnit(unitInput({ id: `wu_${i}` }))
    await state.settleUnit(`wu_${i}`, { stopReason: 'completed', closingText: 'ok' })
  }
  const units = state.readUnits().units
  assert.equal(units.length, 200)
  assert.ok(units.some((u) => u.id === 'wu_active'))
  assert.equal(units.some((u) => u.id === 'wu_0'), false)
})

test('坏文件按空处理并另存 .corrupt', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root })
  await writeFile(state.unitsPath, '{not json', 'utf8')
  assert.deepEqual(state.readUnits(), { version: 1, units: [] })
  const names = await readFile(state.unitsPath, 'utf8').catch(() => null)
  assert.equal(names, null)
  const { readdir } = await import('node:fs/promises')
  assert.ok((await readdir(root)).some((n) => n.startsWith('work-units.json.corrupt.')))
})

test('guardHits 有界、脱敏、终态后不再追加', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  await state.createUnit(unitInput({ id: 'wu_g' }))
  for (let i = 0; i < 12; i += 1) await state.appendGuardHit('wu_g', `bash: 读 ~/.ssh/id_${i}`)
  const unit = state.readUnits().units[0]
  assert.equal(unit.guardHits.length, 10)
  for (const hit of unit.guardHits) assert.equal(hit.includes('~/.ssh'), false)
  await state.settleUnit('wu_g', { stopReason: 'aborted' })
  assert.equal(await state.appendGuardHit('wu_g', 'bash: 迟到'), false)
})

test('结构化报告命中秘密时整份丢掉，只留通用文案', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000, looksLikeSecret: () => ({ hit: true }) })
  await state.createUnit(unitInput({ id: 'wu_secret' }))
  const unit = await state.settleUnit('wu_secret', {
    stopReason: 'completed',
    structured: { summary: '看了 token', filesChanged: ['/home/u/.ssh/id_rsa'], done: true },
    requestedSchema: true,
  })
  assert.equal(unit.summary, '详情在电脑上')
  assert.equal(unit.report, null)
})

test('sessions 映射原子读写，保留最近 20 个目录', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  for (let i = 0; i < 25; i += 1) {
    await state.mutateSessions((s) => {
      s[`/tmp/p${i}`] = { sessionId: `s${i}`, lastUsedAt: new Date(1000 + i).toISOString(), state: 'idle' }
    })
  }
  const sessions = state.readSessions()
  assert.equal(Object.keys(sessions).length, 20)
  assert.equal(sessions['/tmp/p0'], undefined)
  assert.ok(sessions['/tmp/p24'])
})

test('reconcileRunning 把 queued/running 记 unknown，不写 done', async () => {
  const root = await tempRoot()
  const state = createWorkState({ root, now: () => 1000 })
  await state.createUnit(unitInput({ id: 'wu_q' }))
  await state.createUnit(unitInput({ id: 'wu_r' }))
  await state.updateUnit('wu_r', { status: 'running' })
  await state.createUnit(unitInput({ id: 'wu_d' }))
  await state.settleUnit('wu_d', { stopReason: 'completed' })
  assert.equal(await state.reconcileRunning(), 2)
  const byId = Object.fromEntries(state.readUnits().units.map((u) => [u.id, u]))
  assert.equal(byId.wu_q.status, 'unknown')
  assert.equal(byId.wu_r.status, 'unknown')
  assert.equal(byId.wu_d.status, 'done')
})
