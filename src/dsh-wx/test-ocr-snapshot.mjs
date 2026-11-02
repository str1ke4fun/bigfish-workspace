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
assert.equal(parseTsv(`header\n${word(1, 1, 1, 1, 160, 240, 80, 36, 99, 'scaled')}`, { scale: 2 })[0].left, 80,
  'OCR coordinates from a 2x enlarged screenshot map back to window coordinates')

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
  { text: 'A', left: 50, top: 100, width: 30, height: 14, confidence: 90 },
  { text: '[You were mentioned]', left: 50, top: 120, width: 100, height: 14, confidence: 90 },
  { text: 'preview text', left: 50, top: 126, width: 90, height: 14, confidence: 90 },
  { text: 'B', left: 50, top: 155, width: 30, height: 14, confidence: 90 },
  { text: '1', left: 50, top: 175, width: 10, height: 14, confidence: 90 },
]
assert.deepEqual(groupChatRows(adjacent, 400, 500).map((row) => row.name), ['A', 'B'], 'adjacent chats are not merged and preview is not a name')
assert.equal('current' in snap, false, 'OCR never claims an active chat from right-pane text')

const liveLike = [
  { text: '© 内部赤石群', left: 105, top: 222, width: 96, height: 37, confidence: 62 },
  { text: '1359', left: 274, top: 240, width: 26, height: 7, confidence: 69 },
  { text: '[You were mentioned] cat.', left: 125, top: 259, width: 160, height: 12, confidence: 93 },
  { text: '过', left: 334, top: 293, width: 44, height: 46, confidence: 74 },
  { text: 'cat 不到 fag 的 cat', left: 125, top: 293, width: 120, height: 33, confidence: 87 },
  { text: '1357', left: 274, top: 307, width: 26, height: 7, confidence: 75 },
  { text: '你能看到测试吗', left: 125, top: 318, width: 89, height: 28, confidence: 94 },
  { text: 'File Transfer', left: 125, top: 373, width: 88, height: 11, confidence: 96 },
  { text: 'dsh-wx 验收测试', left: 125, top: 386, width: 92, height: 28, confidence: 86 },
  { text: 'print(', left: 387, top: 152, width: 32, height: 12, confidence: 87 },
]
const liveRows = groupChatRows(liveLike, 916, 666)
assert.equal(liveRows.find((row) => row.name.includes('内部赤石群'))?.mention, true, 'live-style explicit @ badge groups with its chat')
assert.equal(liveRows.find((row) => row.name.includes('cat'))?.preview, '你能看到测试吗', 'DM preview stays with the DM, not the right pane')
assert.ok(!liveRows.some((row) => row.name === '过' || row.name === 'print('), 'avatar and message-pane OCR are excluded from chat names')

console.log('ocr snapshot: 13 assertions passed')
