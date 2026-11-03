// 表情包面板的纯图像逻辑：node --test 或 node test-sticker-image.mjs
// 只合成灰图，不启动微信、不读真实截图、不碰 CUA。
import assert from 'node:assert/strict'

import {
  PANEL, backgroundGray, cellContentFraction, cropGray, detectCells, dHash, hamming,
  lumaFromRgb, resizeGray, tabUnder, TAB,
} from './lib/sticker-image.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

function blank(w = PANEL.w, h = PANEL.h, bg = 250) {
  return new Uint8Array(w * h).fill(bg)
}

function fill(g, w, x, y, cw, ch, value) {
  for (let yy = y; yy < y + ch; yy++) {
    for (let xx = x; xx < x + cw; xx++) g[yy * w + xx] = value
  }
}

// 每格画点不一样的东西，好让 dHash 分得开
function pattern(g, w, x, y, size, kind) {
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const v = kind === 0 ? (Math.floor(xx / 12) % 2 ? 230 : 20)
        : kind === 1 ? (Math.floor(yy / 12) % 2 ? 230 : 20)
          : ((Math.floor(xx / 12) + Math.floor(yy / 12)) % 2 ? 230 : 20)
      g[(y + yy) * w + x + xx] = v
    }
  }
}

function panelWith(cells) {
  const g = blank()
  cells.forEach((c, i) => pattern(g, PANEL.w, c.x, c.y, c.size ?? 84, i % 3))
  return g
}

console.log('灰度与背景')
t('RGB 三原色转灰度', () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
  assert.deepEqual([...lumaFromRgb(rgb, 3, 1)], [76, 150, 29])
})
t('背景取出现最多的灰度，不被表情里的颜色带偏', () => {
  const g = blank(100, 100)
  fill(g, 100, 10, 10, 30, 30, 20)
  assert.equal(backgroundGray(g), 250)
})

console.log('网格检测')
t('5 列 + 第二行 2 张：位置和行列都对', () => {
  const cells = [
    { x: PANEL.firstX, y: PANEL.firstY }, { x: PANEL.firstX + PANEL.pitchX, y: PANEL.firstY },
    { x: PANEL.firstX + PANEL.pitchX * 2, y: PANEL.firstY }, { x: PANEL.firstX + PANEL.pitchX * 3, y: PANEL.firstY },
    { x: PANEL.firstX + PANEL.pitchX * 4, y: PANEL.firstY },
    { x: PANEL.firstX, y: PANEL.firstY + PANEL.pitchY }, { x: PANEL.firstX + PANEL.pitchX, y: PANEL.firstY + PANEL.pitchY },
  ]
  const got = detectCells(panelWith(cells), PANEL.w, PANEL.h)
  assert.equal(got.cells.length, 7)
  assert.deepEqual(got.cells.map((c) => [c.row, c.col]), [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 0], [1, 1]])
  assert.equal(got.cells[0].x, PANEL.firstX)
  assert.equal(got.cells[5].y, PANEL.firstY + PANEL.pitchY)
  assert.equal(got.layout.cols, 5)
  assert.equal(got.warnings.length, 0)
})
t('空面板不硬凑格子', () => {
  const got = detectCells(blank(), PANEL.w, PANEL.h)
  assert.deepEqual(got.cells, [])
  assert.ok(got.warnings.includes('no-cells'))
})
t('格子边缘的零星噪点不算一张表情', () => {
  const g = blank()
  fill(g, PANEL.w, PANEL.firstX + 2, PANEL.firstY + 2, 2, 2, 20)
  assert.equal(detectCells(g, PANEL.w, PANEL.h).cells.length, 0)
})
t('尺寸不合已知面板时拒绝沿用旧网格', () => {
  const got = detectCells(blank(400, 400), 400, 400)
  assert.deepEqual(got.cells, [])
  assert.ok(got.warnings.includes('panel-size'))
})

console.log('dHash')
t('同图缩放到不同大小：距离 ≤ 3', () => {
  const a = blank(84, 84, 250)
  pattern(a, 84, 0, 0, 84, 2)
  const b = resizeGray(a, 84, 84, 120, 120)
  assert.ok(hamming(dHash(a, 84, 84), dHash(b, 120, 120)) <= 3)
})
t('不同图案距离 > 6', () => {
  const a = blank(84, 84, 250); pattern(a, 84, 0, 0, 84, 0)
  const b = blank(84, 84, 250); pattern(b, 84, 0, 0, 84, 1)
  assert.ok(hamming(dHash(a, 84, 84), dHash(b, 84, 84)) > 6)
})
t('dHash 固定 16 位十六进制；坏输入拒绝比较', () => {
  const g = blank(84, 84)
  assert.match(dHash(g, 84, 84), /^[0-9a-f]{16}$/)
  assert.throws(() => hamming('xyz', 'abcd'))
})
t('裁剪越界不读穿内存', () => {
  const g = blank(10, 10)
  const c = cropGray(g, 10, 10, 8, 8, 4, 4)
  assert.equal(c.w, 2)
  assert.equal(c.h, 2)
  assert.equal(c.gray.length, 4)
})

console.log('页签')
t('选中页签的底块比未选中的宽', () => {
  const g = blank()
  // 心形页签选中：底部画一块 33px 宽的浅灰底
  fill(g, PANEL.w, TAB.heart.x - 16, 448, 33, 30, 238)
  assert.equal(tabUnder(g, PANEL.w, PANEL.h), 'heart')
  const e = blank()
  fill(e, PANEL.w, TAB.emoji.x - 16, 448, 33, 30, 238)
  assert.equal(tabUnder(e, PANEL.w, PANEL.h), 'emoji')
  assert.equal(tabUnder(blank(), PANEL.w, PANEL.h), null)
})
t('格子里的内容占比能区分真格子与空白', () => {
  const g = blank()
  fill(g, PANEL.w, PANEL.firstX, PANEL.firstY, 84, 84, 20)
  assert.ok(cellContentFraction(g, PANEL.w, PANEL.h, PANEL.firstX, PANEL.firstY, 84, 84) > 0.9)
  assert.equal(cellContentFraction(g, PANEL.w, PANEL.h, PANEL.firstX + 200, PANEL.firstY, 84, 84), 0)
})

console.log(`\n${n} 项通过`)
