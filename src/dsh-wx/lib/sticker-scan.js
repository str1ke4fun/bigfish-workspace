/**
 * sticker-scan.js —— 收藏表情面板扫描（阶段一：只读）
 *
 * 只做：确保面板打开 → 点心形页签（唯一一次点击）→ 截图 → 按网格切图 →
 * dHash/sha256 → 合并索引 → 写缩略图 → 关面板。
 * 不点击任何表情格，不发送消息；页签没确认、尺寸不对、没有格子都直接中止。
 *
 * 所有 X11 动作都走调用方给的 run()（插件的 wx.sh 通道），这里不自己开进程。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { PANEL, TAB, contentBounds, cropGray, dHash, detectCells, resizeGray, tabUnder } from './sticker-image.js'
import { loadIndex, matchEntry, mergeScan, saveIndex } from './sticker-index.js'

const EXPECTED = `${PANEL.w}x${PANEL.h}`

const parseGeometry = (out) => {
  const [id, x, y, w, h] = String(out ?? '').trim().split(/\s+/).map(Number)
  if (![x, y, w, h].every(Number.isFinite) || !id) throw new Error('读不到微信窗口位置')
  return { id, x, y, w, h }
}

const cellSha = (gray, w, h) => createHash('sha256')
  .update(Buffer.from(resizeGray(gray, w, h, 32, 32)))
  .digest('hex')

/**
 * 打开/确认收藏页签，截图并切出所有格子。
 * 扫描和发送共用：发送阶段也走同一条“重新看一遍面板”的路，不沿用索引里的旧坐标。
 *
 * @returns {{cells: Array<object>, warnings: string[], gray: Uint8Array}}
 */
export async function readPanelCells({ run, geo, shot, log = () => {} }) {
  // 唯一一次点击：底部心形页签。表情格一个都不点。
  await run(['panel-click', String(TAB.heart.x), String(TAB.heart.y)])
  await run(['panel-scroll-up', '10'])
  // 悬停会放大/预览格子，先停到空白区再截图，否则同一张表情的 pHash 会变。
  await run(['panel-park'])

  await run(['panel-shot', shot])
  const b64 = String(await run(['panel-gray', shot])).trim()
  const gray = Buffer.from(b64, 'base64')
  if (gray.length !== geo.w * geo.h) {
    throw new Error(`面板灰度图大小 ${gray.length}，应为 ${geo.w * geo.h}；截图可能损坏。`)
  }

  const tab = tabUnder(gray, geo.w, geo.h)
  if (tab !== 'heart') {
    throw new Error('没有确认到收藏表情页签（心形页签未选中），本轮不扫描。')
  }

  const found = detectCells(gray, geo.w, geo.h)
  if (!found.cells.length) throw new Error('收藏页签里没有看到表情格子，本轮不扫描。')

  log(`面板切出 ${found.cells.length} 格`)
  const cells = found.cells.map((c) => {
    const crop = cropGray(gray, geo.w, geo.h, c.x, c.y, c.w, c.h)
    const bounds = contentBounds(crop.gray, crop.w, crop.h)
    const art = bounds
      ? cropGray(crop.gray, crop.w, crop.h, bounds.x, bounds.y, bounds.w, bounds.h)
      : crop
    return {
      ...c,
      pos: { row: c.row, col: c.col },
      pHash: dHash(crop.gray, crop.w, crop.h),
      artHash: dHash(art.gray, art.w, art.h),
      sha: cellSha(crop.gray, crop.w, crop.h),
    }
  })
  return { cells, warnings: [...found.warnings], gray }
}

/**
 * @param {{run: (args: string[], timeout?: number) => Promise<string>, dir: string,
 *          now?: number, log?: (msg: string) => void}} opts
 */
export async function scanStickers({ run, dir, now = Date.now(), log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'thumbs'), { recursive: true, mode: 0o700 })
  const shot = join(dir, 'panel.png')
  let failure = null
  let closed = false
  let result = null
  let warnings = []
  try {
    const geo = parseGeometry(await run(['panel-open']))
    if (geo.w !== PANEL.w || geo.h !== PANEL.h) {
      throw new Error(`表情面板尺寸是 ${geo.w}x${geo.h}，不是预期的 ${EXPECTED}；不按旧网格切图。`)
    }

    const found = await readPanelCells({ run, geo, shot, log })
    warnings = [...found.warnings]

    // 首屏网格全满时，收藏可能还有下一屏；阶段一只索引首屏，不猜也不翻页。
    let visibleRows = 0
    while (PANEL.firstY + visibleRows * PANEL.pitchY + PANEL.cell <= geo.h - PANEL.tabBar) visibleRows++
    if (found.cells.length >= visibleRows * PANEL.cols) warnings.push('grid-full')

    const scanned = found.cells

    const loaded = loadIndex(dir)
    if (loaded.recovered) warnings.push('index-recovered')
    const merged = mergeScan(loaded.index, scanned, {
      now,
      panel: {
        w: geo.w, h: geo.h, cols: PANEL.cols, cell: PANEL.cell,
        pitchX: PANEL.pitchX, pitchY: PANEL.pitchY, firstX: PANEL.firstX, firstY: PANEL.firstY,
      },
    })

    // 先合并拿到 id，再落缩略图；缩略图失败只记警告，不弄丢身份和位置。
    for (const cell of scanned) {
      const entry = matchEntry(merged.index.entries, cell)
      if (!entry) continue
      const rel = `thumbs/${entry.id}.png`
      try {
        await run(['panel-thumb', shot, String(cell.x), String(cell.y), String(cell.w), String(cell.h), join(dir, rel)])
        entry.thumb = rel
      } catch (err) {
        warnings.push('thumb-failed')
        log(`缩略图写入失败 ${entry.id}: ${String(err?.message ?? err).slice(0, 120)}`)
      }
    }

    saveIndex(dir, merged.index)
    log(`扫描完成：新增 ${merged.added}，认回 ${merged.matched}，未见 ${merged.stale}`)

    result = {
      ok: true,
      at: new Date(now).toISOString(),
      panel: { w: geo.w, h: geo.h },
      cells: scanned.length,
      added: merged.added,
      matched: merged.matched,
      stale: merged.stale,
      total: merged.index.entries.length,
      panelShot: shot,
      warnings,
    }
  } catch (err) {
    failure = err
    failure.panelShot = shot
  } finally {
    try {
      const out = String(await run(['panel-close']))
      closed = !/still-open/.test(out)
    } catch { /* 关不上不影响错误本身 */ }
    if (failure) failure.closed = closed
  }

  if (failure) throw failure
  if (!closed) {
    warnings.push('panel-still-open')
    log('面板没能确认关闭，请人工看一眼')
  }
  return { ...result, warnings, closed }
}
