/**
 * sticker-image.js —— 收藏表情面板的纯图像逻辑（零依赖）
 *
 * 面板截图 → 灰度 → 切格 → 64 位 dHash。这里不碰文件、不碰 X11、不启动微信，
 * 只吃 Uint8Array/Buffer，方便用合成图做单测。
 *
 * 几何来自 2026-11-03 的实机截图（485x485，5 列，格子 84x84，横向间距 92，纵向 84，
 * 首格 16,14）。面板尺寸一变就拒绝沿用旧网格，宁可这轮不扫描，也不按错位切图。
 * 同一套坐标只用于“读”，发送阶段仍然要重新扫描核对。
 */

export const PANEL = Object.freeze({
  w: 485,
  h: 485,
  cols: 5,
  cell: 84,
  pitchX: 92,
  pitchY: 84,
  firstX: 16,
  firstY: 14,
  tabBar: 44,
})

/** 底部页签：实测中心 x 约为 36 / 88 / 139，y 约 463。 */
export const TAB = Object.freeze({
  search: { x: 36, y: 463 },
  emoji: { x: 88, y: 463 },
  heart: { x: 139, y: 463 },
  bandY: 448,
  bandH: 30,
  selectedMinWidth: 25,
  selectedMaxMean: 246,
})

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** RGB 交错缓冲 → 8 位灰度。 */
export function lumaFromRgb(rgb, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2])
  }
  return out
}

/** 背景灰度取直方图众数：面板大面积留白，比取角点更稳。 */
export function backgroundGray(gray) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let best = 0
  for (let v = 1; v < 256; v++) if (hist[v] > hist[best]) best = v
  return best
}

export function cropGray(gray, w, h, x, y, cw, ch) {
  const x0 = clamp(Math.round(x), 0, w)
  const y0 = clamp(Math.round(y), 0, h)
  const x1 = clamp(Math.round(x + cw), 0, w)
  const y1 = clamp(Math.round(y + ch), 0, h)
  const outW = Math.max(0, x1 - x0)
  const outH = Math.max(0, y1 - y0)
  const out = new Uint8Array(outW * outH)
  for (let yy = 0; yy < outH; yy++) {
    out.set(gray.subarray((y0 + yy) * w + x0, (y0 + yy) * w + x0 + outW), yy * outW)
  }
  return { gray: out, w: outW, h: outH }
}

/** 区域平均缩放（盒式采样）。只做灰度，够 dHash 用。 */
export function resizeGray(gray, w, h, tw, th) {
  const out = new Uint8Array(tw * th)
  if (!w || !h || !tw || !th) return out
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * h) / th)
    const sy1 = Math.max(sy0 + 1, Math.ceil(((ty + 1) * h) / th))
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * w) / tw)
      const sx1 = Math.max(sx0 + 1, Math.ceil(((tx + 1) * w) / tw))
      let sum = 0
      let cnt = 0
      for (let sy = sy0; sy < Math.min(sy1, h); sy++) {
        for (let sx = sx0; sx < Math.min(sx1, w); sx++) { sum += gray[sy * w + sx]; cnt++ }
      }
      out[ty * tw + tx] = cnt ? Math.round(sum / cnt) : 0
    }
  }
  return out
}

/** 64 位 dHash：先缩到 9x8，再比较每行相邻像素。输出 16 位小写十六进制。 */
export function dHash(gray, w, h) {
  const g = resizeGray(gray, w, h, 9, 8)
  let bits = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0'
  }
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

const HASH_RE = /^[0-9a-f]{16}$/

/** 两个 dHash 的汉明距离。输入不合法直接抛错，避免把坏值当成“很像”。 */
export function hamming(a, b) {
  const x = String(a ?? '').toLowerCase()
  const y = String(b ?? '').toLowerCase()
  if (!HASH_RE.test(x) || !HASH_RE.test(y)) throw new TypeError('dHash 必须是 16 位十六进制')
  let n = 0
  for (let i = 0; i < 16; i++) {
    let v = parseInt(x[i], 16) ^ parseInt(y[i], 16)
    while (v) { n += v & 1; v >>= 1 }
  }
  return n
}

