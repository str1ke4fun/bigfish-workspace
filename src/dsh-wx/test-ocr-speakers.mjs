// 发言人 OCR：node --test test-ocr-speakers.mjs
// 只测纯函数；不启动微信、不跑 tesseract。
import assert from 'node:assert/strict'

import { parseSpeakerTsv } from './lib/ocr-speakers.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

const tsv = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t60\t30\t180\t24\t82.0\t计科',
  '5\t1\t1\t1\t1\t2\t250\t30\t180\t24\t80.0\t4223',
  '5\t1\t1\t1\t1\t3\t440\t30\t240\t24\t78.0\t薛长顺',
  '5\t1\t1\t2\t1\t1\t60\t120\t240\t24\t90.0\t那里润',
].join('\n')
const options = { scale: 3, origin: { x: 100, y: 50 } }

console.log('TSV 聚合')
t('同一 OCR 行按 block/par/line 聚合，汉字和数字之间的空格压掉', () => {
  const r = parseSpeakerTsv(tsv, options)
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0].text, '计科4223薛长顺')
  assert.equal(r.lines[1].text, '那里润')
})
t('裁剪坐标换回屏幕绝对坐标', () => {
  const r = parseSpeakerTsv(tsv, options)
  assert.equal(r.lines[0].x, 120)
  assert.equal(r.lines[0].y, 60)
  assert.equal(r.lines[0].h, 8)
  assert.equal(r.lines[0].w, 620 / 3)
  assert.equal(r.lines[0].conf, 80)
  assert.equal(r.lines[1].x, 120)
  assert.equal(r.lines[1].y, 90)
  assert.equal(r.lines[1].w, 80)
})
t('低于 minConfidence 的行整行丢弃', () => {
  const r = parseSpeakerTsv(tsv, { ...options, minConfidence: 85 })
  assert.equal(r.lines.length, 1)
  assert.equal(r.lines[0].text, '那里润')
})
t('默认 minConfidence 保留普通识别结果', () => {
  assert.equal(parseSpeakerTsv(tsv, options).lines.length, 2)
})
t('空 TSV 和只有表头都返回空行数组', () => {
  assert.deepEqual(parseSpeakerTsv('').lines, [])
  assert.deepEqual(parseSpeakerTsv(undefined).lines, [])
  assert.deepEqual(parseSpeakerTsv(tsv.split('\n')[0]).lines, [])
})

console.log(`\n${n} 项通过`)
