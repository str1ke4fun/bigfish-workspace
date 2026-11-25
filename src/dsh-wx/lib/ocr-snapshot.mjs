#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { hasNameCharacter, graphemeLength } from './name.js'

const run = (file, args, input) => execFileSync(file, args, {
  input,
  encoding: input ? undefined : 'utf8',
  maxBuffer: 40 * 1024 * 1024,
  stdio: input ? ['pipe', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore'],
})

const ASCII_NAME_CHARACTER = /^[A-Za-z0-9]$/
const ASCII_DIGIT = /^[0-9]$/
const NON_ASCII_CHARACTER = /^[^\x00-\x7f]$/u
/** 不单独算名字字符的 emoji 组合尾巴：VS15/VS16、keycap、ZWJ、tag 字符。 */
const EMOJI_MODIFIER = /^[︎️⃣‍\u{E0020}-\u{E007F}]$/u

/** 按判断函数决定 OCR 词之间的空格去留。 */
function joinWithoutSpaces(text, shouldJoin) {
  let out = ''
  let previous = '' // 最近一个非组合符字符，`🏖️` 要看回 `🏖`
  let gap = false
  for (const character of String(text ?? '')) {
    if (/\s/u.test(character)) { gap = out !== ''; continue }
    if (gap && !shouldJoin(previous, character)) out += ' '
    out += character
    if (!EMOJI_MODIFIER.test(character)) previous = character
    gap = false
  }
  return out
}

/**
 * 标题词拼接：拉丁词之间的空格是真实词距，保留；只要有一侧是汉字或
 * emoji 等非 ASCII 名字字符，就当成同一个名字连起来。OCR 常把 `🌊` 和
 * `周末海边` 分成两个词，全名里并没有空格。
 * 时间戳在进入这里前已按 isClockWord 剔除，不会和标题粘连。
 */
const joinNameWords = (text) => joinWithoutSpaces(text,
  (previous, character) => hasNameCharacter(previous) && hasNameCharacter(character) &&
    !(ASCII_NAME_CHARACTER.test(previous) && ASCII_NAME_CHARACTER.test(character)))

/**
 * 整行 OCR 文本拼接：和标题词一样，两侧只要不都是 ASCII 名字字符就去空格
 * （汉字、emoji、拉丁词之间都能连）；唯一的例外是「非 ASCII 名字字符 +
 * ASCII 数字」——那通常是时间戳（`内部赤石群 13:59`、`🏖️周末海边 13:59`），
 * 必须留空格给 cleanRowLabel 剥掉时间。拉丁字符之间的空格照旧保留。
 */
const joinLineWords = (text) => joinWithoutSpaces(text,
  (previous, character) => hasNameCharacter(previous) && hasNameCharacter(character) &&
    !(ASCII_NAME_CHARACTER.test(previous) && ASCII_NAME_CHARACTER.test(character)) &&
    !(NON_ASCII_CHARACTER.test(previous) && ASCII_DIGIT.test(character)))

export function parseTsv(tsv, { minConfidence = 25, scale = 1 } = {}) {
  const lines = new Map()
  for (const raw of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    const c = raw.split('\t')
    if (c.length < 12 || c[0] !== '5' || !c[11]?.trim()) continue
    const confidence = Number(c[10])
    const [rawLeft, rawTop, rawWidth, rawHeight] = c.slice(6, 10).map(Number)
    const left = rawLeft / scale
    const top = rawTop / scale
    const width = rawWidth / scale
    const height = rawHeight / scale
    if (!Number.isFinite(confidence) || confidence < minConfidence ||
        ![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
    const key = c.slice(1, 5).join(':')
    const line = lines.get(key) ?? { words: [], left, top, right: left + width, bottom: top + height, confidence: [] }
    line.words.push({ text: c[11], left, width: width, confidence })
    line.left = Math.min(line.left, left)
    line.top = Math.min(line.top, top)
    line.right = Math.max(line.right, left + width)
    line.bottom = Math.max(line.bottom, top + height)
    line.confidence.push(confidence)
    lines.set(key, line)
  }
  return [...lines.values()].map((line) => ({
    words: line.words.sort((a, b) => a.left - b.left),
    text: joinLineWords(line.words.sort((a, b) => a.left - b.left).map((word) => word.text).join(' ')),
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top,
    confidence: line.confidence.reduce((sum, value) => sum + value, 0) / line.confidence.length,
  })).sort((a, b) => a.top - b.top || a.left - b.left)
}

const isTime = (text) => /^(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(?:\d{1,2}:\d{2}|(?:[01]\d|2[0-3])[0-5]\d)$/i.test(text)
const isUnread = (text) => /^\[?\d{1,3}\]?$/.test(text)
const isMention = (text) => /\bYou were (?:mentioned|@ed)\b|@Me\b|有人@我/i.test(text)
const cleanRowLabel = (text) => String(text ?? '').trim()
  .replace(/^[|>•\s]+/, '')
  .replace(/[=|\s]+(?:(?:Yesterday|Today)\s+)?(?:\d{1,2}[:.]\d{2}|(?:[01]\d|2[0-3])[0-5]\d)\s*$/i, '')
  .trim()
const isNavigation = (text) => /^(?:Weixin|Contacts|Moments|Search|微信|通讯录|朋友圈|搜索)$/i.test(text)
const isPreview = (text) => /^[^:：]{1,24}[:：]\s*\S/.test(text) || /[，。！？…]/.test(text) || (String(text).match(/[\u3400-\u9fff]/g) || []).length >= 7 || /\[[^\]]+\]/.test(text)

export function groupChatRows(lines, width, height, origin = { x: 0, y: 0 }) {
  const sidebarLines = lines.filter((line) => line.left < width * 0.37 && line.top > height * 0.10 && line.top < height * 0.96)
  if (!sidebarLines.length) return []

  const anchors = sidebarLines.filter((line) => line.left >= width * 0.08 && line.left < width * 0.33 && line.confidence >= 50 &&
    !isNavigation(cleanRowLabel(line.text)) && !isUnread(line.text) && !isMention(line.text) && !isTime(line.text) && !isPreview(cleanRowLabel(line.text)))
    .sort((a, b) => a.top - b.top || a.left - b.left)
  const medianHeight = [...anchors.map((line) => line.height)].sort((a, b) => a - b)[Math.floor(anchors.length / 2)] || 14
  const rowGap = Math.max(medianHeight * 1.95, 28)
  const clusters = []
  for (const line of anchors) {
    let cluster = clusters.at(-1)
    if (!cluster || line.top - cluster[0].top > rowGap) {
      cluster = []
      clusters.push(cluster)
    }
    cluster.push(line)
  }

  return clusters.flatMap((cluster, index) => {
    const nameLine = cluster[0]
    const name = cleanRowLabel(nameLine.text).replace(/^\[|\]$/g, '').trim()
    if (!name || name.length > 80) return []
    const rowTop = nameLine.top - medianHeight * 0.4
    const nextTop = clusters[index + 1]?.[0].top ?? height * 0.96
    const rowBottom = Math.min(nextTop - medianHeight * 0.2, nameLine.top + rowGap * 1.6)
    const rowLines = sidebarLines.filter((line) => line.top + line.height > rowTop && line.top < rowBottom &&
      line.left >= width * 0.08 && line.left < width * 0.33)
    if (!rowLines.length) return []
      .sort((a, b) => a.top - b.top || a.left - b.left)
    const rest = rowLines.filter((line) => line !== nameLine)
    const unreadLine = rest.find((line) => isUnread(line.text))
    const unread = Number(unreadLine?.text.replace(/\D/g, '') || 0)
    const mention = rest.some((line) => isMention(line.text))
    const preview = rest.filter((line) => line !== unreadLine && !isMention(line.text) && !isTime(line.text)).map((line) => line.text).join(' ').trim()
    const confidence = Math.round(rowLines.reduce((sum, line) => sum + line.confidence, 0) / rowLines.length)
    return [{
      name, unread, mention, preview, confidence, nameConfidence: Math.round(nameLine.confidence), lines: rowLines.map((line) => line.text),
      box: {
        x: origin.x + Math.min(...rowLines.map((line) => line.left)), y: origin.y + Math.min(...rowLines.map((line) => line.top)),
        w: Math.round(width * 0.37), h: Math.max(...rowLines.map((line) => line.top + line.height)) - Math.min(...rowLines.map((line) => line.top)),
        cx: origin.x + Math.round(width * 0.20), cy: origin.y + Math.round((Math.min(...rowLines.map((line) => line.top)) + Math.max(...rowLines.map((line) => line.top + line.height))) / 2),
      },
    }]
  })
}

const isClockWord = (text) => {
  const t = String(text ?? '').trim()
  // 时间：10:00 / 9.05 / Yesterday 11:20 / 星期 10:00
  if (/^(?:(?:昨天|今天|星期[一二三四五六日天]|周[一二三四五六日天]|Yesterday|Today|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*)?(?:\d{1,2}:\d{2}|(?:[01]\d|2[0-3])[0-5]\d)$/i.test(t)) return true
  // 只有日期/星期：11/05、2026/11/05、Monday、昨天、星期几
  return /^(?:Yesterday|Today|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|昨天|今天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(t)
}
const isNameWord = (text) => hasNameCharacter(text) && !isNavigation(text)
/** 纯 emoji/旗帜/符号词：有名字字符，但没有字母或数字。 */
const isEmojiOnlyWord = (text) => hasNameCharacter(text) && !/[\p{L}\p{N}]/u.test(String(text ?? ''))
const stripMention = (text) => String(text ?? '')
  .replace(/\[?\s*(?:You were (?:mentioned|@ed)|@Me|有人@我)\s*\]?/ig, ' ')
  .trim()

/**
 * Segment sidebar rows from a tightly cropped, 2x PSM 6 OCR pass. WeChat
 * renders each conversation title on the same baseline as its timestamp;
 * using that timestamp as the row anchor avoids mistaking avatars, previews,
 * and the right message pane for conversation names.
 */
export function groupTimestampAnchoredRows(lines, width, height, origin = { x: 0, y: 0 }) {
  const candidates = lines.flatMap((line) => {
    const words = Array.isArray(line.words) ? line.words : []
    const time = words.filter((word) => isClockWord(word.text) && word.left >= width * 0.72)
      .sort((a, b) => b.left - a.left)[0]
    if (line.top < height * 0.10 || line.top > height * 0.96) return []
    const titleWords = words.filter((word) => word.left >= width * 0.33 && word.left < width * 0.68 &&
      !isClockWord(word.text) && isNameWord(word.text))
    if (!titleWords.length) return []
    const rawName = joinNameWords(titleWords.map((word) => word.text).join(' '))
    // 微信会把侧栏里的长名字截断成「星晓家园10号楼13...」。去掉**末尾**省略号后
    // 仍按名字处理；中间还有省略号才说明读坏了，丢掉。全名对账在 index.js 的
    // reconcileChatName 里做（只认唯一前缀，找不到就不改名）。
    const name = rawName.replace(/\s*(?:\.{2,}|…)\s*$/u, '').trim()
    if (!name) return []
    // OCR 对 emoji 的置信度天然偏低；只含 emoji 的标题词不进均值，
    // 除非整行标题都是 emoji（那就只能用它们的均值）。
    const textWords = titleWords.filter((word) => !isEmojiOnlyWord(word.text))
    const confidentWords = textWords.length ? textWords : titleWords
    const nameConfidence = confidentWords.reduce((sum, word) => sum + (Number(word.confidence) || 0), 0) / confidentWords.length
    // 行带用垂直中心：标题行的 top 会被头像/高字形拉偏，中心和相邻行的间距才稳。
    const center = line.top + line.height / 2
    return [{ line, center, name, nameConfidence, hasTime: Boolean(time) }]
  }).sort((a, b) => a.center - b.center)

  const deduped = []
  for (const candidate of candidates) {
    const previous = deduped.at(-1)
    if (previous && Math.abs(candidate.center - previous.center) < 18) {
      const score = (c) => (Number(c.nameConfidence) || 0) + (c.hasTime ? 15 : 0)
      if (score(candidate) > score(previous)) deduped[deduped.length - 1] = candidate
    } else deduped.push(candidate)
  }
  if (!deduped.length) return []

  // 预览行紧贴标题（约一个文本行高），真会话行至少隔开一行多。
  // 带时间的锚点先给出行距；一个都没读到就用行高估。
  const heights = deduped.map((c) => c.line.height).filter((h) => h > 0).sort((a, b) => a - b)
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 20
  const timed = deduped.filter((c) => c.hasTime)
  const pitches = []
  for (let i = 1; i < timed.length; i += 1) {
    const gap = timed[i].center - timed[i - 1].center
    if (gap > 4) pitches.push(gap)
  }
  pitches.sort((a, b) => a - b)
  const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0
  const rowGap = Math.min(pitch > 0 ? pitch * 0.7 : Infinity, medianHeight * 1.6)
  const continuationGap = medianHeight * 0.9

  // 行边界独立于名字是否合格：被过滤掉的行也要占住自己的行带，否则它的
  // 标题/徽标会漏进下一行。紧贴上一个候选的是预览/徽标，不是新行。
  const boundaries = []
  let previousCandidate = null
  for (const candidate of deduped) {
    const prev = boundaries.at(-1)
    const continuation = previousCandidate &&
      candidate.center - previousCandidate.center < continuationGap
    if (!continuation && (!prev || candidate.hasTime || candidate.center - prev.center >= rowGap)) {
      boundaries.push(candidate)
    }
    previousCandidate = candidate
  }
  if (!boundaries.length) return []

  /** 名字像不像会话标题；不像的行只占行带，不输出。 */
  const nameLooksLikeChat = (name) => Boolean(name) && graphemeLength(name) <= 80 &&
    hasNameCharacter(name) &&
    !isNavigation(name) && !isClockWord(name) && !isTime(name) &&
    !/\[|\]|(?:\.{2,}|…)|:/.test(name) &&
    !/^(?:You|were|mentioned|@Me)$/i.test(name) &&
    !/^[\d\s.…_-]{4,}$/.test(name)

  return boundaries.map((anchor, index) => {
    const previous = boundaries[index - 1]?.center
    const next = boundaries[index + 1]?.center
    // 行带按相邻边界中心的中点切：一行只属于一个会话，不再用固定 +48px 的窗口。
    const bandTop = previous === undefined ? anchor.center - 6 : (previous + anchor.center) / 2
    const bandBottom = next === undefined ? height * 0.96 : (anchor.center + next) / 2
    const rowLines = lines.filter((line) => {
      const center = line.top + line.height / 2
      return center >= bandTop && center < bandBottom && line.left < width * 0.62
    })
    if (!rowLines.length) rowLines.push(anchor.line)
    // 所有边界的标题行都不算预览：否则上一行的名字会串进下一行。
    const rest = rowLines.filter((line) => !boundaries.some((b) => b.line === line))
    const mention = rest.some((line) => isMention(line.text))
    const preview = rest.filter((line) => !isTime(line.text) && !isUnread(line.text))
      .map((line) => stripMention(line.text))
      .filter(Boolean).join(' ').trim()
    // 没读到时间的行只有自己带 @ 徽标才输出；名字不像标题的一律只占带不输出。
    if (!nameLooksLikeChat(anchor.name) || (!anchor.hasTime && !mention)) return null
    const nameConfidence = Math.round(anchor.nameConfidence)
    const left = Math.min(...rowLines.map((line) => line.left))
    const top = Math.min(...rowLines.map((line) => line.top))
    const bottom = Math.max(...rowLines.map((line) => line.top + line.height))
    return {
      name: anchor.name, unread: 0, mention, preview,
      confidence: Math.round(rowLines.reduce((sum, line) => sum + line.confidence, 0) / rowLines.length),
      nameConfidence,
      lines: rowLines.map((line) => line.text),
      box: {
        x: origin.x + left, y: origin.y + top,
        w: Math.round(width), h: bottom - top,
        cx: origin.x + Math.round(width * 0.5), cy: origin.y + Math.round((top + bottom) / 2),
      },
    }
  }).filter(Boolean)
}

export function snapshotFromTsv(tsv, bounds, rowOcr = null) {
  const { ocrScale = 1, ...windowBounds } = bounds
  const lines = parseTsv(tsv, { scale: ocrScale })
  const rowLines = rowOcr?.tsv
    ? parseTsv(rowOcr.tsv, { scale: rowOcr.scale ?? ocrScale }).map((line) => ({ ...line, left: line.left + (rowOcr.offsetX ?? 0) }))
    : lines
  const rows = rowOcr?.timestampRows
    ? groupTimestampAnchoredRows(rowLines, rowOcr.width ?? windowBounds.width, rowOcr.height ?? windowBounds.height, { x: windowBounds.x + (rowOcr.offsetX ?? 0), y: windowBounds.y })
    : groupChatRows(rowLines, windowBounds.width, windowBounds.height, { x: windowBounds.x, y: windowBounds.y })
  const messages = lines.filter((line) => line.left > windowBounds.width * 0.43 && line.top > windowBounds.height * 0.18 && line.top < windowBounds.height * 0.92)
    .map((line) => ({ text: line.text, confidence: Math.round(line.confidence), box: { x: windowBounds.x + line.left, y: windowBounds.y + line.top, w: line.width, h: line.height } }))
  return {
    ok: true,
    reliable: rows.length > 0,
    bounds: windowBounds,
    rows: rows.map((row) => ({ ...row, lines: [...row.lines, ...(row.mention ? ['[You were mentioned]'] : [])] })),
    messages,
    lines: lines.map(({ text, left, top, width, height, confidence }) => ({ text, left, top, width, height, confidence: Math.round(confidence) })),
    text: lines.map((line) => line.text),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  process.env.DISPLAY = process.env.WX_DISPLAY || process.env.DISPLAY || ':99'
  const ids = run('xdotool', ['search', '--name', 'Weixin']).trim().split(/\s+/).filter(Boolean)
  let best = null
  for (const id of ids) {
    try {
      const geometry = Object.fromEntries(run('xdotool', ['getwindowgeometry', '--shell', id]).trim().split('\n').map((line) => line.split('=')))
      const candidate = { id, x: Number(geometry.X), y: Number(geometry.Y), width: Number(geometry.WIDTH), height: Number(geometry.HEIGHT) }
      if (!best || candidate.width * candidate.height > best.width * best.height) best = candidate
    } catch {}
  }
  if (!best) throw new Error('no Weixin window')
  const png = execFileSync('import', ['-window', best.id, 'png:-'], { maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const scale = 2
  const enlarged = run('convert', ['png:-', '-resize', `${scale * 100}%`, 'png:-'], png)
  const tsv = run('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'], enlarged).toString('utf8')
  const cropX = 0
  const cropWidth = Math.round(best.width * 0.37)
  const sidebar = run('convert', ['png:-', '-crop', `${cropWidth}x${best.height}+${cropX}+0`, '+repage', '-resize', `${scale * 100}%`, 'png:-'], png)
  const rowTsv = run('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'], sidebar).toString('utf8')
  process.stdout.write(JSON.stringify(snapshotFromTsv(tsv, { ...best, ocrScale: scale }, {
    tsv: rowTsv, scale, offsetX: cropX, width: cropWidth, height: best.height, timestampRows: true,
  })) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, reliable: false, error: String(error?.message ?? error).slice(0, 160), rows: [], messages: [], text: [] }) + '\n')
}
