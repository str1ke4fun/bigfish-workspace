// 关键词搜索发表情：node --test 或 node test-sticker-search.mjs
// 用合成的搜索结果网格和假 run()/look()，不启动微信、不点真实结果。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PANEL } from './lib/sticker-image.js'
import { detectSearchCells, normalizeKeyword, pickSearchCell, searchSticker } from './lib/sticker-search.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }

function draw(g, w, x, y, size, id) {
  const block = size / 4
  let seed = (id * 1234567 + 7) >>> 0
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

// 搜索页：顶部输入框边框，下面 5x2 结果格，底部页签。
function searchPanel({ rows = 2 } = {}) {
  const g = new Uint8Array(PANEL.w * PANEL.h).fill(250)
  // 真面板四周有 1px 边框：不能把边框当成一列结果。
  for (let i = 0; i < PANEL.w; i++) { g[i] = 180; g[(PANEL.h - 1) * PANEL.w + i] = 180 }
  for (let i = 0; i < PANEL.h; i++) { g[i * PANEL.w] = 180; g[i * PANEL.w + PANEL.w - 1] = 180 }
  for (let y = 21; y <= 57; y++) {
    for (let x = 21; x <= 461; x++) {
      if (y === 21 || y === 22 || y === 56 || y === 57) g[y * PANEL.w + x] = 200
    }
  }
  const xs = [21, 112, 204, 296, 387]
  const ys = [94, 185, 277, 369]
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 5; c++) draw(g, PANEL.w, xs[c], ys[r], 74, r * 5 + c)
  }
  for (let y = 444; y < 478; y++) for (let x = 100; x < 200; x++) g[y * PANEL.w + x] = 220
  return g
}

const LOGIN = { messages: [{ text: '一句话', kind: 'text', box: { cx: 876, cy: 200, x: 575, y: 172, w: 602, h: 56 } }] }
const STICKER = { text: 'Animated Stickers', kind: 'sticker', box: { cx: 876, cy: 340, x: 575, y: 261, w: 602, h: 158 } }

