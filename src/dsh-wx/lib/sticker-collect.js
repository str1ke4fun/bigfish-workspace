/**
 * sticker-collect.js —— 把聊天里的表情收藏进微信收藏（阶段三）
 *
 * 流程与约束（对应 STICKER-INDEX.md §8.1）：
 *   1. 在当前会话里找一条表情消息行；用像素裁出气泡，算出 artHash（收藏后靠它认回）。
 *   2. 右键气泡中心——不是整行中心：行是满宽的，空白处右键不会出菜单。
 *   3. 等弹出菜单窗口，截图 + OCR，必须真的看到 "Add Sticker"（或中文“添加到表情”）
 *      才按文字框中心点；OCR 没认出来就关菜单、不点。
 *   4. 重扫收藏页，用 artHash 认回新收藏；动画表情换帧过不了严格阈值时，
 *      只在“重扫新出现、且明显比第二名近”时按低置信度认回；否则说未确认，不冒充成功。
 *
 * 这里不发送任何消息；右键菜单里的 Delete 等项一律不碰。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { backgroundGray, cropGray, dHash, hamming, largestRegion } from './sticker-image.js'
import { loadIndex } from './sticker-index.js'
import { scanStickers } from './sticker-scan.js'
import { RECEIPT_MAX, bubbleRegion } from './sticker-send.js'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ADD_STICKER = /(^| )add sticker( |$)/
const ADD_STICKER_CN = /(添加|收藏).*表情/

/** wx.sh menu-shot 的输出：`<windowId> <x> <y> <w> <h>`。 */
export function parseMenuGeometry(out) {
  const [id, x, y, w, h] = String(out ?? '').trim().split(/\s+/).map(Number)
  if (![x, y, w, h].every(Number.isFinite) || !id || w < 40 || h < 40) {
    throw new Error('读不到右键菜单位置，不点。')
  }
  return { id, x, y, w, h }
}

/**
 * 从 tesseract TSV 里找 "Add Sticker" 这一行，返回相对菜单窗口的文字框。
 * 找不到、或框落在菜单外面，都返回 null——识别不可信就不点。
 */
export function findMenuLabel(tsv, geo = null) {
  const lines = new Map()
  for (const line of String(tsv ?? '').split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 12 || cols[0] !== '5') continue
    const key = `${cols[3]}:${cols[4]}`
    const word = {
      left: Number(cols[6]), top: Number(cols[7]), width: Number(cols[8]), height: Number(cols[9]),
      text: String(cols[11] ?? ''),
    }
    if (![word.left, word.top, word.width, word.height].every(Number.isFinite)) continue
    if (!lines.has(key)) lines.set(key, [])
    lines.get(key).push(word)
  }
  for (const words of lines.values()) {
    const label = words.map((w) => w.text).join(' ')
      .toLowerCase()
      .replace(/[^a-z一-鿿 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!ADD_STICKER.test(label) && !ADD_STICKER_CN.test(label)) continue
    const x = Math.min(...words.map((w) => w.left))
    const y = Math.min(...words.map((w) => w.top))
    const x2 = Math.max(...words.map((w) => w.left + w.width))
    const y2 = Math.max(...words.map((w) => w.top + w.height))
    const box = { x, y, w: x2 - x, h: y2 - y, label }
    if (box.w < 8 || box.h < 6) return null
    if (geo) {
      const pad = 2
      if (box.x < -pad || box.y < -pad || box.x + box.w > Number(geo.w) + pad || box.y + box.h > Number(geo.h) + pad) return null
    }
    return box
  }
  return null
}

/** 菜单项文字框中心 → 屏幕绝对坐标。 */
export function menuClickPoint(box, geo) {
  return {
    x: Math.round(Number(geo.x) + Number(box.x) + Number(box.w) / 2),
    y: Math.round(Number(geo.y) + Number(box.y) + Number(box.h) / 2),
  }
}

/** 严格阈值内直接算认回；超出后只在“新出现且明显最近”时按低置信度认回。 */
export const FALLBACK_MAX = 28
export const FALLBACK_MARGIN = 6

/**
 * 收藏后判定：重扫索引里的条目谁最像刚才那张表情。
 *
 * 为什么不能只靠 artHash：动画表情在聊天气泡和收藏面板里可能停在不同的帧
 * （实机：同一只猫，气泡少一行“喔唷”，dHash 距离 19–23，而其他表情都在 29+），
 * 单帧哈希过不了严格阈值。收藏新加的条目一定在重扫里“新出现”，且应当离气泡最近；
 * 两个条件同时成立、并且明显领先第二名时，按低置信度认回，并在回执里写明依据。
 *
 * @param {Array<{id: string, distance: number}>} scored
 * @returns {{confirmed: boolean, confidence: 'high'|'low'|'none', id: string,
 *            distance: number|null, second: string, margin: number|null, reason: string}}
 */
export function pickCollected(scored, {
  prevIds = new Set(), receiptMax = RECEIPT_MAX,
  fallbackMax = FALLBACK_MAX, fallbackMargin = FALLBACK_MARGIN,
} = {}) {
  const list = (scored ?? [])
    .filter((s) => s && Number.isFinite(s.distance))
    .sort((a, b) => a.distance - b.distance)
  const best = list[0] ?? null
  const second = list[1] ?? null
  if (!best) return { confirmed: false, confidence: 'none', id: '', distance: null, second: '', margin: null, reason: 'no-candidates' }

  const margin = second ? second.distance - best.distance : null
  if (best.distance <= receiptMax) {
    return { confirmed: true, confidence: 'high', id: best.id, distance: best.distance, second: second?.id ?? '', margin, reason: 'hash' }
  }
  const isNew = !prevIds.has(best.id)
  const reason = !isNew ? 'not-new(最近的是旧条目)'
    : best.distance > fallbackMax ? 'too-far(新条目距离太远)'
      : margin != null && margin < fallbackMargin ? 'ambiguous(新条目领先不够)'
        : 'new-nearest(新出现且明显最近)'
  const low = reason === 'new-nearest(新出现且明显最近)'
  return { confirmed: low, confidence: low ? 'low' : 'none', id: best.id, distance: best.distance, second: second?.id ?? '', margin, reason }
}

