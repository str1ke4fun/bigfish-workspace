/**
 * sticker-index.js —— 收藏表情索引（派生缓存，零依赖）
 *
 * 这不是她的记忆：索引坏了、丢了，重扫面板就能重建；不写 events.jsonl，也不进归档。
 * 身份以 pHash 为主（汉明距离 ≤ 6），裁剪图的 sha256 只用来做完全一致的快速命中；
 * 位置 `pos` 只是“最近一次扫描看到它在哪”，发送前必须重新扫描核对，不能当身份。
 *
 * 文件：~/.dsh-wx/stickers/index.json + thumbs/<id>.png
 * 写入用临时文件 + rename，坏文件回退为空索引但不覆盖现场，方便排查。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PANEL, hamming } from './sticker-image.js'

export const INDEX_VERSION = 1
export const MAX_HAMMING = 6
// 动画表情跨扫描会换帧，pHash 可能差 13；内容裁切后的 artHash 实测同一张 5、不同张 ≥12。
export const ART_HAMMING = 6
export const STALE_DAYS = 30

const CONFIDENCE = new Set(['high', 'medium', 'low', 'none'])
const SOURCE = new Set(['panel', 'preview', 'bubble', 'manual', 'none'])
const HASH_RE = /^[0-9a-f]{16}$/

const nowIso = (t) => new Date(t).toISOString()

export function emptyIndex(panel = PANEL) {
  return {
    v: INDEX_VERSION,
    panel: {
      w: panel.w, h: panel.h, cols: panel.cols, cell: panel.cell,
      pitchX: panel.pitchX, pitchY: panel.pitchY, firstX: panel.firstX, firstY: panel.firstY,
    },
    entries: [],
    updatedAt: null,
  }
}

export function indexFile(dir) { return join(dir, 'index.json') }
export function thumbPath(dir, id) { return join(dir, 'thumbs', `${id}.png`) }

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const pHash = String(e.pHash ?? '').toLowerCase()
  const id = String(e.id ?? '')
  if (!id || !HASH_RE.test(pHash)) return null
  const pos = e.pos && typeof e.pos === 'object'
    ? { row: Number(e.pos.row) || 0, col: Number(e.pos.col) || 0, order: Number(e.pos.order) || 0 }
    : { row: 0, col: 0, order: 0 }
  return {
    id,
    pHash,
    // 内容裁切后的 dHash（去掉白底/聊天背景），发送回执用它和气泡比对。
    // 旧索引没有这个字段，保持空串；发送前会要求重扫。
    artHash: HASH_RE.test(String(e.artHash ?? '').toLowerCase()) ? String(e.artHash).toLowerCase() : '',
    sha256: String(e.sha256 ?? ''),
    thumb: String(e.thumb ?? `thumbs/${id}.png`),
    pos,
    text: String(e.text ?? ''),
    textConf: CONFIDENCE.has(e.textConf) ? e.textConf : 'none',
    desc: String(e.desc ?? ''),
    tags: Array.isArray(e.tags) ? e.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    descConf: CONFIDENCE.has(e.descConf) ? e.descConf : 'none',
    source: SOURCE.has(e.source) ? e.source : 'none',
    firstSeen: String(e.firstSeen ?? ''),
    lastSeen: String(e.lastSeen ?? ''),
    stale: e.stale === true,
    staleSince: e.staleSince ? String(e.staleSince) : null,
    updatedAt: e.updatedAt ? String(e.updatedAt) : null,
    // 换帧合并后保留旧 id，历史引用（台账、她记下的 id）仍能找回这一条。
    aliases: Array.isArray(e.aliases)
      ? [...new Set(e.aliases.map((a) => String(a).trim()).filter((a) => a && a !== id))]
      : [],
  }
}

/** 按 id 或别名找条目；旧 id 合并后仍可被工具引用。 */
export function findEntry(index, id) {
  const want = String(id ?? '').trim()
  if (!want) return null
  const entries = index?.entries ?? []
  return entries.find((e) => e?.id === want)
    ?? entries.find((e) => Array.isArray(e.aliases) && e.aliases.includes(want))
    ?? null
}

/**
 * @returns {{index: object, recovered: boolean}} 文件不存在/损坏都返回空索引；
 *   损坏时不删除原文件，下一次成功扫描再原子替换。
 */
export function loadIndex(dir) {
  const file = indexFile(dir)
  if (!existsSync(file)) return { index: emptyIndex(), recovered: false }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.v !== INDEX_VERSION || !Array.isArray(raw.entries)) return { index: emptyIndex(), recovered: true }
    const entries = raw.entries.map(normalizeEntry).filter(Boolean)
    return {
      index: {
        v: INDEX_VERSION,
        panel: { ...PANEL, ...(raw.panel && typeof raw.panel === 'object' ? raw.panel : {}) },
        entries,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
      },
      recovered: entries.length !== raw.entries.length,
    }
  } catch {
    return { index: emptyIndex(), recovered: true }
  }
}

