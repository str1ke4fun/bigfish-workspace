import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTimestampAnchoredRows, parseTsv, snapshotFromTsv } from '../lib/ocr-snapshot.mjs'
import { parseOcrChats } from '../lib/ocr.js'
import { chatsJson } from '../lib/chats-json.mjs'

const line = (top, words) => ({ top, height: 18, left: 10, width: 200, words, text: words.map(w => w.text).join(' ') })
const word = (text, left) => ({ text, left, width: 60, confidence: 90 })
const scored = (text, left, confidence) => ({ text, left, width: 60, confidence })
const time = (top, left) => ({ text: '12:03', left, width: 40, confidence: 90 })
const rows = (words) => groupTimestampAnchoredRows([line(150, [...words, time(150, 300)])], 400, 400, { x: 0, y: 0 })

test('纯旗帜标题行能出', () => {
  assert.deepEqual(rows([word('🇨🇳', 150)]).map(r => r.name), ['🇨🇳'])
})

test('emoji 和汉字被 OCR 分成两个词时不留空格', () => {
  assert.deepEqual(rows([word('🌊', 150), word('周末海边', 175)]).map(r => r.name), ['🌊周末海边'])
  assert.deepEqual(rows([word('周末海边', 150), word('🏖️', 220)]).map(r => r.name), ['周末海边🏖️'])
  assert.deepEqual(rows([word('🏖️', 150), word('周末海边', 175)]).map(r => r.name), ['🏖️周末海边'])
})

test('拉丁词之间的真实空格要保留', () => {
  assert.deepEqual(rows([word('File', 150), word('Transfer', 200)]).map(r => r.name), ['File Transfer'])
})

const tsvWord = (line, left, text) =>
  [5, 1, 1, 1, line, 1, left, 100, 60, 18, 95, text].join('\t')
const emojiTsv = ['header', tsvWord(1, 100, '🏖️'), tsvWord(1, 150, '周末海边'), tsvWord(1, 600, '13:59')].join('\n')

test('parseTsv 行文本把 astral emoji 和汉字连起来，但不粘住时间', () => {
  assert.equal(parseTsv(emojiTsv)[0].text, '🏖️周末海边 13:59')
})

test('groupChatRows 回退路径保留 emoji 名字并剥掉时间', () => {
  const snap = snapshotFromTsv(emojiTsv, { x: 0, y: 0, width: 916, height: 666 })
  assert.deepEqual(snap.rows.map(r => r.name), ['🏖️周末海边'])
})

test('纯问号噪声仍被拒', () => {
  assert.deepEqual(rows([word('???', 150)]).map(r => r.name), [])
})

test('nameConfidence 不计纯 emoji 词，全 emoji 时用它们自己的均值', () => {
  const mixed = groupTimestampAnchoredRows([
    line(150, [scored('🌊', 150, 40), scored('周末海边', 175, 90), time(150, 300)]),
  ], 400, 400, { x: 0, y: 0 })
  assert.equal(mixed[0].nameConfidence, 90)
  const allEmoji = groupTimestampAnchoredRows([
    line(150, [scored('🌊', 150, 40), scored('🏖️', 175, 80), time(150, 300)]),
  ], 400, 400, { x: 0, y: 0 })
  assert.equal(allEmoji[0].nameConfidence, 60)
})

test('parseOcrChats 接受纯旗帜，拒绝纯问号', () => {
  const flag = parseOcrChats([{ name: '🇨🇳', lines: ['🇨🇳', '[2]', '有人@我'], nameConfidence: 80 }])
  assert.equal(flag.length, 1)
  const noise = parseOcrChats([{ name: '???', lines: ['???', '[2]', '有人@我'], nameConfidence: 80 }])
  assert.equal(noise.length, 0)
})

test('chats-json snapshot 分支接受纯旗帜', () => {
  const out = chatsJson(JSON.stringify({ ok: true, reliable: true, rows: [{ name: '🇨🇳', nameConfidence: 80 }] }))
  assert.deepEqual(out.chats.map(c => c.name), ['🇨🇳'])
})