function fake({ panel = searchPanel(), sent = true, chatOk = true } = {}) {
  const calls = []
  const clicks = []
  let posted = false
  const run = async (args) => {
    calls.push([...args])
    switch (args[0]) {
      case 'panel-open': return '2097194 363 247 485 485'
      case 'panel-click':
        clicks.push([Number(args[1]), Number(args[2])])
        // 第一格（58,131）代表搜索结果：点下去就是发送。
        if (Number(args[1]) === 58 && Number(args[2]) === 131) posted = true
        return '点了'
      case 'key':
      case 'type': return 'ok'
      case 'panel-shot': return '2097194 485 485'
      case 'panel-gray': return Buffer.from(panel).toString('base64')
      case 'panel-close': return 'closed'
      case 'clean': return '关掉 0 个浮层'
      default: throw new Error('测试里不该执行：' + args.join(' '))
    }
  }
  const look = async () => ({
    parsed: {
      ok: true,
      current: 'cat不到flag的cat',
      window: { ox: 261, oy: 117, w: 916, h: 666 },
      messages: posted && sent ? [...LOGIN.messages, STICKER] : LOGIN.messages,
    },
  })
  return { run, look, calls, clicks, assertChat: async () => chatOk }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-sticker-search-'))

console.log('结果网格')
await t('从搜索页截图切出 5x2 结果格，跳过输入框和页签', () => {
  const g = searchPanel()
  const r = detectSearchCells(g, PANEL.w, PANEL.h)
  assert.equal(r.cells.length, 10)
  assert.deepEqual(
    { row: r.cells[0].row, col: r.cells[0].col, cx: r.cells[0].cx, cy: r.cells[0].cy },
    { row: 0, col: 0, cx: 58, cy: 131 },
  )
  const last = r.cells[9]
  assert.deepEqual({ row: last.row, col: last.col, cx: last.cx, cy: last.cy }, { row: 1, col: 4, cx: 424, cy: 222 })
})

await t('没有结果时返回空列表', () => {
  const g = new Uint8Array(PANEL.w * PANEL.h).fill(250)
  assert.deepEqual(detectSearchCells(g, PANEL.w, PANEL.h).cells, [])
})

await t('pick 按行列顺序取，越界报错', () => {
  const cells = detectSearchCells(searchPanel(), PANEL.w, PANEL.h).cells
  assert.deepEqual(pickSearchCell(cells, 0), cells[0])
  assert.deepEqual(pickSearchCell(cells, 6), cells[6])
  assert.throws(() => pickSearchCell(cells, 10), /第 10 个|结果/)
  assert.throws(() => pickSearchCell(cells, -1), /结果/)
  assert.throws(() => pickSearchCell(cells, 1.5), /结果/)
})

console.log('关键词')
await t('关键词去掉首尾空白，拒绝空、换行和超长', () => {
  assert.equal(normalizeKeyword('  猫  '), '猫')
  assert.equal(normalizeKeyword('white cat'), 'white cat')
  assert.throws(() => normalizeKeyword(''), /关键词/)
  assert.throws(() => normalizeKeyword('   '), /关键词/)
  assert.throws(() => normalizeKeyword('猫\n猫'), /关键词/)
  assert.throws(() => normalizeKeyword('猫'.repeat(25)), /关键词/)
})

console.log('搜索发送编排')
await t('成功：搜索页签 → 输入 → 点第一格 → 确认新增表情', async () => {
  const dir = tmp()
  try {
    const f = fake()
    const r = await searchSticker({
      run: f.run, look: f.look, assertChat: f.assertChat, keyword: '猫', before: LOGIN.messages,
      shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
    })
    assert.equal(r.clicked, true)
    assert.equal(r.confirmed, true)
    assert.equal(r.sent, 'confirmed')
    assert.equal(r.pick, 0)
    assert.equal(r.cells, 10)
    // 页签、输入框、第一格；没有碰其它格子。
    assert.deepEqual(f.clicks, [[36, 463], [242, 38], [58, 131]])
    assert.ok(f.calls.some((c) => c[0] === 'key' && c[1] === 'ctrl+a'))
    assert.ok(f.calls.some((c) => c[0] === 'type' && c[1] === '猫'))
    assert.ok(f.calls.some((c) => c[0] === 'panel-close'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('pick=6 点第二行第二格', async () => {
  const dir = tmp()
  try {
    const f = fake({ sent: false })
    await searchSticker({
      run: f.run, look: f.look, assertChat: f.assertChat, keyword: 'cat', pick: 6,
      before: LOGIN.messages, shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
    })
    assert.deepEqual(f.clicks.at(-1), [149, 222])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('没有搜索结果：不点任何格子，关面板', async () => {
  const dir = tmp()
  try {
    const plain = new Uint8Array(PANEL.w * PANEL.h).fill(250)
    const f = fake({ panel: plain })
    await assert.rejects(
      searchSticker({
        run: f.run, look: f.look, assertChat: f.assertChat, keyword: '不存在',
        before: LOGIN.messages, shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
      }),
      /没有返回结果/,
    )
    assert.deepEqual(f.clicks, [[36, 463], [242, 38]])
    assert.ok(f.calls.some((c) => c[0] === 'panel-close'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('结果出来前会话变了：不点，避免发错人', async () => {
  const dir = tmp()
  try {
    const f = fake({ chatOk: false })
    await assert.rejects(
      searchSticker({
        run: f.run, look: f.look, assertChat: f.assertChat, keyword: '猫',
        before: LOGIN.messages, shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
      }),
      /会话.*变|发错/,
    )
    assert.deepEqual(f.clicks, [[36, 463], [242, 38]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('pick 超出结果数：不点格子', async () => {
  const dir = tmp()
  try {
    const f = fake()
    await assert.rejects(
      searchSticker({
        run: f.run, look: f.look, assertChat: f.assertChat, keyword: '猫', pick: 10,
        before: LOGIN.messages, shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
      }),
      /第 10 个|结果/,
    )
    assert.deepEqual(f.clicks, [[36, 463], [242, 38]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await t('点完没看到新增表情：如实说未确认', async () => {
  const dir = tmp()
  try {
    const f = fake({ sent: false })
    const r = await searchSticker({
      run: f.run, look: f.look, assertChat: f.assertChat, keyword: '猫',
      before: LOGIN.messages, shot: join(dir, 'search-panel.png'), wait: async () => {}, log: () => {},
    })
    assert.equal(r.clicked, true)
    assert.equal(r.confirmed, false)
    assert.match(r.receipt, /没有看到新增表情|未确认/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log(`sticker-search: ${n} 项通过`)
