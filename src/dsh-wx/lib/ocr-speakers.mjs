#!/usr/bin/env node
// OCR 发言人：从聊天区裁出左侧「发言人 + 时间」列，转成屏幕绝对坐标的文字行。
// 只输出几何和文字，不做归因；归因由上层用消息框对齐。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 汉字、数字、字母之间的 OCR 空格压掉；拉丁词之间的空格保留（Tencent News）。
const joinWords = (words) => words.map((word) => word.text).join(' ')
  .replace(/(?<=[㐀-鿿])\s+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])\s+(?=[㐀-鿿])/gu, '')

/**
 * 解析放大后的裁剪 TSV。left/top 除以 scale 回到裁剪内像素，再加上裁剪的
 * 屏幕绝对原点，输出直接可和 AT-SPI 的消息框比较。
 */
export function parseSpeakerTsv(tsv, { scale = 1, origin = { x: 0, y: 0 }, minConfidence = 30 } = {}) {
  const grouped = new Map()
  for (const raw of String(tsv ?? '').split(/\r?\n/)) {
    const columns = raw.split('\t')
    if (columns.length < 12 || columns[0] !== '5' || !columns[11]?.trim()) continue
    const confidence = Number(columns[10])
    const [left, top, width, height] = columns.slice(6, 10).map(Number)
    if (!Number.isFinite(confidence) || confidence < 0 ||
        ![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
    const key = columns.slice(1, 5).join(':')
    const line = grouped.get(key) ?? { words: [] }
    line.words.push({
      text: columns[11].trim(),
      left: left / scale,
      top: top / scale,
      right: (left + width) / scale,
      bottom: (top + height) / scale,
      confidence,
    })
    grouped.set(key, line)
  }

  const lines = [...grouped.values()].flatMap((line) => {
    const words = [...line.words].sort((a, b) => a.left - b.left || a.top - b.top)
    const confidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length
    if (confidence < minConfidence) return []
    const left = Math.min(...words.map((word) => word.left))
    const top = Math.min(...words.map((word) => word.top))
    return [{
      text: joinWords(words),
      x: origin.x + left,
      y: origin.y + top,
      w: Math.max(...words.map((word) => word.right)) - left,
      h: Math.max(...words.map((word) => word.bottom)) - top,
      conf: confidence,
    }]
  }).sort((a, b) => a.y - b.y || a.x - b.x)

  return { lines }
}

const run = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8',
  maxBuffer: 40 * 1024 * 1024,
  timeout: 60000,
  ...options,
})

// 聊天区左侧的发言人列。比例对 916x666 的微信主窗有效，随窗口等比缩放。
const SCALE = 3
const CROP = { left: 0.34, top: 0.07, width: 0.66, height: 0.70 }

function findWindow() {
  let ids = []
  try {
    ids = run('xdotool', ['search', '--name', 'Weixin']).trim().split(/\s+/).filter(Boolean)
  } catch {}
  let best = null
  for (const id of ids) {
    try {
      const geometry = Object.fromEntries(run('xdotool', ['getwindowgeometry', '--shell', id]).trim()
        .split('\n').map((line) => line.split('=')))
      const candidate = { id, x: Number(geometry.X), y: Number(geometry.Y), w: Number(geometry.WIDTH), h: Number(geometry.HEIGHT) }
      if (![candidate.x, candidate.y, candidate.w, candidate.h].every(Number.isFinite) || candidate.w <= 0 || candidate.h <= 0) continue
      if (!best || candidate.w * candidate.h > best.w * best.h) best = candidate
    } catch {}
  }
  if (!best) throw new Error('找不到微信窗口')
  return best
}

const describe = (error) => {
  const stderr = String(error?.stderr ?? '').trim()
  return [String(error?.message ?? error), stderr].filter(Boolean).join(': ').slice(0, 200)
}

function main() {
  process.env.DISPLAY = process.env.WX_DISPLAY || process.env.DISPLAY || ':99'
  let dir = ''
  try {
    const win = findWindow()
    dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-speakers-'))
    const windowPng = join(dir, 'window.png')
    const cropPng = join(dir, 'crop.png')
    const cropX = Math.round(win.w * CROP.left)
    const cropY = Math.round(win.h * CROP.top)
    const cropW = Math.round(win.w * CROP.width)
    const cropH = Math.round(win.h * CROP.height)
    run('import', ['-window', win.id, '-silent', windowPng])
    run('convert', [windowPng, '-crop', `${cropW}x${cropH}+${cropX}+${cropY}`, '+repage',
      '-resize', `${SCALE * 100}%`, cropPng])
    const tsv = run('tesseract', [cropPng, 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'])
    const { lines } = parseSpeakerTsv(tsv, { scale: SCALE, origin: { x: win.x + cropX, y: win.y + cropY } })
    process.stdout.write(JSON.stringify({
      ok: true,
      window: { x: win.x, y: win.y, w: win.w, h: win.h },
      crop: { x: win.x + cropX, y: win.y + cropY, w: cropW, h: cropH },
      scale: SCALE,
      lines,
    }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, why: describe(error) }) + '\n')
    process.exitCode = 1
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
