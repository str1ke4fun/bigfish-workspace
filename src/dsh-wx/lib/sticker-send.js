/**
 * sticker-send.js —— 按索引 id 发送一张收藏表情（阶段二）
 *
 * 顺序是固定的，任何一步对不上就中止，不"先点了再说"：
 *   1. id 必须在索引里、不是 stale、有 artHash；
 *   2. 面板尺寸必须还是 485x485，网格必须与索引一致；
 *   3. 重新打开收藏页签、重新截图切格，用 pHash 找到目标格（不沿用旧坐标）；
 *   4. 点击格子中心，关面板；
 *   5. 看消息区末尾有没有新增表情行，再把气泡裁出来跟 artHash 比对。
 *
 * 所有 X11 动作都走调用方给的 run()；聊天区读取走 look()。这里不直接开进程。
 */
import { join } from 'node:path'

import {
  PANEL, backgroundGray, cropGray, dHash, hamming, largestRegion,
} from './sticker-image.js'
import { MAX_HAMMING, findEntry, loadIndex } from './sticker-index.js'
import { kindOfLabel } from './transcript.js'
import { readPanelCells } from './sticker-scan.js'

const EXPECTED = `${PANEL.w}x${PANEL.h}`
const GRID = ['cols', 'cell', 'pitchX', 'pitchY', 'firstX', 'firstY']
const CONTENT_MARGIN = 4

/** 气泡裁切后的 dHash 与面板 artHash 的允许距离；实机标定后调整。 */
export const RECEIPT_MAX = 10

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parsePanelGeometry(out) {
  const [id, x, y, w, h] = String(out ?? '').trim().split(/\s+/).map(Number)
  if (![x, y, w, h].every(Number.isFinite) || !id) throw new Error('读不到表情面板位置，不发送。')
  return { id, x, y, w, h }
}

/** 面板尺寸和索引网格都必须与当前代码的标定一致，否则不按旧坐标点。 */
export function ensurePanel(indexPanel, geo) {
  if (Number(geo?.w) !== PANEL.w || Number(geo?.h) !== PANEL.h) {
    throw new Error(`表情面板尺寸是 ${geo?.w}x${geo?.h}，不是预期的 ${EXPECTED}；不按旧网格发送。`)
  }
  const panel = indexPanel ?? PANEL
  const bad = GRID.filter((k) => Number(panel?.[k]) !== Number(PANEL[k]))
  if (bad.length) {
    throw new Error(`索引网格（${bad.join('、')}）与当前面板网格不一致；先重新扫描。`)
  }
}

export function targetEntry(index, id) {
  const want = String(id ?? '').trim()
  if (!want) throw new Error('没有指定表情 id。')
  const entry = findEntry(index, want)
  if (!entry) throw new Error(`索引里没有这个表情 id：${want}；先运行 wx_sticker_scan。`)
  if (entry.stale) {
    throw new Error(`「${want}」没有在最近扫描里出现（可能已从收藏删除）；先运行 wx_sticker_scan。`)
  }
  if (!entry.artHash) {
    throw new Error(`「${want}」是旧索引（缺 artHash），无法做发送回验；先运行 wx_sticker_scan。`)
  }
  return entry
}

/** 在本次扫描出的格子里找 pHash 最近的一张；太远或有并列就不猜。 */
export function pickCell(cells, entry, { max = MAX_HAMMING } = {}) {
  const scored = (cells ?? [])
    .map((cell) => ({ cell, distance: hamming(cell.pHash, entry.pHash) }))
    .sort((a, b) => a.distance - b.distance)
  const best = scored[0]
  if (!best || best.distance > max) {
    throw new Error(`面板上没有找到与 ${entry.id} 匹配的格子（最近距离 ${best ? best.distance : '无'} > ${max}）；先重新扫描。`)
  }
  if (scored[1] && scored[1].distance === best.distance) {
    throw new Error(`面板上有多个格子与 ${entry.id} 同样接近（距离 ${best.distance}），不猜是哪一张；先重新扫描。`)
  }
  return { cell: best.cell, distance: best.distance }
}

export function cellPoint(cell) {
  return { x: Number(cell.x) + Number(cell.w) / 2, y: Number(cell.y) + Number(cell.h) / 2 }
}

/** 点击点必须落在内容区，避开底部页签和边缘。 */
export function insideContent(point, geo = PANEL) {
  const m = CONTENT_MARGIN
  const maxY = Number(geo.h) - Number(geo.tabBar ?? PANEL.tabBar)
  return Number(point.x) >= m && Number(point.x) <= Number(geo.w) - m
    && Number(point.y) >= m && Number(point.y) <= maxY - m
}