/** 默认 OCR：菜单是英文界面，用 eng + psm 6 足够；输出 TSV 带坐标。 */
export async function ocrTsv(png) {
  const { stdout } = await execFileP(
    'tesseract', [png, 'stdout', '-l', 'eng', '--psm', '6', 'tsv'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
  return stdout
}

/**
 * @param {{run: Function, dir: string, look: Function, which?: number,
 *          ocr?: (png: string) => Promise<string>, wait?: (ms:number)=>Promise<void>,
 *          shot?: string, log?: Function, receiptMax?: number}} opts
 */
export async function collectSticker({
  run, dir, look, which = 1, ocr = ocrTsv, wait = sleep,
  shot = join(dir, 'collect-menu.png'), log = () => {}, receiptMax = RECEIPT_MAX,
} = {}) {
  if (typeof run !== 'function' || typeof look !== 'function') throw new Error('collectSticker: 缺少 run() 或 look()')

  const s = await look()
  if (!s?.parsed?.ok) throw new Error('读不到微信窗口，不采集。')
  const rows = (s.parsed.messages ?? []).filter((m) => m.kind === 'sticker' && m.box)
  if (!rows.length) throw new Error('当前会话没有表情消息，不采集。')
  const want = Math.max(1, Math.min(rows.length, Number(which) || 1))
  const row = rows[rows.length - want]

  const region = bubbleRegion(row, s.parsed.window)
  if (!region) throw new Error('读不到表情气泡位置，不采集。')

  // 先裁气泡算 artHash：收藏后靠它认回，和发送回执用的是同一套裁切。
  const b64 = String(await run([
    'win-gray', String(region.x), String(region.y), String(region.w), String(region.h),
  ])).trim()
  const gray = Buffer.from(b64, 'base64')
  if (gray.length !== region.w * region.h) {
    throw new Error(`气泡灰度图大小 ${gray.length}，应为 ${region.w * region.h}；截图可能损坏。`)
  }
  const art = largestRegion(gray, region.w, region.h, { bg: backgroundGray(gray), tol: 10, pad: 0 })
  if (!art) throw new Error('气泡里没有可裁的前景，不采集。')
  const cut = cropGray(gray, region.w, region.h, art.x, art.y, art.w, art.h)
  const artHash = dHash(cut.gray, cut.w, cut.h)
  const point = {
    x: Math.round(Number(s.parsed.window.ox ?? 0) + region.x + art.x + art.w / 2),
    y: Math.round(Number(s.parsed.window.oy ?? 0) + region.y + art.y + art.h / 2),
  }

  // 关掉可能残留的浮层，避免右键落在旧菜单上。
  await run(['clean'], 30_000).catch(() => '')
  // 记下点击前的条目：收藏后重扫如果出现“新条目”，那才是这次点出来的。
  const prevIds = new Set(loadIndex(dir).index.entries.map((e) => e.id))
  let failure = null
  let result = null
  try {
    await run(['click', String(point.x), String(point.y), '3'])
    await wait(800)
    const geo = parseMenuGeometry(await run(['menu-shot', shot]))
    const box = findMenuLabel(await ocr(shot), geo)
    if (!box) throw new Error('右键菜单里没有看到 Add Sticker，不点。')
    const at = menuClickPoint(box, geo)
    log(`点菜单项「${box.label}」(${at.x},${at.y})`)
    await run(['click', String(at.x), String(at.y), '1'])
    await wait(700)
    // 菜单一般自己收起；没收起就按小浮层关掉，不用 Escape（可能弹登出确认）。
    await run(['clean'], 30_000).catch(() => '')

    // 重扫收藏页，用气泡 artHash 认回新收藏。
    const scan = await scanStickers({ run, dir, log })
    const { index } = loadIndex(dir)
    const scored = index.entries
      .filter((e) => !e.stale && e.artHash)
      .map((e) => ({ id: e.id, distance: hamming(artHash, e.artHash) }))
    const pick = pickCollected(scored, { prevIds, receiptMax })
    result = {
      ok: true,
      confirmed: pick.confirmed,
      confidence: pick.confidence,
      id: pick.id,
      distance: pick.distance,
      margin: pick.margin,
      reason: pick.reason,
      bubbleHash: artHash,
      added: scan.added,
      total: scan.total,
      menuShot: shot,
      receipt: pick.confidence === 'high'
        ? `回执：收藏已增加，索引认回 ${pick.id}，pHash 距离 ${pick.distance}（阈值 ${receiptMax}）。`
        : pick.confidence === 'low'
          ? `回执：收藏已增加，重扫新出现的 ${pick.id} 是离气泡最近的一张（距离 ${pick.distance}，第二近 ${pick.second || '无'}，相差 ${pick.margin ?? '无'}）；`
            + `距离超过严格阈值 ${receiptMax}（动画表情换帧会这样），按低置信度确认。`
          : `回执：点了 Add Sticker，但重扫没有认回这张表情（最近 ${pick.id || '无'}，距离 ${pick.distance ?? '无'}；${pick.reason}）；`
            + '收藏可能已加，用 wx_sticker_list 复查。',
    }
  } catch (err) {
    failure = err
    failure.menuShot = shot
  } finally {
    try { await run(['clean'], 30_000) } catch { /* ignore */ }
  }
  if (failure) throw failure
  return result
}
