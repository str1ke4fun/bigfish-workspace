import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closingDue, runClosing, flushMissingReports, hasEventsOn } from '../lib/closing.js'
import { appendEvent, readEvents, writeDaily, paths } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-closing-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

const at = (h, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

const cfg = (closing = {}) => normalizeConfig({ memory: { closing: { enabled: true, time: '18:00', wake: false, diaryOnly: true, ...closing } } })

test('closingDue：未到点/已到点/已标记/禁用/坏时间', () => {
  const base = cfg()
  const dk = '2026-11-13'
  assert.equal(closingDue({ config: base, events: [], now: at(17, 59), dk }).due, false)
  assert.equal(closingDue({ config: base, events: [], now: at(18, 0), dk }).due, true)
  assert.equal(closingDue({ config: base, events: [{ type: 'meta', text: `closing:${dk} report` }], now: at(19), dk }).due, false)
  assert.equal(closingDue({ config: cfg({ enabled: false }), events: [], now: at(19), dk }).due, false)
  // normalizeConfig 会把坏时间回退成 18:00；这里直接传原始配置测 closingDue 的兜底。
  assert.equal(closingDue({ config: { memory: { closing: { enabled: true, time: '25:00' } } }, events: [], now: at(19), dk }).why, 'bad-time')
})

test('runClosing：wake=false 只写报告和 closing: report', async () => {
  await withRoot(async (root) => {
    const now = at(19)
    const dk = dateKey(now)
    await appendEvent({ type: 'seed', text: '种', source: 'system' }, { day: 1, stage: 1, source: 'system' }, root)
    const r = await runClosing({ get: () => ({}) }, { root, config: cfg(), now, dk })
    assert.equal(r.ok, true)
    assert.equal(r.woke, false)
    await access(join(paths(root).outDir, `${dk}.md`))
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.text === `closing:${dk} report`))
    assert.ok(!events.some((e) => e.text.startsWith(`closing:${dk} wake`)))
  })
})

test('runClosing：当天已有日记时只写报告，不唤醒', async () => {
  await withRoot(async (root) => {
    const now = at(19)
    const dk = dateKey(now)
    await appendEvent({ type: 'seed', text: '种', source: 'system' }, { day: 1, stage: 1, source: 'system' }, root)
    await writeDaily('diaryDir', dk, '今天写了一笔。', root)
    const r = await runClosing({ get: () => ({}) }, { root, config: cfg({ wake: true }), now, dk })
    assert.equal(r.ok, true)
    assert.equal(r.woke, false)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.text === `closing:${dk} report,diary-present`))
  })
})

test('hasEventsOn 用本地日期口径', () => {
  const dk = '2026-11-13'
  assert.equal(hasEventsOn([{ ts: new Date(2026, 10, 13, 12).toISOString() }], dk), true)
  assert.equal(hasEventsOn([{ ts: new Date(2026, 10, 12, 12).toISOString() }], dk), false)
})

test('flushMissingReports：补今天/昨天，已有报告不覆盖', async () => {
  await withRoot(async (root) => {
    const now = at(19)
    const today = dateKey(now)
    const yesterday = dateKey(new Date(now.getTime() - 86_400_000))
    await appendEvent({ type: 'seed', text: '种', source: 'system' }, { day: 1, stage: 1, source: 'system' }, root)
    // 昨天造一条事件 + 一份已有报告；今天只有事件。
    await appendEvent({
      type: 'meta',
      text: `seen:${new Date(now.getTime() - 86_400_000).toISOString()}`,
      ts: new Date(now.getTime() - 86_400_000).toISOString(),
    }, { source: 'system' }, root)
    await writeDaily('diaryDir', yesterday, '昨天', root)
    const first = await flushMissingReports(root, { now })
    assert.equal(first.ok, true)
    assert.deepEqual(first.wrote.sort(), [today, yesterday].sort())
    const second = await flushMissingReports(root, { now })
    assert.deepEqual(second.wrote, [], '已有报告不覆盖')
  })
})