/** 消息行框（屏幕绝对坐标）→ 窗口截图内的裁切框。 */
export function bubbleRegion(message, window) {
  const box = message?.box
  if (!box || !window) return null
  const x = Math.round(Number(box.x) - Number(window.ox ?? 0))
  const y = Math.round(Number(box.y) - Number(window.oy ?? 0))
  const w = Math.round(Number(box.w))
  const h = Math.round(Number(box.h))
  if (![x, y, w, h].every(Number.isFinite) || w < 16 || h < 16) return null
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(Number(window.w), x + w)
  const y1 = Math.min(Number(window.h), y + h)
  if (x1 - x0 < 16 || y1 - y0 < 16) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const fingerprint = (m) => ({ kind: kindOfLabel(m?.text), text: String(m?.text ?? '').trim() })

/**
 * 消息区末尾是不是多了一条表情。
 * - 消息条数变多：看末尾是不是表情；
 * - 条数没变（消息窗已满，整体上移一条）：要求前 n-1 条正好是原来的第 2..n 条。
 * 这样连续发同一张表情也能认出来。
 */
export function appendedSticker(before, after) {
  const a = (before ?? []).map(fingerprint)
  const b = (after ?? []).map(fingerprint)
  if (!b.length) return { ok: false, why: '读不到消息区' }
  const last = b[b.length - 1]
  if (last.kind !== 'sticker') return { ok: false, why: '没有看到新增表情' }
  if (b.length > a.length) return { ok: true, message: after[after.length - 1], how: 'append' }
  const same = (x, y) => x.kind === y.kind && x.text === y.text
  if (a.length === b.length && a.length >= 2 && b.slice(0, -1).every((x, i) => same(x, a[i + 1]))) {
    return { ok: true, message: after[after.length - 1], how: 'scroll' }
  }
  return { ok: false, why: '没有看到新增表情' }
}

async function readReceipt({ run, entry, before, look, wait, receiptMax }) {
  await wait(900)
  let s = await look()
  let found = appendedSticker(before, s?.parsed?.messages ?? [])
  if (!found.ok) {
    // 树可能还没刷新；只多等一次，不自动重发。
    await wait(900)
    s = await look()
    found = appendedSticker(before, s?.parsed?.messages ?? [])
  }
  if (!found.ok) {
    return {
      ok: true, id: entry.id, clicked: true, confirmed: false, sent: 'unconfirmed', distance: null,
      receipt: `回执：消息区${found.why}（可能未发出，或树尚未刷新），用 wx_peek 复查。`,
    }
  }

  const region = bubbleRegion(found.message, s?.parsed?.window)
  if (!region) {
    return {
      ok: true, id: entry.id, clicked: true, confirmed: false, sent: 'unconfirmed', distance: null,
      receipt: '回执：看到了新增表情行，但读不到气泡位置，无法比对 pHash；用 wx_peek 复查。',
    }
  }

  const b64 = String(await run([
    'win-gray', String(region.x), String(region.y), String(region.w), String(region.h),
  ])).trim()
  const gray = Buffer.from(b64, 'base64')
  if (gray.length !== region.w * region.h) {
    throw new Error(`气泡灰度图大小 ${gray.length}，应为 ${region.w * region.h}；截图可能损坏。`)
  }

  // 不要外扩：dHash 对边界很敏感，裁到紧贴前景才能和面板 artHash 对齐。
  const art = largestRegion(gray, region.w, region.h, { bg: backgroundGray(gray), tol: 10, pad: 0 })
  if (!art) {
    return {
      ok: true, id: entry.id, clicked: true, confirmed: false, sent: 'unconfirmed', distance: null,
      receipt: '回执：看到了新增表情行，但气泡里没有可裁的前景，无法比对 pHash；用 wx_peek 复查。',
    }
  }

  const cut = cropGray(gray, region.w, region.h, art.x, art.y, art.w, art.h)
  const hash = dHash(cut.gray, cut.w, cut.h)
  const distance = hamming(hash, entry.artHash)
  const confirmed = distance <= receiptMax
  return {
    ok: true,
    id: entry.id,
    clicked: true,
    confirmed,
    sent: confirmed ? 'confirmed' : 'unconfirmed',
    distance,
    bubbleHash: hash,
    receipt: confirmed
      ? `回执：消息区新增表情，pHash 距离 ${distance}（阈值 ${receiptMax}）。`
      : `回执：消息区新增了表情，但 pHash 距离 ${distance} 超过 ${receiptMax}，不能确认是 ${entry.id}；用 wx_peek 复查。`,
  }
}

/**
 * @param {{run: Function, dir: string, id: string, before?: object[], look: Function,
 *          wait?: (ms:number)=>Promise<void>, log?: Function,
 *          maxDistance?: number, receiptMax?: number}} opts
 */
export async function sendSticker({
  run, dir, id, before = [], look, wait = sleep, log = () => {},
  maxDistance = MAX_HAMMING, receiptMax = RECEIPT_MAX,
} = {}) {
  if (typeof run !== 'function' || typeof look !== 'function') throw new Error('sendSticker: 缺少 run() 或 look()')

  const { index } = loadIndex(dir)
  const entry = targetEntry(index, id)
  const shot = join(dir, 'send-panel.png')
  let opened = false
  let failure = null
  let result = null

  try {
    const geo = parsePanelGeometry(await run(['panel-open']))
    opened = true
    ensurePanel(index.panel, geo)

    const found = await readPanelCells({ run, geo, shot, log })
    const { cell, distance } = pickCell(found.cells, entry, { max: maxDistance })
    const point = cellPoint(cell)
    if (!insideContent(point, geo)) {
      throw new Error(`目标格中心 (${Math.round(point.x)},${Math.round(point.y)}) 不在面板内容区，不点。`)
    }

    await run(['panel-click', String(Math.round(point.x)), String(Math.round(point.y))])
    // 点完通常自己收起；没收起就点输入栏表情按钮关掉，别让浮层挡回执截图。
    try { await run(['panel-close']) } catch { /* 关不上不掩盖已经发生的点击 */ }
    opened = false

    result = await readReceipt({ run, entry, before, look, wait, receiptMax })
    result.cellDistance = distance
    result.panelShot = shot
    result.closed = true
  } catch (err) {
    failure = err
    failure.panelShot = shot
  } finally {
    if (opened) {
      try { await run(['panel-close']) } catch { /* ignore */ }
    }
  }

  if (failure) throw failure
  return result
}
