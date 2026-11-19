#!/usr/bin/env node
// ocr-messages.mjs —— 只 OCR 微信右侧消息区，给「当前会话有 @ 时补全侧栏截断」用。
//
// 侧栏预览被微信截成「…」，整屏树又可能慢一拍；这里把消息区裁出来放大后 OCR，
// 输出按视觉行聚合的文字和坐标。纯内置模块，不 import cua-driver。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const run = (file, args) => execFileSync(file, args, {
  encoding: 'utf8',
  maxBuffer: 40 * 1024 * 1024,
  timeout: 60000,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const SCALE = 2
// 右侧消息区：左侧 36.5% 是会话列表，顶部留标题，底部留输入栏。
const CROP = { left: 0.365, top: 0.08, width: 0.62, height: 0.78 }

export function parseMessageTsv(tsv, { scale = 1 } = {}) {
  const lines = new Map()
  for (const raw of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    const c = raw.split('\t')
    if (c.length < 12 || c[0] !== '5' || !c[11]?.trim()) continue
    const confidence = Number(c[10])
    const [l, t, w, h] = c.slice(6, 10).map(Number)
    if (!Number.isFinite(confidence) || ![l, t, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue
    const key = c.slice(1, 5).join(':')
    const line = lines.get(key) ?? { words: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, confidence: [] }
    line.words.push({ text: c[11].trim(), left: l / scale })
    line.left = Math.min(line.left, l / scale)
    line.top = Math.min(line.top, t / scale)
    line.right = Math.max(line.right, (l + w) / scale)
    line.bottom = Math.max(line.bottom, (t + h) / scale)
    line.confidence.push(confidence)
    lines.set(key, line)
  }
  return [...lines.values()].map((line) => ({
    text: line.words.sort((a, b) => a.left - b.left).map((word) => word.text).join(' ')
      .replace(/(?<=[㐀-鿿])\s+(?=[㐀-鿿])/g, ''),
    left: Math.round(line.left),
    top: Math.round(line.top),
    width: Math.round(line.right - line.left),
    height: Math.round(line.bottom - line.top),
    confidence: Math.round(line.confidence.reduce((sum, value) => sum + value, 0) / line.confidence.length),
  })).sort((a, b) => a.top - b.top || a.left - b.left)
}

function findWindow() {
  const ids = run('xdotool', ['search', '--name', 'Weixin']).trim().split(/\s+/).filter(Boolean)
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
  const message = String(error?.message ?? error)
  const stderr = String(error?.stderr ?? '').trim()
  return [message, stderr && !message.includes(stderr) ? stderr : ''].filter(Boolean).join(': ').slice(0, 200)
}

function main() {
  process.env.DISPLAY = process.env.WX_DISPLAY || process.env.DISPLAY || ':99'
  let dir = ''
  try {
    const win = findWindow()
    dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-messages-'))
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
    const lines = parseMessageTsv(tsv, { scale: SCALE })
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
