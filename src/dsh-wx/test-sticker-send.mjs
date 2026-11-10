// 收藏表情发送：node --test 或 node test-sticker-send.mjs
// 用假 run()/look() 喂合成面板和聊天行，不启动微信、不点真实表情格。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PANEL, TAB, contentBounds, largestRegion } from './lib/sticker-image.js'
import { loadIndex } from './lib/sticker-index.js'
import { appendedSticker, bubbleRegion, cellPoint, ensurePanel, pickCell, sendSticker, targetEntry } from './lib/sticker-send.js'
import { scanStickers } from './lib/sticker-scan.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const NOW = Date.UTC(2026, 10, 5, 2, 0, 0)
const WIN = { ox: 261, oy: 117, w: 916, h: 666 }

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

function panel({ cells = 7, heart = true, base = 0 } = {}) {
  const g = new Uint8Array(PANEL.w * PANEL.h).fill(250)
  if (heart) {
    for (let y = 448; y < 478; y++) for (let x = TAB.heart.x - 16; x <= TAB.heart.x + 16; x++) g[y * PANEL.w + x] = 238
  }
  for (let i = 0; i < cells; i++) {
    const x = PANEL.firstX + (i % 5) * PANEL.pitchX
    const y = PANEL.firstY + Math.floor(i / 5) * PANEL.pitchY
    draw(g, PANEL.w, x, y, PANEL.cell, base + i)
  }
  return g
}

// 聊天区一行：左边/右边一个小头像，中间是 132x132 的表情，背景是浅灰。
function chatRow({ sticker = true, stickerId = 0, w = 360, h = 177 } = {}) {
  const g = new Uint8Array(w * h).fill(245)
  draw(g, w, w - 50, 20, 40, 77) // 头像（小，应被忽略）
  if (sticker) draw(g, w, 100, 20, 132, stickerId)
  return g
}

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-sticker-send-'))

function fake({ gray, row, geometry = '2097194 363 247 485 485', after = [], before = [] } = {}) {
  const calls = []
  const clicks = []
  const run = async (args) => {
    calls.push([...args])
    switch (args[0]) {
      case 'panel-open': return geometry
      case 'panel-click': clicks.push([Number(args[1]), Number(args[2])]); return '点了'
      case 'panel-scroll-up':
      case 'panel-park': return 'ok'
      case 'panel-shot': writeFileSync(args[1], 'fake-png'); return '2097194 485 485'
      case 'panel-gray': return Buffer.from(gray).toString('base64')
      case 'panel-thumb': writeFileSync(args[6], 'fake-thumb'); return 'ok'
      case 'panel-close': return 'closed'
      case 'win-gray': {
        const w = Number(args[3]); const h = Number(args[4])
        const out = row ?? new Uint8Array(w * h)
        if (out.length !== w * h) throw new Error('测试行图尺寸不对')
        return Buffer.from(out).toString('base64')
      }
      default: throw new Error('测试里不该执行：' + args.join(' '))
    }
  }
  const look = async () => ({ parsed: { ok: true, current: '测试会话', window: WIN, messages: after } })
  return { run, look, calls, clicks, before }
}

const MSG = { x: WIN.ox, y: WIN.oy, w: 360, h: 177, cx: WIN.ox + 180, cy: WIN.oy + 88 }
const stickerMsg = { text: 'Animated Stickers', box: MSG }

async function scanned(dir, opts = {}) {
  const f = fake({ gray: panel(opts) })
  await scanStickers({ run: f.run, dir, now: NOW })
  return loadIndex(dir).index
}

console.log('纯逻辑')
await t('看门：id 不存在 / 已 stale 都拒绝', async () => {
  const index = { entries: [
    { id: 'st_a', pHash: '0'.repeat(16), artHash: 'a'.repeat(16), stale: false },
    { id: 'st_b', pHash: '1'.repeat(16), artHash: 'b'.repeat(16), stale: true },
  ] }
  assert.throws(() => targetEntry(index, 'nope'), /没有这个表情/)
  assert.throws(() => targetEntry(index, 'st_b'), /没有在最近扫描里出现/)
  assert.equal(targetEntry(index, 'st_a').id, 'st_a')
})