/** 一个格子里有多少像素与背景明显不同（0..1）。 */
export function cellContentFraction(gray, w, h, x, y, cw, ch, bg = backgroundGray(gray), tol = 6) {
  const x0 = clamp(Math.round(x), 0, w)
  const y0 = clamp(Math.round(y), 0, h)
  const x1 = clamp(Math.round(x + cw), 0, w)
  const y1 = clamp(Math.round(y + ch), 0, h)
  let on = 0
  let total = 0
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      total++
      if (Math.abs(gray[yy * w + xx] - bg) > tol) on++
    }
  }
  return total ? on / total : 0
}

/**
 * 按已知网格找格子。不是“看图猜图案”，而是“按标定好的格子逐格验货”：
 * 只有内容占比达到阈值的格子才算一张表情，所以第二行只有 2 张、后面空白都不会多出条目。
 *
 * @returns {{cells: Array<{x:number,y:number,w:number,h:number,row:number,col:number,content:number}>,
 *            layout: object, warnings: string[]}}
 */
export function detectCells(gray, w, h, opts = {}) {
  const layout = { ...PANEL, ...opts }
  const warnings = []
  if (w !== PANEL.w || h !== PANEL.h) {
    warnings.push('panel-size')
    return { cells: [], layout, warnings }
  }
  const bg = opts.bg ?? backgroundGray(gray)
  // 实测面板背景有极淡的分隔线/渐变，空白格也会沾到 3% 左右；真格子最低约 48%。
  const minContent = opts.minContent ?? 0.08
  const maxY = h - (opts.tabBar ?? PANEL.tabBar)
  const cells = []
  let emptyRows = 0
  for (let row = 0; row < 8; row++) {
    const y = layout.firstY + row * layout.pitchY
    if (y + layout.cell > maxY) break
    let inRow = 0
    for (let col = 0; col < layout.cols; col++) {
      const x = layout.firstX + col * layout.pitchX
      if (x + layout.cell > w) break
      const content = cellContentFraction(gray, w, h, x, y, layout.cell, layout.cell, bg)
      if (content >= minContent) {
        cells.push({ x, y, w: layout.cell, h: layout.cell, row, col, content: Math.round(content * 1000) / 1000 })
        inRow++
      }
    }
    emptyRows = inRow ? 0 : emptyRows + 1
    if (emptyRows >= 2) break
  }
  if (!cells.length) warnings.push('no-cells')
  return { cells, layout, warnings }
}

/** 底部哪个页签有选中底块：'search' | 'emoji' | 'heart' | null。 */
export function tabUnder(gray, w, h, opts = {}) {
  const o = { ...TAB, ...opts }
  const y0 = o.bandY
  const y1 = Math.min(h, o.bandY + o.bandH)
  if (y0 >= y1) return null
  const means = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = y0; y < y1; y++) sum += gray[y * w + x]
    means[x] = sum / (y1 - y0)
  }
  const runs = []
  let start = -1
  for (let x = 0; x < w; x++) {
    const on = means[x] < o.selectedMaxMean
    if (on && start < 0) start = x
    if (!on && start >= 0) { runs.push([start, x - 1]); start = -1 }
  }
  if (start >= 0) runs.push([start, w - 1])
  // 选中底块比图标宽；取最宽、且中心靠近某个页签中心的那个。
  const wide = runs
    .filter(([a, b]) => b - a + 1 >= o.selectedMinWidth)
    .map(([a, b]) => ({ a, b, center: (a + b) / 2, width: b - a + 1 }))
  for (const tab of ['heart', 'emoji', 'search']) {
    const hit = wide.find((r) => Math.abs(r.center - o[tab].x) <= 18)
    if (hit) return tab
  }
  return null
}
