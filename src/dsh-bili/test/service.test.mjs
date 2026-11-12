/**
 * service.test.mjs —— `bili` 服务层（core 代理与工作台共用的一份实现）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBiliService } from '../lib/service.js'
import { setCore } from '../lib/core.js'
import { dateKey } from '../lib/support.js'
import { fakeCore } from './helpers.mjs'

const BV = 'BV1xx411c7mD'

async function withService(fn, { events = [], config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-service-'))
  const { core } = fakeCore({ events, config })
  setCore(core)
  try {
    return await fn({ service: createBiliService({ root }), root, events })
  } finally {
    setCore(null)
  }
}

test('status：今日刷站/出门、风控、出门会话都从事件流与运行文件算', async () => {
  const dk = dateKey()
  const events = [
    { type: 'meta', text: `browse:${dk} [{"bvid":"${BV}"}]`, ts: '2026-11-12T09:00:00Z' },
    { type: 'meta', text: `biliout:${dk} browse`, ts: '2026-11-12T09:10:00Z' },
  ]
  await withService(async ({ service, root }) => {
    await writeFile(join(root, 'bili-session.json'), JSON.stringify({ sessionId: 's1', title: '去 B 站' }))
    const st = await service.status()
    assert.equal(st.installed, true)
    assert.equal(st.browsedToday, 1)
    assert.equal(st.outingsToday, 1)
    assert.equal(st.sessionId, 's1')
    assert.equal(st.sessionReused, true)
    assert.equal(st.cooling, false)
    assert.equal(st.browseEnabled, false)
  }, { events })
})

test('browse：候选、今天看过的 BV、配额与避让都摆出来', async () => {
  const dk = dateKey()
  const events = [
    { type: 'meta', text: `browse:${dk} [{"bvid":"${BV}","title":"标题"}]`, ts: '2026-11-12T09:00:00Z' },
    { type: 'meta', text: `looked:${BV}`, ts: '2026-11-12T09:01:00Z' },
  ]
  await withService(async ({ service }) => {
    const r = await service.browse()
    assert.equal(r.items.length, 1)
    assert.equal(r.usedToday, 1)
    assert.equal(r.lookedCount, 1)
    assert.deepEqual(r.lookedRecent, [BV])
  }, { events, config: { browse: { enabled: true, perDay: 2, topN: 4, keywords: ['x'] }, avoid: { keywords: ['y'], upMids: [1], minDuration: 60 } } })
})

test('history / footprint：只从事件流派生，不新增落盘', async () => {
  const events = [
    { type: 'meta', text: `browse:2026-11-11 [{"bvid":"${BV}","title":"昨天的"}]`, ts: '2026-11-11T09:00:00Z' },
  ]
  await withService(async ({ service, root }) => {
    const h = await service.history({ days: 14 })
    assert.equal(h.days, 14)
    assert.equal(h.total, 1)
    assert.equal(h.groups[0].date, '2026-11-11')
    const f = await service.footprint({ days: 30 })
    assert.equal(f.days, 30)
    assert.ok(Array.isArray(f.viewed.rows))
    assert.ok(Array.isArray(f.comments.rows))
    const before = (await import('node:fs')).readdirSync(root).length
    assert.equal(before, 0, '这些查询不该往状态库里写东西')
  }, { events })
})

test('commentBody / comment / cover：非法参数与缺图都明确失败', async () => {
  await withService(async ({ service, root }) => {
    assert.deepEqual(await service.commentBody({ bvid: 'nope', rpid: 1 }), { ok: false, status: 400, error: '参数不对：需要 bvid 和 rpid' })
    const c = await service.commentStatus()
    assert.equal(c.enabled, false)
    assert.equal(c.waitingCount, 0)
    assert.equal(await service.cover('nope'), null)
    await mkdir(join(root, 'out', 'covers'), { recursive: true })
    await writeFile(join(root, 'out', 'covers', `${BV}.jpg`), Buffer.from([0xff, 0xd8]))
    const img = await service.cover(BV)
    assert.equal(img.contentType, 'image/jpeg')
    assert.equal(img.buf.length, 2)
  })
})

test('risk：读状态、POST clear 解冻，返回 cleared 标记', async () => {
  await withService(async ({ service, root }) => {
    const before = await service.risk()
    assert.equal(before.cooling, false)
    assert.equal(before.until, 0)
    assert.equal(before.cleared, false)

    const until = Date.now() + 5 * 60_000
    await writeFile(join(root, 'risk.json'), JSON.stringify({ until, code: '-352', at: '', strikes: 1 }))
    const cooling = await service.risk()
    assert.equal(cooling.cooling, true)
    assert.equal(cooling.until, until)
    assert.equal(cooling.code, '-352')
    assert.equal(cooling.strikes, 1)

    const after = await service.risk({ clear: true })
    assert.equal(after.cleared, true)
    assert.equal(after.until, 0)
  })
})

test('outings：配额、最近一次、会话标题与扫描间隔', async () => {
  const dk = dateKey()
  const events = [
    { type: 'meta', text: `biliout:${dk} replies`, ts: new Date().toISOString() },
  ]
  await withService(async ({ service, root }) => {
    await writeFile(join(root, 'bili-session.json'), JSON.stringify({ sessionId: 's2' }))
    const o = await service.outings()
    assert.equal(o.quota, 1)
    assert.equal(o.usedToday, 1)
    assert.ok(o.lastAt > 0)
    assert.equal(o.sessionId, 's2')
    assert.equal(o.sessionTitle, '去 B 站')
    assert.equal(o.scanEveryMin, 30)
  }, { events })
})

test('ledger：服务不在时给 NO_LEDGER，在时原样转发查询', async () => {
  await withService(async ({ service }) => {
    const r = await service.ledger({ limit: 5 })
    assert.equal(r.ok, true)
    assert.equal(r.query.limit, 5)
    assert.ok(Array.isArray(r.rows))
  })
})

test('sheet：非法 bvid 直接 null，不去抽帧', async () => {
  await withService(async ({ service }) => {
    assert.equal(await service.sheet('not-a-bv'), null)
  })
})

test('recentMaterial：最近几条 saw 倒序，正文截断', async () => {
  const events = [
    { type: 'saw', ts: '2026-11-12T09:00:00Z', text: 'a'.repeat(500) },
    { type: 'saw', ts: '2026-11-12T10:00:00Z', text: '后来的' },
  ]
  await withService(async ({ service }) => {
    const r = await service.recentMaterial(2)
    assert.equal(r.saw.length, 2)
    assert.equal(r.saw[0].text, '后来的')
    assert.equal(r.saw[1].text.length, 400)
  }, { events })
})
