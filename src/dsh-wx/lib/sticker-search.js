/**
 * sticker-search.js —— 微信表情搜索页：关键词找图，点结果即发送（阶段五）
 *
 * 搜索结果是匿名网格，没有名字/标签；点任意一格会**立即发送到当前会话**，
 * 没有预览确认，也没有二次确认。所以：
 *   1. 只有白名单会话才允许调用（闸在 index.js）；
 *   2. 结果格是从截图里现切出来的，不按固定坐标猜；
 *   3. 点之前再确认一次当前会话没被耳朵切走；
 *   4. 点完只认消息区末尾新增的表情，读不到就说未确认。
 *
 * 这里不发文字、不碰收藏；收藏要另外走 wx_sticker_collect。
 */
import { PANEL, backgroundGray } from './sticker-image.js'
import { appendedSticker, parsePanelGeometry } from './sticker-send.js'

export const SEARCH = {
  tab: { x: 36, y: 463 },
  input: { x: 242, y: 38 },
  minY: 70,          // 输入框下沿以下才算结果
  mergeGap: 10,      // 结果格内部的白带不要切断
  minCount: 12,      // 一行里至少这么多非背景像素才算结果行
  maxKeyword: 24,
}
export const SEARCH_SHOT = '/tmp/dsh-wx-search-panel.png'

const DIFF = 12
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 连续计数段；间隔小于 mergeGap 的段合并（结果格里的白带不断行）。 */
function runsOf(counts, threshold, mergeGap) {
  const out = []
  let start = -1
  for (let i = 0; i <= counts.length; i++) {
    const on = i < counts.length && counts[i] >= threshold
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      const prev = out[out.length - 1]
      if (prev && start - prev[1] - 1 < mergeGap) prev[1] = i - 1
      else out.push([start, i - 1])
      start = -1
    }
  }
  return out
}

/**
 * 从搜索页截图里切出结果格（面板相对坐标，行优先）。
 * 顶部输入框和底部页签按 y 区间排除；每一行单独找列，避免最后一行缺格时多切。
 * @returns {{cells: Array<{row:number,col:number,x:number,y:number,w:number,h:number,cx:number,cy:number}>, bg: number}}
 */
export function detectSearchCells(gray, w, h, {
  bg = null, minY = SEARCH.minY, mergeGap = SEARCH.mergeGap, minCount = SEARCH.minCount,
} = {}) {
  if (!(gray instanceof Uint8Array) || gray.length !== w * h) {
    throw new Error(`搜索页灰度图大小 ${gray?.length}，应为 ${w * h}；截图可能损坏。`)
  }
  const base = Number.isFinite(bg) ? Number(bg) : backgroundGray(gray)
  const maxY = h - PANEL.tabBar - 4
  // 真面板四周有 1px 边框，循环跳过最外一圈，避免边框被当成一格/一行。
  const x0 = 1
  const x1 = w - 2
  const rowCounts = new Array(h).fill(0)
  for (let y = minY; y <= maxY; y++) {
    let c = 0
    for (let x = x0; x <= x1; x++) if (Math.abs(gray[y * w + x] - base) > DIFF) c++
    rowCounts[y] = c
  }
  const rowBands = runsOf(rowCounts, minCount, mergeGap).filter(([a, b]) => b - a + 1 >= 20)
  const cells = []
  rowBands.forEach(([y0, y1], row) => {
    const colCounts = new Array(w).fill(0)
    for (let x = x0; x <= x1; x++) {
      let c = 0
      for (let y = y0; y <= y1; y++) if (Math.abs(gray[y * w + x] - base) > DIFF) c++
      colCounts[x] = c
    }
    const threshold = Math.max(4, Math.round((y1 - y0 + 1) * 0.08))
    runsOf(colCounts, threshold, mergeGap).filter(([a, b]) => b - a + 1 >= 20).forEach(([a, b], col) => {
      const cw = b - a + 1
      const ch = y1 - y0 + 1
      cells.push({
        row, col, x: a, y: y0, w: cw, h: ch,
        cx: Math.round(a + cw / 2), cy: Math.round(y0 + ch / 2),
      })
    })
  })
  return { cells: cells.slice(0, SEARCH.maxResults), bg: base }
}

/** 按行列顺序取第 pick 个（0 起）。越界不猜。 */
export function pickSearchCell(cells, pick = 0) {
  const list = Array.isArray(cells) ? cells : []
  const i = Number(pick)
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    throw new Error(`搜索结果里没有第 ${pick} 个（共 ${list.length} 个），不点。`)
  }
  return list[i]
}

