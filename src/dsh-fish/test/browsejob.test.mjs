/**
 * browsejob.test.mjs —— 后台刷站（2026-11-03）
 *
 * 守的是三件事：
 *   1. 刷站时刻均匀铺在 browse.window 里，不写盘、可复现；
 *   2. 有唤醒排着时先给唤醒留配额，别把当天素材提前用光；
 *   3. 后台刷站不碰会话、不写 wake:，只写 browse:（报告）和 saw（记忆）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/settings.js'
import { readEvents, appendEvent } from '../lib/store.js'
import {
  browseSlots, browseBudget, backgroundBrowse, lastBrowseAt, BROWSE_MIN_GAP_MS,
} from '../lib/browsejob.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-browsejob-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const v = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 1001, title: '一个普通的视频', up: '某UP', mid: 42,
  duration: 600, view: 100000, like: 5000, danmaku: 200, ...over,
})

function fakeClient() {
  return {
    popular: async () => ({ ok: true, data: [v({ bvid: 'BVpop1' }), v({ bvid: 'BVpop2' })] }),
    ranking: async () => ({ ok: true, data: [v({ bvid: 'BVrank1' })] }),
    precious: async () => ({ ok: true, data: [v({ bvid: 'BVold1' })] }),
    search: async () => ({ ok: true, data: [] }),
    view: async (bvid) => ({ ok: true, data: { desc: `简介 ${bvid}`, pubdate: 1700000000, cid: 555, aid: 1001, title: `标题 ${bvid}`, up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常', '生活'] }),
    replies: async () => ({ ok: true, data: [{ text: '热评一', like: 99 }] }),
    danmaku: async () => ({ ok: true, data: [{ t: 12, text: '这句是弹幕' }] }),
  }
}

test('browseSlots：按 perDay 均匀铺在窗口里，顺序稳定且可复现', () => {
  const cfg = normalizeConfig({ browse: { window: ['08:00', '23:00'], perDay: 3 } })
  const a = browseSlots(cfg, '2026-11-03')
  const b = browseSlots(cfg, '2026-11-03')
  assert.equal(a.length, 3)
  assert.deepEqual(a, b, '同一个日期必须算出一模一样的时刻')
  assert.deepEqual([...a].sort((x, y) => x - y), a, '必须是升序')

  const day = new Date(2026, 10, 3, 0, 0, 0, 0).getTime()
  for (const t of a) {
    const minutes = (t - day) / 60_000
    assert.ok(minutes >= 8 * 60 && minutes <= 23 * 60, '不能跑到窗口外')
  }
  // 三次之间大致等距：每个间隔都不小于窗口的 1/4
  const span = 15 * 60
  assert.ok(a[1] - a[0] > span / 4 * 60_000 * 0.5)
  assert.ok(a[2] - a[1] > span / 4 * 60_000 * 0.5)
})

test('browseSlots：perDay=0 或跨零点窗口都不炸', () => {
  assert.deepEqual(browseSlots(normalizeConfig({ browse: { perDay: 0 } }), '2026-11-03'), [])
  const cfg = normalizeConfig({ browse: { window: ['22:00', '02:00'], perDay: 2 } })
  const slots = browseSlots(cfg, '2026-11-03')
  assert.equal(slots.length, 2)
  assert.ok(slots[0] < slots[1])
})

test('browseBudget：还没醒的那次先留配额；醒过之后可以后台用完', async () => {
  await withRoot(async (root) => {
    const cfg = normalizeConfig({ browse: { perDay: 3 }, wakesPerDay: 1, daily: { events: 2 } })
    let b = browseBudget(cfg, [], '2026-11-03')
    assert.equal(b.perDay, 3)
    assert.equal(b.reserve, 1, '还有一次唤醒没发生，先留一次')
    assert.equal(b.free, 2)

    await appendEvent({ type: 'meta', text: 'wake:2026-11-03 test_first' }, { day: 1, stage: 1, source: 'timer' }, root)
    const { events } = await readEvents(root)
    b = browseBudget(cfg, events, '2026-11-03')
    assert.equal(b.reserve, 0, '今天已经醒过，不用再留')
    assert.equal(b.free, 3)
  })
})

test('backgroundBrowse：只写 browse: 和 saw，绝不写 wake:', async () => {
  await withRoot(async (root) => {
    const cfg = normalizeConfig({
      wakesPerDay: 0,
      browse: { enabled: true, perDay: 3, topN: 2, deepRead: 1, danmaku: 0, window: ['00:00', '23:00'] },
    })
    const now = new Date(2026, 10, 3, 23, 0, 0).getTime()
    const r = await backgroundBrowse({ root, config: cfg, events: [], dk: '2026-11-03', now, deps: { client: fakeClient() } })
    assert.equal(r.ok, true)
    assert.ok(r.picks.length >= 1)

    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'meta' && String(e.text).startsWith('browse:2026-11-03')))
    assert.ok(events.some((e) => e.type === 'saw' && e.text.startsWith('B站')))
    assert.ok(!events.some((e) => e.type === 'meta' && String(e.text).startsWith('wake:')))
  })
})

test('backgroundBrowse：窗口外 / 还有唤醒没发生 → 一次都不刷', async () => {
  await withRoot(async (root) => {
    const outside = normalizeConfig({ wakesPerDay: 0, browse: { perDay: 3, window: ['08:00', '23:00'] } })
    const r1 = await backgroundBrowse({
      root, config: outside, events: [], dk: '2026-11-03',
      now: new Date(2026, 10, 3, 3, 0, 0).getTime(), deps: { client: fakeClient() },
    })
    assert.equal(r1.ok, false)
    assert.equal(r1.why, 'outside-window')

    const reserved = normalizeConfig({ wakesPerDay: 1, daily: { events: 2 }, browse: { perDay: 1, window: ['00:00', '23:00'] } })
    const r2 = await backgroundBrowse({
      root, config: reserved, events: [], dk: '2026-11-03',
      now: new Date(2026, 10, 3, 23, 0, 0).getTime(), deps: { client: fakeClient() },
    })
    assert.equal(r2.ok, false)
    assert.equal(r2.why, 'reserved-for-wake')

    const { events } = await readEvents(root)
    assert.equal(events.length, 0, '被拦住时不能留下任何记账')
  })
})

test('backgroundBrowse：刚刷过就等一会儿，不连着刷', async () => {
  await withRoot(async (root) => {
    const now = new Date(2026, 10, 3, 23, 0, 0).getTime()
    await appendEvent(
      { type: 'meta', text: 'browse:2026-11-03 []', ts: new Date(now - 60_000).toISOString() },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    const { events } = await readEvents(root)
    assert.ok(lastBrowseAt(events) > 0)
    const cfg = normalizeConfig({ wakesPerDay: 0, browse: { perDay: 3, window: ['00:00', '23:00'] } })
    const r = await backgroundBrowse({ root, config: cfg, events, dk: '2026-11-03', now, deps: { client: fakeClient() } })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'min-gap')
    assert.ok(BROWSE_MIN_GAP_MS > 60_000)
  })
})
