// 扫描编排：node --test 或 node test-sticker-scan.mjs
// 用假的 run() 喂合成面板，不启动微信、不碰 X11；只验证命令顺序、切页签守卫和索引合并。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PANEL, TAB } from './lib/sticker-image.js'
import { loadIndex } from './lib/sticker-index.js'
import { scanStickers } from './lib/sticker-scan.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0)

function draw(g, w, x, y, size, id) {
  // 4x4 低频色块（伪随机、按 id 固定）：缩到 9x8 后 dHash 两两距离都 > 6。
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

function panel({ cells = 7, heart = true, permute = null } = {}) {
  const g = new Uint8Array(PANEL.w * PANEL.h).fill(250)
  if (heart) {
    for (let y = 448; y < 478; y++) for (let x = TAB.heart.x - 16; x <= TAB.heart.x + 16; x++) g[y * PANEL.w + x] = 238
  }
  for (let i = 0; i < cells; i++) {
    const slot = permute ? permute[i] : i
    const x = PANEL.firstX + (slot % 5) * PANEL.pitchX
    const y = PANEL.firstY + Math.floor(slot / 5) * PANEL.pitchY
    draw(g, PANEL.w, x, y, PANEL.cell, i)
  }
  return g
}

function fake(gray, { geometry = '2097194 363 247 485 485', close = 'closed' } = {}) {
  const calls = []
  const clicks = []
  let closed = false
  const run = async (args) => {
    calls.push([...args])
    switch (args[0]) {
      case 'panel-open': return geometry
      case 'panel-click': clicks.push([Number(args[1]), Number(args[2])]); return '点了'
      case 'panel-scroll-up': return '滚到顶'
      case 'panel-park': return '鼠标停到空白区'
      case 'panel-shot': writeFileSync(args[1], 'fake-png'); return '2097194 485 485'
      case 'panel-gray': return Buffer.from(gray).toString('base64')
      case 'panel-thumb': writeFileSync(args[6], 'fake-thumb'); return 'ok'
      case 'panel-close': closed = true; return close
      default: throw new Error('测试里不该执行：' + args.join(' '))
    }
  }
  return { run, calls, clicks, get closed() { return closed } }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-sticker-scan-'))

await t('扫描 7 张：只点心形页签，不点任何表情格', async () => {
  const dir = tmp()
  try {
    const f = fake(panel())
    const r = await scanStickers({ run: f.run, dir, now: NOW })
    assert.equal(r.added, 7)
    assert.equal(r.cells, 7)
    assert.equal(r.closed, true)
    assert.equal(f.closed, true)
    assert.deepEqual(f.clicks, [[TAB.heart.x, TAB.heart.y]])
    assert.equal(f.calls.filter((c) => c[0] === 'panel-click').length, 1)
    const cellsCalls = f.calls.filter((c) => c[0] === 'panel-thumb')
    assert.equal(cellsCalls.length, 7)
    // 面板截图坐标是相对面板的，不能落在页签区域外
    for (const c of cellsCalls) {
      assert.ok(Number(c[3]) + PANEL.cell <= PANEL.h - PANEL.tabBar)
    }
    const { index } = loadIndex(dir)
    assert.equal(index.entries.length, 7)
    assert.ok(index.entries.every((e) => existsSync(join(dir, e.thumb))))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('首屏格子全满时提示可能还有更多，但不猜、不翻页', async () => {
  const dir = tmp()
  try {
    const f = fake(panel({ cells: 25 }))
    const r = await scanStickers({ run: f.run, dir, now: NOW })
    assert.equal(r.cells, 25)
    assert.ok(r.warnings.includes('grid-full'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('重扫时顺序变了，仍认回同一批，不重复描述', async () => {
  const dir = tmp()
  try {
    const first = fake(panel())
    await scanStickers({ run: first.run, dir, now: NOW })
    const before = loadIndex(dir).index.entries[0].pHash
    // 把第 0 张挪到第 7 格（第 2 行第 2 列），其它依次前移
    const permute = [6, 0, 1, 2, 3, 4, 5]
    const second = fake(panel({ permute }))
    const r = await scanStickers({ run: second.run, dir, now: NOW + 60_000 })
    assert.equal(r.added, 0)
    assert.equal(r.matched, 7)
    const { index } = loadIndex(dir)
    assert.equal(index.entries.length, 7)
    const moved = index.entries.find((e) => e.pHash === before)
    assert.equal(moved.pos.row, 1)
    assert.equal(moved.pos.col, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('没切到心形页签就中止：不读格子、不写索引、仍然关面板', async () => {
  const dir = tmp()
  try {
    const f = fake(panel({ heart: false }))
    await assert.rejects(() => scanStickers({ run: f.run, dir, now: NOW }), /收藏.*页签/)
    assert.equal(f.closed, true)
    assert.equal(f.calls.filter((c) => c[0] === 'panel-thumb').length, 0)
    assert.equal(loadIndex(dir).index.entries.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('面板尺寸不对就拒绝扫描，不按错位网格切图', async () => {
  const dir = tmp()
  try {
    const f = fake(panel(), { geometry: '2097194 363 247 400 400' })
    await assert.rejects(() => scanStickers({ run: f.run, dir, now: NOW }), /485x485/)
    assert.equal(f.calls.some((c) => c[0] === 'panel-shot'), false)
    assert.equal(f.closed, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('少了一张：标 stale，不删除；再出现就恢复', async () => {
  const dir = tmp()
  try {
    await scanStickers({ run: fake(panel()).run, dir, now: NOW })
    const r = await scanStickers({ run: fake(panel({ cells: 6 })).run, dir, now: NOW + 60_000 })
    assert.equal(r.stale, 1)
    const { index } = loadIndex(dir)
    assert.equal(index.entries.filter((e) => e.stale).length, 1)
    const back = await scanStickers({ run: fake(panel({ permute: [1, 2, 3, 4, 5, 6, 0] })).run, dir, now: NOW + 120_000 })
    assert.equal(back.stale, 0)
    assert.equal(loadIndex(dir).index.entries.filter((e) => e.stale).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log(`\n${n} 项通过`)