await t('看门：旧 id 作为别名仍能定位到合并后的条目', async () => {
  const index = { entries: [
    { id: 'st_new', pHash: '0'.repeat(16), artHash: 'a'.repeat(16), stale: false, aliases: ['st_old'] },
  ] }
  assert.equal(targetEntry(index, 'st_old').id, 'st_new')
})

await t('布局守卫：尺寸/网格不一致就拒绝', () => {
  const p = { w: 485, h: 485, cols: 5, cell: 84, pitchX: 92, pitchY: 84, firstX: 16, firstY: 14 }
  assert.doesNotThrow(() => ensurePanel(p, { w: 485, h: 485 }))
  assert.throws(() => ensurePanel(p, { w: 480, h: 485 }), /尺寸/)
  assert.throws(() => ensurePanel({ ...p, cols: 4 }, { w: 485, h: 485 }), /网格/)
})

await t('切格：最近的 pHash 超过阈值就拒绝，不猜位置', () => {
  const cells = [
    { x: 16, y: 14, w: 84, h: 84, pHash: '0'.repeat(16) },
    { x: 108, y: 14, w: 84, h: 84, pHash: 'f'.repeat(16) },
  ]
  const hit = pickCell(cells, { id: 'st_a', pHash: '0'.repeat(16) })
  assert.equal(hit.cell.x, 16)
  assert.equal(hit.distance, 0)
  assert.throws(() => pickCell(cells, { id: 'st_c', pHash: 'a'.repeat(16) }, { max: 6 }), /没有找到/)
})

await t('点击点是格子中心，且必须落在内容区', () => {
  assert.deepEqual(cellPoint({ x: 16, y: 14, w: 84, h: 84 }), { x: 58, y: 56 })
})

await t('内容裁切：只按与背景不同的像素找边界', () => {
  const w = 20; const h = 10
  const g = new Uint8Array(w * h).fill(250)
  for (let y = 2; y < 5; y++) for (let x = 5; x < 9; x++) g[y * w + x] = 20
  assert.deepEqual(contentBounds(g, w, h, { bg: 250, tol: 6 }), { x: 5, y: 2, w: 4, h: 3 })
  assert.equal(contentBounds(new Uint8Array(w * h).fill(250), w, h, { bg: 250 }), null)
})

await t('聊天行：忽略小头像，选面积最大的连通块', () => {
  const g = chatRow()
  const r = largestRegion(g, 360, 177, { bg: 245, tol: 10 })
  assert.ok(r)
  assert.ok(Math.abs(r.x - 100) <= 2, `x=${r.x}`)
  assert.ok(Math.abs(r.y - 20) <= 2, `y=${r.y}`)
  assert.ok(Math.abs(r.w - 132) <= 4, `w=${r.w}`)
  assert.ok(Math.abs(r.h - 132) <= 4, `h=${r.h}`)
})

await t('新增判断：末尾新表情、同长度滚动、非表情都不误判', () => {
  const a = [{ text: '一' }]
  assert.equal(appendedSticker(a, [...a, stickerMsg]).ok, true)
  assert.equal(appendedSticker(a, a).ok, false)
  assert.equal(appendedSticker(a, [...a, { text: '二' }]).ok, false)
  // 消息窗满时整体上移一条，末尾仍是同一张表情
  const b = [stickerMsg, stickerMsg]
  assert.equal(appendedSticker([{ text: '一' }, stickerMsg], b).ok, true)
})

await t('气泡区域：屏幕坐标换成窗口相对坐标，并裁到窗口内', () => {
  assert.deepEqual(bubbleRegion({ box: { x: 300, y: 200, w: 120, h: 140 } }, WIN), { x: 39, y: 83, w: 120, h: 140 })
  assert.equal(bubbleRegion({ box: { x: 0, y: 0, w: 0, h: 0 } }, WIN), null)
  const clipped = bubbleRegion({ box: { x: 1200, y: 900, w: 50, h: 50 } }, WIN)
  assert.equal(clipped, null)
})

