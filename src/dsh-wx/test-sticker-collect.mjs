// 收藏收到的表情：node --test 或 node test-sticker-collect.mjs
// 用假 run()/look()/ocr() 模拟右键菜单，不启动微信、不点真实菜单项。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PANEL, TAB } from './lib/sticker-image.js'
import { loadIndex } from './lib/sticker-index.js'
import { scanStickers } from './lib/sticker-scan.js'
import { collectSticker, findMenuLabel, menuClickPoint, parseMenuGeometry, pickCollected } from './lib/sticker-collect.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const NOW = Date.UTC(2026, 10, 5, 4, 0, 0)
const WIN = { ox: 261, oy: 117, w: 916, h: 666 }
const MENU = '12582970 707 256 169 231'

function draw(g, w, x, y, size, id) {
  const block = size / 4
  let seed = (id * 1234567 + 1) >>> 0
  const vals = Array.from({ length: 16 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return 30 + (seed % 200)
  })
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const bi = Math.floor(yy / block) * 4 + Math.floor(xx / block)
      g[(y + yy) * w + x + xx] = vals[bi]
    }
  }
}

function panel({ cells = 7, base = 0 } = {}) {
  const g = new Uint8Array(PANEL.w * PANEL.h).fill(250)
  for (let y = 448; y < 478; y++) for (let x = TAB.heart.x - 16; x <= TAB.heart.x + 16; x++) g[y * PANEL.w + x] = 238
  for (let i = 0; i < cells; i++) {
    const x = PANEL.firstX + (i % 5) * PANEL.pitchX
    const y = PANEL.firstY + Math.floor(i / 5) * PANEL.pitchY
    draw(g, PANEL.w, x, y, PANEL.cell, base + i)
  }
  return g
}

// 聊天区一行：左边头像，中间表情；表情 id 用来和面板格子对齐。
function chatRow({ sticker = true, stickerId = 0, w = 602, h = 158 } = {}) {
  const g = new Uint8Array(w * h).fill(245)
  draw(g, w, 20, 20, 40, 77)
  if (sticker) draw(g, w, 100, 20, 132, stickerId)
  return g
}

const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  "5\t1\t1\t1\t1\t1\t39\t16\t27\t11\t81\t'Add",
  '5\t1\t1\t1\t1\t2\t72\t16\t50\t11\t95\tSticker',
  '5\t1\t1\t1\t2\t1\t16\t58\t12\t12\t54\t®',
  '5\t1\t1\t1\t2\t2\t40\t58\t70\t11\t95\tForward...',
  '5\t1\t1\t1\t3\t1\t40\t203\t46\t11\t96\tDelete',
].join('\n')

const TSV_NO_ADD = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t40\t58\t70\t11\t95\tForward...',
  '5\t1\t1\t1\t2\t1\t40\t203\t46\t11\t96\tDelete',
].join('\n')

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-sticker-collect-'))
const stickerBox = { cx: 876, cy: 244, x: 575, y: 165, w: 602, h: 158 }

function fake({ row, tsv = TSV, panelGray, menu = MENU, lookMessages } = {}) {
  const calls = []
  const clicks = []
  const run = async (args) => {
    calls.push([...args])
    switch (args[0]) {
      case 'click': clicks.push([Number(args[1]), Number(args[2]), Number(args[3] ?? 1)]); return '点了'
      case 'win-gray': {
        const w = Number(args[3]); const h = Number(args[4])
        const out = row ?? new Uint8Array(w * h).fill(245)
        if (out.length !== w * h) throw new Error('测试行图尺寸不对')
        return Buffer.from(out).toString('base64')
      }
      case 'menu-shot': writeFileSync(args[1], 'fake-menu-png'); return menu
      case 'panel-open': return '2097194 363 247 485 485'
      case 'panel-click': clicks.push([Number(args[1]), Number(args[2]), 1]); return '点了'
      case 'panel-scroll-up':
      case 'panel-park': return 'ok'
      case 'panel-shot': writeFileSync(args[1], 'fake-png'); return '2097194 485 485'
      case 'panel-gray': return Buffer.from(panelGray ?? panel()).toString('base64')
      case 'panel-thumb': writeFileSync(args[6], 'fake-thumb'); return 'ok'
      case 'panel-close': return 'closed'
      case 'clean': return '关掉 1 个浮层'
      default: throw new Error('测试里不该执行：' + args.join(' '))
    }
  }
  const messages = lookMessages ?? [{ text: 'Animated Stickers [哟]', kind: 'sticker', box: stickerBox }]
  const look = async () => ({ parsed: { ok: true, current: '测试会话', window: WIN, messages } })
  const ocr = async () => tsv
  return { run, look, ocr, calls, clicks }
}

