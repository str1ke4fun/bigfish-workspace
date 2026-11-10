/**
 * schedule-hooks.test.mjs —— 调度钩子表（A1.5）
 *
 * 只测 lib/schedule-hooks.js 本身：不碰 scheduler、不碰网络。
 * 关注四件事：order + 串行、抛错隔离、everyMs 至少间隔、runWake 合并。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createScheduleHooks } from '../lib/schedule-hooks.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

test('runTick：按 order 升序串行执行，同 order 按注册顺序', async () => {
  const calls = []
  const hooks = createScheduleHooks()
  hooks.onTick({
    id: 'a', order: 20,
    async fn() { calls.push('a:start'); await delay(5); calls.push('a:end') },
  })
  hooks.onTick({ id: 'b', order: 10, async fn() { calls.push('b') } })
  hooks.onTick({ id: 'c', order: 10, async fn() { calls.push('c') } })

  const r = await hooks.runTick({})
  assert.deepEqual(calls, ['b', 'c', 'a:start', 'a:end'], 'order 小的先跑；串行，不并发')
  assert.deepEqual(r, { changed: false })
})

test('runTick：单个钩子抛错只记日志，后面的照跑，永不 reject', async () => {
  const logs = []
  const hooks = createScheduleHooks({ log: (...a) => logs.push(a.join(' ')) })
  let ran = false
  hooks.onTick({ id: 'bad', order: 1, async fn() { throw new Error('boom') } })
  hooks.onTick({ id: 'good', order: 2, async fn() { ran = true; return { changed: true } } })

  const r = await hooks.runTick({})
  assert.equal(r.changed, true)
  assert.equal(ran, true, '抛错不能挡住后面的钩子')
  assert.ok(
    logs.some((line) => line.includes('bad') && line.includes('boom')),
    `日志必须带 id 与 message：${JSON.stringify(logs)}`,
  )
})

test('runTick：everyMs 是至少间隔，0 表示每次都跑', async () => {
  const t0 = 1_700_000_000_000
  let n = 0
  const hooks = createScheduleHooks()
  hooks.onTick({ id: 'a', everyMs: 60_000, async fn() { n++ } })

  await hooks.runTick({ now: t0 })
  assert.equal(n, 1, '第一次没有 lastRun，直接跑')
  await hooks.runTick({ now: t0 + 30_000 })
  assert.equal(n, 1, '没到间隔就跳过')
  await hooks.runTick({ now: t0 + 61_000 })
  assert.equal(n, 2, '过了间隔再跑')

  // scheduler 传的是 Date（不是毫秒数）；两种都要认
  await hooks.runTick({ now: new Date(t0 + 62_000) })
  assert.equal(n, 2, 'Date 形式的 now 也要按毫秒算间隔')

  let m = 0
  const plain = createScheduleHooks()
  plain.onTick({ id: 'b', everyMs: 0, async fn() { m++ } })
  await plain.runTick({ now: t0 })
  await plain.runTick({ now: t0 + 1 })
  assert.equal(m, 2, 'everyMs: 0 每次都跑')
})

test('runTick：抛错的钩子也照样等下一个间隔', async () => {
  const t0 = 1_700_000_000_000
  let n = 0
  const hooks = createScheduleHooks({ log: () => {} })
  hooks.onTick({
    id: 'boom', everyMs: 60_000,
    async fn() { n++; throw new Error('x') },
  })

  await hooks.runTick({ now: t0 })
  await hooks.runTick({ now: t0 + 30_000 })
  assert.equal(n, 1, 'lastRun 在执行前就写了，抛错不能让它每次都重试')
})

test('runTick：changed 只认严格 true', async () => {
  let hooks = createScheduleHooks()
  hooks.onTick({ id: 'yes', async fn() { return { changed: true } } })
  assert.deepEqual(await hooks.runTick({}), { changed: true })

  hooks = createScheduleHooks()
  hooks.onTick({ id: 'undef', async fn() { /* 无返回 */ } })
  hooks.onTick({ id: 'other', async fn() { return { changed: 1 } } })
  assert.deepEqual(await hooks.runTick({}), { changed: false })
})