console.log('发送编排')
await t('成功：只点一次目标格，回执 pHash 一致', async () => {
  const dir = tmp()
  try {
    const index = await scanned(dir)
    const entry = index.entries[0]
    assert.match(entry.artHash, /^[0-9a-f]{16}$/)
    const f = fake({ gray: panel(), row: chatRow({ stickerId: 0 }), after: [{ text: '一' }, stickerMsg] })
    const r = await sendSticker({
      run: f.run, dir, id: entry.id, before: [{ text: '一' }], look: f.look, wait: async () => {},
    })
    assert.equal(r.confirmed, true)
    assert.equal(r.distance, 0)
    assert.match(r.receipt, /pHash/)
    assert.match(r.receipt, /回执/)
    assert.deepEqual(f.clicks, [[TAB.heart.x, TAB.heart.y], [58, 56]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('消息区没有新增表情：不写回执，明确说未确认', async () => {
  const dir = tmp()
  try {
    const entry = (await scanned(dir)).entries[0]
    const f = fake({ gray: panel(), row: chatRow(), after: [{ text: '一' }] })
    const r = await sendSticker({ run: f.run, dir, id: entry.id, before: [{ text: '一' }], look: f.look, wait: async () => {} })
    assert.equal(r.confirmed, false)
    assert.equal(r.sent, 'unconfirmed')
    assert.match(r.receipt, /没有看到新增表情/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('气泡 pHash 对不上：算未确认，不冒充发对了', async () => {
  const dir = tmp()
  try {
    const entry = (await scanned(dir)).entries[0]
    const f = fake({ gray: panel(), row: chatRow({ stickerId: 41 }), after: [{ text: '一' }, stickerMsg] })
    const r = await sendSticker({ run: f.run, dir, id: entry.id, before: [{ text: '一' }], look: f.look, wait: async () => {} })
    assert.equal(r.confirmed, false)
    assert.ok(r.distance > 6, `distance=${r.distance}`)
    assert.match(r.receipt, /pHash/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('面板尺寸不对：一个格子都不点，面板要关', async () => {
  const dir = tmp()
  try {
    const entry = (await scanned(dir)).entries[0]
    const f = fake({ gray: panel(), geometry: '2097194 363 247 480 480' })
    await assert.rejects(
      sendSticker({ run: f.run, dir, id: entry.id, before: [], look: f.look, wait: async () => {} }),
      /尺寸/,
    )
    assert.equal(f.clicks.length, 0)
    assert.ok(f.calls.some((c) => c[0] === 'panel-close'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('页签没确认：只点过心形页签，不点表情格', async () => {
  const dir = tmp()
  try {
    const entry = (await scanned(dir)).entries[0]
    const f = fake({ gray: panel({ heart: false }), after: [{ text: '一' }, stickerMsg] })
    await assert.rejects(
      sendSticker({ run: f.run, dir, id: entry.id, before: [{ text: '一' }], look: f.look, wait: async () => {} }),
      /页签/,
    )
    assert.deepEqual(f.clicks, [[TAB.heart.x, TAB.heart.y]])
    assert.ok(f.calls.some((c) => c[0] === 'panel-close'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('面板上没有这张：重扫后仍找不到就不点', async () => {
  const dir = tmp()
  try {
    const entry = (await scanned(dir)).entries[0]
    const f = fake({ gray: panel({ base: 50 }), row: chatRow(), after: [{ text: '一' }] })
    await assert.rejects(
      sendSticker({ run: f.run, dir, id: entry.id, before: [{ text: '一' }], look: f.look, wait: async () => {} }),
      /没有找到/,
    )
    assert.deepEqual(f.clicks, [[TAB.heart.x, TAB.heart.y]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log(`sticker-send: ${n} 项通过`)
