/**
 * sticker-query.js —— 收藏表情的检索与展示（零依赖）
 *
 * 检索结果只是候选，不是事实：描述可能来自低分辨率面板，置信度必须一起展示。
 * 排序先看命中强度，再看置信度、最近看到的时间；不返回 stale 条目（上次扫描没见到）。
 * 不发送、不点击、不读写索引文件——这里只吃内存里的 index。
 */
import { tokenize } from './retrieval.js'

const CONF_RANK = { high: 3, medium: 2, low: 1 }
const LIMIT_MAX = 10

const norm = (s) => String(s ?? '').toLowerCase()
const squash = (s) => norm(s).replace(/\s+/g, '')

/**
 * 总体置信度：描述来源和描述置信度共同决定。
 * manual/high → high；bubble/preview + medium → medium；panel 或 low/none → low。
 */
export function confidenceOf(entry) {
  const descConf = entry?.descConf ?? 'none'
  const textConf = entry?.textConf ?? 'none'
  const source = entry?.source ?? 'none'
  if (source === 'manual' || descConf === 'high') return 'high'
  if (descConf === 'medium') return 'medium'
  if (textConf === 'high') return 'medium'
  return 'low'
}

const timeOf = (e) => {
  const t = Date.parse(String(e?.lastSeen ?? e?.firstSeen ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 列表：最近看到的在前；stale 条目保留但排在后面。 */
export function listStickers(index, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(50, Number(limit) || 20))
  return (index?.entries ?? [])
    .map((entry) => ({ entry, confidence: confidenceOf(entry) }))
    .sort((a, b) => {
      if (a.entry.stale !== b.entry.stale) return a.entry.stale ? 1 : -1
      return timeOf(b.entry) - timeOf(a.entry)
    })
    .slice(0, n)
}

/**
 * 关键词检索：中文二元组 + 标签/图上文字/描述三档加分。
 * 命中原因逐条保留，展示时不要把“标签说牛”和“图上写收到”合并成一个结论。
 */
export function findStickers(index, query, { limit = 5, includeStale = false } = {}) {
  const raw = String(query ?? '').trim()
  const tokens = tokenize(raw)
  if (!tokens.length) return []
  const whole = squash(raw)
  const max = Math.max(1, Math.min(LIMIT_MAX, Number(limit) || 5))
  const rows = []
  for (const entry of index?.entries ?? []) {
    if (entry.stale && !includeStale) continue
    let score = 0
    const reasons = new Set()
    for (const tok of tokens) {
      for (const tag of entry.tags ?? []) {
        const t = norm(tag)
        if (t.includes(tok) || tok.includes(t)) {
          score += 4
          reasons.add(`标签“${tag}”`)
        }
      }
      if (entry.text && norm(entry.text).includes(tok)) {
        score += 3
        reasons.add(`图上文字“${entry.text}”`)
      }
      if (entry.desc && norm(entry.desc).includes(tok)) {
        score += 2
        reasons.add(`描述含“${tok}”`)
      }
    }
    if (whole.length >= 2) {
      const hay = squash([...(entry.tags ?? []), entry.text, entry.desc].join(' '))
      if (hay.includes(whole)) {
        score += 3
        reasons.add('整句命中')
      }
    }
    if (score <= 0) continue
    const confidence = confidenceOf(entry)
    rows.push({ entry, score, reasons: [...reasons], confidence })
  }
  return rows
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const cr = CONF_RANK[b.confidence] - CONF_RANK[a.confidence]
      if (cr) return cr
      return timeOf(b.entry) - timeOf(a.entry)
    })
    .slice(0, max)
}

const stamp = (iso) => {
  const s = String(iso ?? '')
  return s ? s.slice(0, 16).replace('T', ' ') : '未知'
}

const posText = (e) => `第 ${Number(e?.pos?.row ?? 0) + 1} 行第 ${Number(e?.pos?.col ?? 0) + 1} 列`

function describe(entry) {
  const bits = []
  if (entry.tags?.length) bits.push(`标签：${entry.tags.join('、')}`)
  if (entry.text) bits.push(`图上文字：${entry.text}`)
  if (entry.desc) bits.push(`描述：${entry.desc}`)
  if (!bits.length) bits.push('还没有描述（只有缩略图和 pHash）')
  return bits.join('｜')
}

export function formatList(index, rows, { at } = {}) {
  const entries = index?.entries ?? []
  if (!entries.length) return '收藏表情索引是空的。先运行 wx_sticker_scan 扫描收藏页签。'
  const stale = entries.filter((e) => e.stale).length
  const when = stamp(index?.updatedAt || at)
  const head = `收藏表情索引：${entries.length} 张（最近扫描 ${when}${stale ? `；其中 ${stale} 张本轮没看到` : ''}）`
  const lines = rows.map(({ entry, confidence }, i) => {
    const mark = entry.stale ? '（本轮没看到）' : ''
    return `${i + 1}. ${entry.id}｜${describe(entry)}｜置信度 ${confidence}${entry.source && entry.source !== 'none' ? `（来源 ${entry.source}）` : ''}${mark}｜${posText(entry)}｜上次看到 ${stamp(entry.lastSeen)}`
  })
  if (entries.length > rows.length) lines.push(`……还有 ${entries.length - rows.length} 张，用 wx_sticker_list 的 limit 调整。`)
  return [head, ...lines].join('\n')
}

export function formatFind(index, query, rows) {
  const entries = index?.entries ?? []
  if (!entries.length) return '收藏表情索引是空的。先运行 wx_sticker_scan 扫描收藏页签。'
  const q = String(query ?? '').trim()
  if (!rows.length) return `没有找到匹配“${q}”的收藏表情。索引共 ${entries.length} 张，可以用 wx_sticker_list 看看都有什么。`
  const lines = [`按“${q}”找到 ${rows.length} 张候选：`]
  rows.forEach(({ entry, reasons, confidence }, i) => {
    lines.push(`${i + 1}. ${entry.id}｜${describe(entry)}`)
    lines.push(`   置信度：${confidence}${entry.source && entry.source !== 'none' ? `（来源 ${entry.source}）` : ''}｜命中：${reasons.join('；') || '标签/描述'}｜${posText(entry)}｜上次看到 ${stamp(entry.lastSeen)}`)
  })
  if (rows.some((r) => r.confidence === 'low')) {
    lines.push('低置信度条目只作提示，不确定时先问主机，不要当成确定事实。')
  }
  return lines.join('\n')
}
