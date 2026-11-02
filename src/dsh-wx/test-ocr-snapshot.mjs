import assert from 'node:assert/strict'
import { groupChatRows, parseTsv, snapshotFromTsv } from './lib/ocr-snapshot.mjs'

const word = (page, block, paragraph, line, left, top, width, height, confidence, text) =>
  [5, page, block, paragraph, line, 1, left, top, width, height, confidence, text].join('\t')
const tsv = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  word(1, 1, 1, 1, 80, 120, 40, 18, 90, 'Group'),
  word(1, 1, 1, 1, 125, 120, 28, 18, 80, 'A'),
  word(1, 1, 1, 2, 82, 148, 30, 17, 88, '@Me'),
  word(1, 2, 1, 1, 82, 190, 45, 18, 85, 'General'),
  word(1, 2, 2, 1, 82, 218, 18, 18, 82, '2'),
  word(1, 3, 1, 1, 82, 255, 38, 18, 90, 'Direct'),
  word(1, 3, 2, 1, 82, 283, 16, 18, 90, '1'),
  word(1, 4, 1, 1, 420, 80, 80, 18, 95, 'Group A'),
  word(1, 4, 1, 2, 430, 160, 160, 20, 95, 'Hello there'),
].join('\n')

const parsed = parseTsv(tsv)
assert.equal(parsed.length, 8, 'word boxes combine into OCR lines')
assert.equal(parsed[0].text, 'Group A', 'words are sorted by x coordinate')
assert.equal(parseTsv(word(1, 1, 1, 1, 1, 1, 0, 10, 99, 'bad')).length, 0, 'invalid geometry is rejected')

const snap = snapshotFromTsv(tsv, { x: 10, y: 20, width: 800, height: 600 })
assert.equal(snap.rows.length, 3, 'all grouped sidebar rows are retained, including unread / mention indicators')
assert.equal(snap.rows[0].name, 'Group A')
assert.equal(snap.rows[0].mention, true)
assert.equal(snap.rows[0].box.cx, 170)
assert.equal(snap.rows[1].name, 'General')
assert.equal(snap.rows[2].name, 'Direct')
assert.equal(snap.rows[1].unread, 2)
assert.equal(snap.rows[2].unread, 1)
assert.equal('current' in snap, false, 'snapshot does not invent an active chat from OCR')
assert.equal(snap.messages[0].text, 'Hello there')

const adjacent = [
  { text: 'A', left: 20, top: 100, width: 30, height: 14, confidence: 90 },
  { text: '[You were mentioned]', left: 20, top: 120, width: 100, height: 14, confidence: 90 },
  { text: 'preview text', left: 20, top: 126, width: 90, height: 14, confidence: 90 },
  { text: 'B', left: 20, top: 155, width: 30, height: 14, confidence: 90 },
  { text: '1', left: 20, top: 175, width: 10, height: 14, confidence: 90 },
]
assert.deepEqual(groupChatRows(adjacent, 400, 500).map((row) => row.name), ['A', 'B'], 'adjacent chats are not merged and preview is not a name')
assert.equal('current' in snap, false, 'OCR never claims an active chat from right-pane text')

console.log('ocr snapshot: 10 assertions passed')