/** 原子写：同目录临时文件 + rename。目录/文件都收紧到 0700/0600。 */
export function saveIndex(dir, index) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* 不是自己的目录就算了，别挡住写 */ }
  const thumbs = join(dir, 'thumbs')
  mkdirSync(thumbs, { recursive: true, mode: 0o700 })
  const file = indexFile(dir)
  const tmp = `${file}.${process.pid}.tmp`
  const body = JSON.stringify(index, null, 2) + '\n'
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
  return { path: file }
}

const cellHashes = (cell) => ({
  pHash: String(cell?.pHash ?? '').toLowerCase(),
  sha: String(cell?.sha ?? cell?.sha256 ?? ''),
})

/** 在候选里找距离最近且唯一的条目；并列就不猜。 */
function nearestUnique(entries, field, hash, max) {
  let best = null
  let bestD = max + 1
  let tie = false
  for (const e of entries) {
    const h = String(e?.[field] ?? '').toLowerCase()
    if (!HASH_RE.test(h)) continue
    const d = hamming(h, hash)
    if (d < bestD) { best = e; bestD = d; tie = false }
    else if (d === bestD && best) tie = true
  }
  return best && !tie && bestD <= max ? best : null
}

/**
 * 先认完全相同的裁剪图，再认汉明距离最近的 pHash；
 * pHash 换帧对不上时，用内容裁切后的 artHash 兜底。
 * claimed 里是这一轮已经认过格子的 id，避免一条索引吃掉两个格子。
 */
export function matchEntry(entries, cell, { claimed = null } = {}) {
  const { pHash, sha } = cellHashes(cell)
  const artHash = String(cell?.artHash ?? '').toLowerCase()
  const pool = claimed ? entries.filter((e) => !claimed.has(e.id)) : entries
  if (sha) {
    const exact = pool.find((e) => e.sha256 && e.sha256 === sha)
    if (exact) return exact
  }
  if (HASH_RE.test(pHash)) {
    const hit = nearestUnique(pool, 'pHash', pHash, MAX_HAMMING)
    if (hit) return hit
  }
  if (HASH_RE.test(artHash)) {
    return nearestUnique(pool, 'artHash', artHash, ART_HAMMING)
  }
  return null
}