test('runWake：按 order 合并 text/intro/picks/riskNote，抛错不影响其它钩子', async () => {
  const logs = []
  const hooks = createScheduleHooks({ log: (...a) => logs.push(a.join(' ')) })
  hooks.onWake({
    id: 'late', order: 20,
    async fn() { return { text: 'T2', intro: '', picks: [{ bvid: 'BV2' }], riskNote: 'R2' } },
  })
  hooks.onWake({
    id: 'early', order: 10,
    async fn() { return { text: 'T1', intro: 'I1', picks: [{ bvid: 'BV1' }], riskNote: '' } },
  })
  hooks.onWake({ id: 'bad', order: 15, async fn() { throw new Error('wake-boom') } })

  const r = await hooks.runWake({})
  assert.equal(r.text, 'T1\n\nT2')
  assert.equal(r.intro, 'I1')
  assert.deepEqual(r.picks.map((p) => p.bvid), ['BV1', 'BV2'])
  assert.equal(r.riskNote, 'R2')
  assert.ok(logs.some((l) => l.includes('bad') && l.includes('wake-boom')))
})

test('runWake：都没有返回值时得到空结构', async () => {
  const hooks = createScheduleHooks()
  hooks.onWake({ id: 'a', async fn() { /* 无返回 */ } })
  hooks.onWake({ id: 'b', async fn() { return {} } })
  assert.deepEqual(await hooks.runWake({}), { text: '', intro: '', picks: [], riskNote: '' })
})

test('off / dispose：注销后不再执行，重复调用安全，dispose 后两张表都停', async () => {
  const hooks = createScheduleHooks()
  let ticks = 0
  let wakes = 0
  const offTick = hooks.onTick({ id: 't', async fn() { ticks++ } })
  hooks.onWake({ id: 'w', async fn() { wakes++ } })

  offTick()
  offTick()
  await hooks.runTick({})
  assert.equal(ticks, 0, 'off() 之后不再执行')
  assert.equal(hooks.status().tick.length, 0)

  hooks.dispose()
  hooks.dispose()
  const st = hooks.status()
  assert.equal(st.disposed, true)
  assert.deepEqual(st.tick, [])
  assert.deepEqual(st.wake, [])
  assert.deepEqual(await hooks.runTick({}), { changed: false })
  assert.deepEqual(await hooks.runWake({}), { text: '', intro: '', picks: [], riskNote: '' })
  assert.equal(wakes, 0)
})

test('status：形状与 lastRun', async () => {
  const t0 = 1_700_000_000_000
  const hooks = createScheduleHooks()
  hooks.onTick({ id: 'a', everyMs: 60_000, order: 5, async fn() {} })
  hooks.onWake({ id: 'b', order: 7, async fn() {} })
  assert.deepEqual(hooks.status().tick, [{ id: 'a', everyMs: 60_000, order: 5, lastRun: null }])
  assert.deepEqual(hooks.status().wake, [{ id: 'b', order: 7 }])
  await hooks.runTick({ now: t0 })
  assert.equal(hooks.status().tick[0].lastRun, t0)
  assert.equal(hooks.status().disposed, false)
})

test('参数校验：重复 id、缺 fn、空 id、非有限数都 throw', () => {
  const hooks = createScheduleHooks()
  hooks.onTick({ id: 'dup', fn: async () => {} })
  assert.throws(() => hooks.onWake({ id: 'dup', fn: async () => {} }), /dup/)

  assert.throws(() => hooks.onTick({ id: 'no-fn' }), /fn/)
  assert.throws(() => hooks.onTick({ id: '', fn: async () => {} }), /id/)
  assert.throws(() => hooks.onTick({ id: 'nonfinite', everyMs: Number.NaN, fn: async () => {} }), /everyMs/)
  assert.throws(() => hooks.onWake({ id: 'nonfinite-order', order: Number.POSITIVE_INFINITY, fn: async () => {} }), /order/)
})