/** 关键词只能是单行短文本；xdotool type 不接受控制字符。 */
export function normalizeKeyword(raw) {
  const k = String(raw ?? '').trim().replace(/[ \t]+/g, ' ')
  if (!k) throw new Error('搜索关键词不能为空。')
  if (/[\x00-\x1f\x7f]/.test(k)) throw new Error('搜索关键词不能包含换行/控制字符。')
  if ([...k].length > SEARCH.maxKeyword) {
    throw new Error(`搜索关键词太长（最多 ${SEARCH.maxKeyword} 个字）。`)
  }
  return k
}

async function readPanel(run, shot) {
  await run(['panel-shot', shot])
  const b64 = String(await run(['panel-gray', shot])).trim()
  const gray = Buffer.from(b64, 'base64')
  if (gray.length !== PANEL.w * PANEL.h) {
    throw new Error(`面板灰度图大小 ${gray.length}，应为 ${PANEL.w * PANEL.h}；截图可能损坏。`)
  }
  return gray
}

/**
 * @param {{run: Function, look: Function, keyword: string, pick?: number,
 *          before?: object[], assertChat?: () => Promise<boolean>,
 *          shot?: string, wait?: (ms:number)=>Promise<void>, log?: Function}} opts
 */
export async function searchSticker({
  run, look, keyword, pick = 0, before = [], assertChat = null,
  shot = SEARCH_SHOT, wait = sleep, log = () => {},
} = {}) {
  if (typeof run !== 'function' || typeof look !== 'function') throw new Error('searchSticker: 缺少 run() 或 look()')
  const word = normalizeKeyword(keyword)
  let opened = false
  let clicked = false
  let failure = null
  let result = null

  try {
    const geo = parsePanelGeometry(await run(['panel-open']))
    opened = true
    if (Number(geo.w) !== PANEL.w || Number(geo.h) !== PANEL.h) {
      throw new Error(`表情面板尺寸是 ${geo.w}x${geo.h}，不是预期的 ${PANEL.w}x${PANEL.h}；不按旧坐标搜索。`)
    }

    await run(['panel-click', String(SEARCH.tab.x), String(SEARCH.tab.y)])
    await wait(350)
    await run(['panel-click', String(SEARCH.input.x), String(SEARCH.input.y)])
    await wait(150)
    // 清掉上一次的关键词；输入框没聚焦时也只是无害的“全选”。
    await run(['key', 'ctrl+a'])
    await run(['type', word])
    log(`搜索「${word}」`)

    let cells = []
    for (const ms of [1200, 900]) {
      await wait(ms)
      cells = detectSearchCells(await readPanel(run, shot), PANEL.w, PANEL.h).cells
      if (cells.length) break
    }
    if (!cells.length) throw new Error(`搜索「${word}」没有返回结果，不点。`)

    const cell = pickSearchCell(cells, pick)
    if (assertChat) {
      const ok = await assertChat()
      if (!ok) throw new Error('搜索结果出来时当前会话变了，不点（会发错人）。')
    }

    // 搜索格点下去就是发送，没有预览确认。
    await run(['panel-click', String(cell.cx), String(cell.cy)])
    clicked = true
    log(`点了第 ${pick + 1} 个结果 (${cell.cx},${cell.cy})`)
    await wait(900)
    try { await run(['panel-close']) } catch { /* 关不上不掩盖已经发生的发送 */ }
    opened = false

    await wait(300)
    const s = await look()
    const found = appendedSticker(before, s?.parsed?.messages ?? [])
    const receipt = found.ok
      ? `回执：搜索「${word}」的第 ${pick + 1} 个结果已发送到「${s?.parsed?.current || '当前会话'}」，消息区新增了一条表情（内容无法核对）。`
      : `回执：点了搜索「${word}」的第 ${pick + 1} 个结果，但消息区${found.why}；可能未发出或树尚未刷新，用 wx_peek 复查，别重复点。`
    result = {
      ok: true,
      clicked: true,
      confirmed: found.ok,
      sent: found.ok ? 'confirmed' : 'unconfirmed',
      keyword: word,
      pick,
      cells: cells.length,
      cell,
      receipt,
      panelShot: shot,
    }
  } catch (err) {
    failure = err
    failure.clicked = clicked
    failure.panelShot = shot
  } finally {
    if (opened) {
      try { await run(['panel-close']) } catch { /* ignore */ }
    }
  }

  if (failure) throw failure
  return result
}