function uniqueId(base, used) {
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`
    if (!used.has(id)) return id
  }
  throw new Error('表情索引 id 用完了')
}

function posOf(cell, cols) {
  const pos = {
    row: Number(cell?.pos?.row ?? cell?.row) || 0,
    col: Number(cell?.pos?.col ?? cell?.col) || 0,
  }
  pos.order = Number.isFinite(cell?.pos?.order) ? Number(cell.pos.order) : pos.row * cols + pos.col
  return pos
}

/** 把换帧旧条目的标签/描述并进当前条目；旧 id 留作别名。 */
function absorbEntry(hit, old) {
  hit.tags = [...new Set([...(hit.tags ?? []), ...(old.tags ?? [])])]
  if (!hit.text && old.text) { hit.text = old.text; hit.textConf = old.textConf }
  if (!hit.desc && old.desc) { hit.desc = old.desc; hit.descConf = old.descConf }
  if (hit.source === 'none' && old.source && old.source !== 'none') hit.source = old.source
  if (old.firstSeen && (!hit.firstSeen || old.firstSeen < hit.firstSeen)) hit.firstSeen = old.firstSeen
  hit.aliases = [...new Set([...(hit.aliases ?? []), old.id, ...(old.aliases ?? [])])]
    .filter((a) => a && a !== hit.id)
}

/**
 * 把一次扫描结果并进索引。
 * cells: [{ pHash, sha, pos: {row, col}, thumb?, artHash? }]
 * 空扫描不标 stale（切错页签、读图失败时不能把整个索引作废）。
 */
export function mergeScan(index, cells, { now = Date.now(), panel } = {}) {
  const base = index && index.v === INDEX_VERSION ? index : emptyIndex()
  const p = panel ?? base.panel ?? PANEL
  const cols = Number(p.cols) || PANEL.cols
  if (!Array.isArray(cells) || cells.length === 0) {
    return { index: base, added: 0, matched: 0, merged: 0, stale: base.entries.filter((e) => e.stale).length, skipped: true }
  }
  const at = nowIso(now)
  const entries = base.entries.map((e) => ({
    ...e, tags: [...e.tags], aliases: [...(e.aliases ?? [])],
  }))
  const used = new Set(entries.map((e) => e.id))
  let added = 0
  let matched = 0
  let merged = 0
  const touched = new Set()
  const claimed = new Set()

  for (const cell of cells) {
    const { pHash, sha } = cellHashes(cell)
    if (!HASH_RE.test(pHash)) continue
    const artHash = HASH_RE.test(String(cell?.artHash ?? '').toLowerCase())
      ? String(cell.artHash).toLowerCase()
      : ''
    const hit = matchEntry(entries, cell, { claimed })
    if (!hit) {
      // 同一张表情在一屏里出现两次：不算新条目，也不重复计数。
      if (matchEntry(entries, cell)) continue
      const id = uniqueId(`st_${pHash}`, used)
      used.add(id)
      const e = normalizeEntry({
        id, pHash, artHash, sha256: sha, thumb: String(cell?.thumb ?? '') || `thumbs/${id}.png`,
        pos: posOf(cell, cols), firstSeen: at, lastSeen: at,
      })
      entries.push(e)
      touched.add(id)
      added++
      continue
    }

    hit.pos = posOf(cell, cols)
    hit.pHash = pHash
    if (sha) hit.sha256 = sha
    if (artHash) hit.artHash = artHash
    if (String(cell?.thumb ?? '')) hit.thumb = String(cell.thumb)
    hit.lastSeen = at
    hit.stale = false
    hit.staleSince = null
    touched.add(hit.id)
    claimed.add(hit.id)
    matched++

    // 旧 bug 留下的换帧重复条目：同一张、已 stale、artHash 对得上，就并进来。
    if (artHash) {
      const absorbed = entries.filter((e) => e.id !== hit.id && e.stale && e.artHash
        && !touched.has(e.id) && hamming(e.artHash, artHash) <= ART_HAMMING)
      if (absorbed.length) {
        for (const old of absorbed) {
          absorbEntry(hit, old)
          used.delete(old.id)
          merged++
        }
        const gone = new Set(absorbed.map((e) => e.id))
        for (let i = entries.length - 1; i >= 0; i--) {
          if (gone.has(entries[i].id)) entries.splice(i, 1)
        }
      }
    }
  }

  let stale = 0
  for (const e of entries) {
    if (touched.has(e.id)) continue
    if (!e.stale) { e.stale = true; e.staleSince = at }
    else if (!e.staleSince) e.staleSince = at
    stale++
  }

  return {
    index: { ...base, v: INDEX_VERSION, panel: p, entries, updatedAt: at },
    added,
    matched,
    merged,
    stale,
    skipped: false,
  }
}

/**
 * 人工/代理补标签。只改派生索引里的描述字段，不碰位置、身份和扫描时间。
 * 置信度只收 high/medium/low/none；来源只收 panel/preview/bubble/manual/none。
 */
export function annotate(index, id, patch = {}, { now = Date.now() } = {}) {
  const e = findEntry(index, id)
  if (!e) throw new Error(`没有这个表情 id：${id}`)
  if (patch.descConf != null && !CONFIDENCE.has(patch.descConf)) throw new Error('descConf 只能是 high/medium/low/none')
  if (patch.textConf != null && !CONFIDENCE.has(patch.textConf)) throw new Error('textConf 只能是 high/medium/low/none')
  if (patch.source != null && !SOURCE.has(patch.source)) throw new Error('source 只能是 panel/preview/bubble/manual/none')
  const next = {
    ...e,
    tags: [...e.tags],
    ...(patch.text != null ? { text: String(patch.text) } : {}),
    ...(patch.textConf != null ? { textConf: patch.textConf } : {}),
    ...(patch.desc != null ? { desc: String(patch.desc) } : {}),
    ...(patch.descConf != null ? { descConf: patch.descConf } : {}),
    ...(patch.source != null ? { source: patch.source } : {}),
    ...(patch.tags != null ? {
      tags: (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/))
        .map((t) => String(t).trim()).filter(Boolean),
    } : {}),
    updatedAt: nowIso(now),
  }
  next.tags = [...new Set(next.tags)]
  return {
    index: { ...index, entries: index.entries.map((x) => (x.id === e.id ? next : x)), updatedAt: nowIso(now) },
    entry: next,
  }
}

/** 只清理 stale 超过 30 天的条目；缩略图文件由调用方按返回的 id 清理。 */
export function pruneStale(index, { now = Date.now(), days = STALE_DAYS } = {}) {
  const cutoff = now - days * 86_400_000
  const removedIds = []
  const entries = index.entries.filter((e) => {
    if (!e.stale) return true
    const t = Date.parse(e.staleSince || e.lastSeen || '')
    if (Number.isFinite(t) && t <= cutoff) { removedIds.push(e.id); return false }
    return true
  })
  return { index: { ...index, entries }, removed: removedIds.length, removedIds }
}

/** 缩略图目录里已经没有索引条目的孤儿文件（只报告，不自动删）。 */
export function orphanThumbs(dir, index) {
  try {
    const keep = new Set(index.entries.map((e) => `${e.id}.png`))
    return readdirSync(join(dir, 'thumbs')).filter((f) => f.endsWith('.png') && !keep.has(f))
  } catch {
    return []
  }
}

export { CONFIDENCE, SOURCE }
