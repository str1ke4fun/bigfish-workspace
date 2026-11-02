/**
 * ocr.test.mjs —— 视频画面认字：解析、过滤、去重、排版。
 * 联网取帧不在这里测；有 tesseract 时会用一张合成图跑一遍真识别。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseTsv, plausible, sameLine, mergeFrames, formatOcr, detectTesseract, ocrFrames } from '../lib/ocr.js'

const H = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
const row = (blk, ln, w, conf, text) => `5\t1\t${blk}\t1\t${ln}\t${w}\t0\t0\t10\t10\t${conf}\t${text}`

test('parseTsv：按行归并，中文之间不补空格，拉丁之间补', () => {
  const tsv = [H, row(1, 1, 1, 90, '双持'), row(1, 1, 2, 80, '小帮手'), row(2, 1, 1, 95, 'Apex'), row(2, 1, 2, 95, 'Legends'), '4\t1\t1\t1\t1\t0\t0\t0\t1\t1\t-1\t'].join('\n')
  const r = parseTsv(tsv)
  assert.equal(r.length, 2)
  assert.equal(r[0].text, '双持小帮手')
  assert.equal(Math.round(r[0].conf), 85)
  assert.equal(r[1].text, 'Apex Legends')
})

test('plausible：低置信、太短、符号堆都不要', () => {
  assert.equal(plausible('这是字幕', 80, 60), true)
  assert.equal(plausible('这是字幕', 40, 60), false)
  assert.equal(plausible('的', 90, 60), false)
  assert.equal(plausible('=~’ ,.', 90, 60), false)
  assert.equal(plausible('Apex Legends', 90, 65), true)
  assert.equal(plausible('ab', 99, 65), false)
  assert.equal(plausible('aaaaaaaa', 99, 65), false)
})

test('sameLine：逐帧重复和一两个错字算同一句', () => {
  assert.equal(sameLine('双持小帮手把容错乘二', '双持小帮手把容错乘二'), true)
  assert.equal(sameLine('双持小帮手把容错乘二', '双持小帮手把容错乘一'), true)
  assert.equal(sameLine('第12赛季 更新', '第 12 赛季更新'), true)
  assert.equal(sameLine('双持小帮手把容错乘二', '完全不相干的一句话'), false)
})

test('mergeFrames：字幕优先、整帧里重复的丢、跨帧去重、保留首次时间', () => {
  const m = mergeFrames([
    { t: 30, band: [{ text: '第二句字幕', conf: 80 }], full: [] },
    { t: 10, band: [{ text: '第一句字幕', conf: 80 }], full: [{ text: '第一句字幕', conf: 80 }, { text: '赛季更新预告', conf: 90 }] },
    { t: 20, band: [{ text: '第一句字幕', conf: 80 }], full: [{ text: '赛季更新预告', conf: 90 }] },
  ])
  assert.deepEqual(m.map((x) => [x.t, x.kind, x.text]), [
    [10, '字幕', '第一句字幕'],
    [10, '画面文字', '赛季更新预告'],
    [30, '字幕', '第二句字幕'],
  ])
})

test('formatOcr：mm:ss 排版，行数和字数封顶', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ t: 65 + i, kind: '字幕', text: `第${i}句话要有足够长度才行` }))
  const f = formatOcr(items, { maxLines: 5 })
  assert.equal(f.shown, 5)
  assert.equal(f.total, 100)
  assert.match(f.text.split('\n')[0], /^01:05 字幕：第0句话/)
  const g = formatOcr(items, { maxChars: 100 })
  assert.ok(g.text.length <= 100)
})

const det = detectTesseract()
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
test('真识别：合成一张带中文字幕的图，字幕带能读出来', { skip: !(det.ok && det.lang.includes('chi_sim') && ff.status === 0) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr-'))
  try {
    const png = join(dir, 'f.png')
    const py = spawnSync('python3', ['-c', `
from PIL import Image, ImageDraw, ImageFont
import glob
fs=[f for f in glob.glob('/usr/share/fonts/**/*.*',recursive=True) if 'CJK' in f or 'Droid' in f or 'wqy' in f.lower()]
f=ImageFont.truetype(fs[0],30)
im=Image.new('RGB',(1280,720),(30,50,80)); d=ImageDraw.Draw(im)
d.text((380,620),'双持小帮手把容错乘二',font=f,fill='white')
im.save('${png}')
`], { encoding: 'utf8' })
    if (py.status !== 0) return // 没有 PIL/中文字体就不测
    const r = await ocrFrames([{ file: png, t: 12 }], { det, ffmpeg: 'ffmpeg', concurrency: 1 })
    assert.equal(r.ok, true)
    assert.match(r.text, /^00:12 字幕：/m)
    assert.match(r.text, /双持|小帮手|容错/)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('没有 tesseract 时 ocrFrames 不抛，告诉调用方退回', async () => {
  const r = await ocrFrames([{ file: '/nonexistent.png', t: 0 }], { det: { ok: false, why: '没找到 tesseract' } })
  assert.equal(r.ok, false)
  assert.match(r.why, /tesseract/)
})