async function scanned(dir, opts = {}) {
  const f = fake(opts)
  await scanStickers({ run: f.run, dir, now: NOW })
  return loadIndex(dir).index
}

console.log('纯逻辑')
await t('菜单几何：解析 id/x/y/w/h', () => {
  assert.deepEqual(parseMenuGeometry(MENU), { id: 12582970, x: 707, y: 256, w: 169, h: 231 })
  assert.throws(() => parseMenuGeometry(''), /菜单/)
})

await t('OCR 定位 Add Sticker：按行合并，不碰 Delete', () => {
  const hit = findMenuLabel(TSV)
  assert.ok(hit)
  assert.equal(Math.round(hit.x), 39)
  assert.equal(Math.round(hit.y), 16)
  assert.equal(Math.round(hit.w), 83)
  assert.equal(hit.label, 'add sticker')
  assert.equal(findMenuLabel(TSV_NO_ADD), null)
})

await t('OCR 也认中文“添加/收藏表情”', () => {
  const cn = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t30\t16\t40\t14\t88\t添加到',
    '5\t1\t1\t1\t1\t2\t74\t16\t30\t14\t88\t表情',
    '5\t1\t1\t1\t2\t1\t30\t200\t40\t14\t88\t删除',
  ].join('\n')
  const hit = findMenuLabel(cn)
  assert.ok(hit)
  assert.match(hit.label, /添加.*表情/)
})

await t('OCR 框必须落在菜单里，否则算识别不可信', () => {
  const bad = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t300\t16\t50\t11\t95\tAdd',
    '5\t1\t1\t1\t1\t2\t360\t16\t50\t11\t95\tSticker',
  ].join('\n')
  assert.equal(findMenuLabel(bad, { w: 169, h: 231 }), null)
})

await t('菜单项中心换算成屏幕坐标', () => {
  assert.deepEqual(
    menuClickPoint({ x: 39, y: 16, w: 83, h: 11 }, parseMenuGeometry(MENU)),
    { x: 788, y: 278 },
  )
})

console.log('收藏判定')
await t('距离在严格阈值内：高置信度确认', () => {
  const r = pickCollected(
    [{ id: 'old-a', distance: 5 }, { id: 'old-b', distance: 30 }],
    { prevIds: new Set(['old-a', 'old-b']) },
  )
  assert.equal(r.confirmed, true)
  assert.equal(r.confidence, 'high')
  assert.equal(r.id, 'old-a')
})

await t('动画表情换帧导致距离超阈值：重扫新出现的条目最近且明显领先，低置信度确认', () => {
  const r = pickCollected(
    [{ id: 'new-cat', distance: 23 }, { id: 'old-cat', distance: 30 }],
    { prevIds: new Set(['old-cat']) },
  )
  assert.equal(r.confirmed, true)
  assert.equal(r.confidence, 'low')
  assert.equal(r.id, 'new-cat')
  assert.equal(r.margin, 7)
})

await t('最近的是旧条目：不确认（收藏可能没加上）', () => {
  const r = pickCollected(
    [{ id: 'old-cat', distance: 20 }, { id: 'new-x', distance: 31 }],
    { prevIds: new Set(['old-cat']) },
  )
  assert.equal(r.confirmed, false)
  assert.equal(r.confidence, 'none')
  assert.match(r.reason, /旧条目|not-new/)
})

await t('新条目最近但领先不够：不猜', () => {
  const r = pickCollected(
    [{ id: 'new-x', distance: 24 }, { id: 'old-y', distance: 27 }],
    { prevIds: new Set(['old-y']) },
  )
  assert.equal(r.confirmed, false)
  assert.match(r.reason, /不够|ambiguous/)
})

await t('新条目最近但距离太远：不确认', () => {
  const r = pickCollected(
    [{ id: 'new-x', distance: 34 }, { id: 'old-y', distance: 46 }],
    { prevIds: new Set(['old-y']) },
  )
  assert.equal(r.confirmed, false)
  assert.match(r.reason, /太远|far/)
})

