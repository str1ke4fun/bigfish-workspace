#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const run = (file, args, input) => execFileSync(file, args, {
  input,
  encoding: input ? undefined : 'utf8',
  maxBuffer: 40 * 1024 * 1024,
  stdio: input ? ['pipe', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore'],
})

export function parseTsv(tsv, { minConfidence = 25 } = {}) {
  const lines = new Map()
  for (const raw of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    const c = raw.split('\t')
    if (c.length < 12 || c[0] !== '5' || !c[11]?.trim()) continue
    const confidence = Number(c[10])
    const [left, top, width, height] = c.slice(6, 10).map(Number)
    if (!Number.isFinite(confidence) || confidence < minConfidence ||
        ![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
    const key = c.slice(1, 5).join(':')
    const line = lines.get(key) ?? { words: [], left, top, right: left + width, bottom: top + height, confidence: [] }
    line.words.push({ text: c[11], left })
    line.left = Math.min(line.left, left)
    line.top = Math.min(line.top, top)
    line.right = Math.max(line.right, left + width)
    line.bottom = Math.max(line.bottom, top + height)
    line.confidence.push(confidence)
    lines.set(key, line)
  }
  return [...lines.values()].map((line) => ({
    text: line.words.sort((a, b) => a.left - b.left).map((word) => word.text).join(' ')
      .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, ''),
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top,
    confidence: line.confidence.reduce((sum, value) => sum + value, 0) / line.confidence.length,
  })).sort((a, b) => a.top - b.top || a.left - b.left)
}

const isTime = (text) => /^(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{1,2}:\d{2}$/i.test(text)
const isUnread = (text) => /^\[?\d{1,3}\]?$/.test(text)
const isMention = (text) => /\bYou were (?:mentioned|@ed)\b|@Me\b/i.test(text)
const isNavigation = (text) => /^(?:Weixin|Contacts|Moments|Search|微信|通讯录|朋友圈|搜索)$/i.test(text)

export function groupChatRows(lines, width, height, origin = { x: 0, y: 0 }) {
  const sidebarLines = lines.filter((line) => line.left < width * 0.43 && line.top > height * 0.10 && line.top < height * 0.96)
  if (!sidebarLines.length) return []

  const medianHeight = [...sidebarLines.map((line) => line.height)].sort((a, b) => a - b)[Math.floor(sidebarLines.length / 2)] || 14
  const eligible = sidebarLines.filter((line) => !isNavigation(line.text))
  const gaps = eligible.slice(1).map((line, i) => line.top - (eligible[i].top + eligible[i].height)).filter((gap) => gap > 0)
  const rowGap = Math.max(medianHeight * 2.0, Math.min(medianHeight * 3.3, [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || medianHeight * 2.7))
  const clusters = []
  for (const line of eligible) {
    let cluster = clusters.at(-1)
    if (!cluster || line.top - cluster.at(-1).top > rowGap) {
      cluster = []
      clusters.push(cluster)
    }
    cluster.push(line)
    cluster.bottom = Math.max(cluster.bottom ?? 0, line.top + line.height)
  }

  return clusters.flatMap((rowLines) => {
    rowLines.sort((a, b) => a.top - b.top || a.left - b.left)
    const nameLine = rowLines.find((line) => !isUnread(line.text) && !isMention(line.text) && !isTime(line.text))
    if (!nameLine) return []
    const name = nameLine.text.replace(/^\[|\]$/g, '').trim()
    if (!name || name.length > 80) return []
    const rest = rowLines.filter((line) => line !== nameLine)
    const unreadLine = rest.find((line) => isUnread(line.text))
    const unread = Number(unreadLine?.text.replace(/\D/g, '') || 0)
    const mention = rest.some((line) => isMention(line.text))
    const preview = rest.filter((line) => line !== unreadLine && !isMention(line.text) && !isTime(line.text)).map((line) => line.text).join(' ').trim()
    const confidence = Math.round(rowLines.reduce((sum, line) => sum + line.confidence, 0) / rowLines.length)
    return [{
      name, unread, mention, preview, confidence, lines: rowLines.map((line) => line.text),
      box: {
        x: origin.x + Math.min(...rowLines.map((line) => line.left)), y: origin.y + Math.min(...rowLines.map((line) => line.top)),
        w: Math.round(width * 0.43), h: Math.max(...rowLines.map((line) => line.top + line.height)) - Math.min(...rowLines.map((line) => line.top)),
        cx: origin.x + Math.round(width * 0.20), cy: origin.y + Math.round((Math.min(...rowLines.map((line) => line.top)) + Math.max(...rowLines.map((line) => line.top + line.height))) / 2),
      },
    }]
  })
}

export function snapshotFromTsv(tsv, bounds) {
  const lines = parseTsv(tsv)
  const rows = groupChatRows(lines, bounds.width, bounds.height, { x: bounds.x, y: bounds.y })
  const messages = lines.filter((line) => line.left > bounds.width * 0.43 && line.top > bounds.height * 0.18 && line.top < bounds.height * 0.92)
    .map((line) => ({ text: line.text, confidence: Math.round(line.confidence), box: { x: bounds.x + line.left, y: bounds.y + line.top, w: line.width, h: line.height } }))
  return {
    ok: true,
    reliable: rows.length > 0,
    bounds,
    rows,
    messages,
    lines: lines.map(({ text, left, top, width, height, confidence }) => ({ text, left, top, width, height, confidence: Math.round(confidence) })),
    text: lines.map((line) => line.text),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
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
  const tsv = run('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '11', 'tsv'], png).toString('utf8')
  process.stdout.write(JSON.stringify(snapshotFromTsv(tsv, best)) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, reliable: false, error: String(error?.message ?? error).slice(0, 160), rows: [], messages: [], text: [] }) + '\n')
}