console.log('采集编排')
await t('成功：右键气泡 → 点 Add Sticker → 重扫认回', async () => {
  const dir = tmp()
  try {
    const index = await scanned(dir)
    const target = index.entries[0]
    // 面板第一格画成和气泡一样；fake 的 panelGray 需要带上索引里的图案：用扫描时的同一张图
    const f = fake({ row: chatRow({ stickerId: 0 }) })
    const r = await collectSticker({
      run: f.run, dir, look: f.look, ocr: f.ocr, wait: async () => {}, log: () => {},
    })
    assert.equal(r.confirmed, true)
    assert.equal(r.id, target.id)
    assert.ok(r.distance <= 10, `distance=${r.distance}`)
    // 右键点在气泡中心（741,251）；左键点在 Add Sticker 文字框中心（788,278），不是 Delete（747,459）
    assert.deepEqual(f.clicks[0], [741, 251, 3])
    assert.deepEqual(f.clicks[1], [788, 278, 1])
    assert.ok(!f.clicks.some((c) => c[0] === 747 && c[1] === 459), '不应该点到 Delete')
    assert.ok(f.calls.some((c) => c[0] === 'panel-close'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('动画表情换帧：收藏多出一格且新条目明显最近 → 低置信度确认', async () => {
  const dir = tmp()
  try {
    // 点击前收藏只有 6 格。
    await scanned(dir, { panelGray: panel({ cells: 6 }) })
    assert.equal(loadIndex(dir).index.entries.length, 6)
    // 点击后 7 格；气泡图案和第 7 格（新收藏）dHash 距离 16，其他格都在 28 以上。
    const f = fake({ row: chatRow({ stickerId: 109 }), panelGray: panel({ cells: 7 }) })
    const r = await collectSticker({
      run: f.run, dir, look: f.look, ocr: f.ocr, wait: async () => {}, log: () => {},
    })
    assert.equal(r.confirmed, true)
    assert.equal(r.confidence, 'low')
    assert.equal(r.distance, 16)
    assert.ok(r.margin >= 6, `margin=${r.margin}`)
    assert.match(r.receipt, /低置信度/)
    const added = loadIndex(dir).index.entries.find((e) => e.id === r.id)
    assert.deepEqual({ row: added.pos.row, col: added.pos.col }, { row: 1, col: 1 })
    // 仍然只点了右键和 Add Sticker，没有碰 Delete。
    assert.deepEqual(f.clicks.slice(0, 2), [[741, 251, 3], [788, 278, 1]])
    assert.ok(!f.clicks.some((c) => c[0] === 747 && c[1] === 459), '不应该点到 Delete')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('菜单没有 Add Sticker：不点任何菜单项', async () => {
  const dir = tmp()
  try {
    await scanned(dir)
    const f = fake({ row: chatRow(), tsv: TSV_NO_ADD })
    await assert.rejects(
      collectSticker({ run: f.run, dir, look: f.look, ocr: f.ocr, wait: async () => {}, log: () => {} }),
      /Add Sticker/,
    )
    assert.equal(f.clicks.length, 1)
    assert.equal(f.clicks[0][2], 3)
    assert.ok(f.calls.some((c) => c[0] === 'clean'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('当前会话没有表情消息：一次都不点', async () => {
  const dir = tmp()
  try {
    await scanned(dir)
    const f = fake({ lookMessages: [{ text: '普通一句话', kind: 'text', box: stickerBox }] })
    await assert.rejects(
      collectSticker({ run: f.run, dir, look: f.look, ocr: f.ocr, wait: async () => {}, log: () => {} }),
      /没有表情/,
    )
    assert.equal(f.clicks.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('收藏后重扫没认回：明确未确认，不冒充成功', async () => {
  const dir = tmp()
  try {
    await scanned(dir)
    // 气泡图案和面板都不一样
    const f = fake({ row: chatRow({ stickerId: 99 }), panelGray: panel({ base: 40 }) })
    const r = await collectSticker({
      run: f.run, dir, look: f.look, ocr: f.ocr, wait: async () => {}, log: () => {},
    })
    assert.equal(r.confirmed, false)
    assert.match(r.receipt, /没有认回|未确认/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log(`sticker-collect: ${n} 项通过`)
