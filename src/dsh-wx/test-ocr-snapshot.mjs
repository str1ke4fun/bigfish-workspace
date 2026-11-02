import assert from 'node:assert/strict'
import { groupChatRows, groupTimestampAnchoredRows, parseTsv, snapshotFromTsv } from './lib/ocr-snapshot.mjs'

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

const cropLines = [
  word(1, 1, 1, 1, 60, 471, 110, 28, 95, '内部赤石群'), word(1, 1, 1, 1, 328, 480, 52, 14, 90, '13:59'),
  word(1, 1, 1, 2, 30, 520, 260, 24, 95, '[You were mentioned]'),
  word(1, 1, 1, 3, 30, 607, 220, 32, 95, 'cat 不到 flag 的 cat'), word(1, 1, 1, 3, 328, 614, 52, 14, 90, '13.57'),
  word(1, 1, 1, 4, 30, 653, 170, 22, 95, '你能看到测试吗'),
  word(1, 1, 1, 5, 30, 745, 160, 24, 95, 'File Transfer'), word(1, 1, 1, 5, 328, 750, 52, 14, 90, '13:52'),
  word(1, 1, 1, 6, 30, 789, 260, 22, 95, '验收测试'),
  word(1, 1, 1, 7, 28, 879, 190, 24, 95, 'Tencent News'), word(1, 1, 1, 7, 328, 886, 52, 14, 90, '13:44'),
  word(1, 1, 1, 8, 30, 925, 300, 22, 95, '中央定调，延迟退休过渡期结…'),
].join('\n')
const cropSnapshot = snapshotFromTsv(`header\n${cropLines}`, { x: 261, y: 117, width: 916, height: 666 },
  { tsv: `header\n${cropLines}`, scale: 2, offsetX: 110 })
const groupRow = cropSnapshot.rows.find((row) => row.name === '内部赤石群')
const dmRow = cropSnapshot.rows.find((row) => row.name.replace(/\s/g, '') === 'cat不到flag的cat')
assert.equal(groupRow?.mention, true, 'cropped sidebar OCR attaches the explicit @ badge to the group title')
assert.equal(dmRow?.preview, '你能看到测试吗', 'cropped OCR separates the DM name from its preview')
assert.equal(cropSnapshot.rows.find((row) => row.name === 'File Transfer')?.preview, '验收测试', 'timestamp is removed from a chat title')

const anchoredLines = [
  // Actual Linux WeChat PSM 6 layout: avatar glyphs precede the title; the time is on its right.
  word(1, 1, 1, 1, 163, 482, 25, 27, 81, 'a'),
  word(1, 1, 1, 1, 210, 452, 17, 30, 80, '©'),
  word(1, 1, 1, 1, 257, 471, 18, 28, 88, '内'), word(1, 1, 1, 1, 288, 472, 18, 27, 94, '部'),
  word(1, 1, 1, 1, 316, 472, 64, 27, 74, '赤石'), word(1, 1, 1, 1, 379, 448, 16, 63, 74, '群'),
  word(1, 1, 1, 1, 549, 480, 51, 14, 96, '13:59'),
  word(1, 1, 1, 2, 250, 520, 47, 22, 94, '[You'), word(1, 1, 1, 2, 310, 524, 58, 14, 96, 'were'),
  word(1, 1, 1, 2, 379, 518, 141, 24, 96, 'mentioned]'), word(1, 1, 1, 2, 535, 521, 59, 17, 96, 'cat...'),
  word(1, 1, 1, 3, 249, 612, 45, 20, 92, 'cat'), word(1, 1, 1, 3, 304, 608, 32, 27, 90, '不到'),
  word(1, 1, 1, 3, 354, 604, 52, 38, 95, 'flag'), word(1, 1, 1, 3, 418, 608, 18, 27, 92, '的'),
  word(1, 1, 1, 3, 442, 612, 42, 20, 91, 'cat'), word(1, 1, 1, 3, 548, 614, 52, 14, 92, '13:57'),
  word(1, 1, 1, 4, 254, 653, 30, 21, 93, '你'), word(1, 1, 1, 4, 286, 654, 9, 20, 96, '能'),
  word(1, 1, 1, 4, 309, 654, 23, 20, 97, '看'), word(1, 1, 1, 4, 338, 653, 14, 21, 97, '到'),
  word(1, 1, 1, 4, 354, 653, 66, 21, 97, '测试吗'),
  word(1, 1, 1, 5, 250, 742, 46, 36, 97, 'File'), word(1, 1, 1, 5, 312, 746, 114, 22, 96, 'Transfer'),
  word(1, 1, 1, 5, 549, 750, 50, 14, 96, '13:52'),
].join('\n')
const anchored = groupTimestampAnchoredRows(parseTsv(`header\n${anchoredLines}`, { scale: 2 }), 339, 666)
assert.deepEqual(anchored.map((row) => row.name), ['内部赤石群', 'cat不到flag的cat', 'File Transfer'],
  'timestamp-anchored OCR uses title words after avatar icons and excludes preview fragments')
assert.equal(anchored[0].mention, true, 'the explicit @ badge remains attached to its title row')
assert.equal(anchored[1].preview, '你能看到测试吗', 'DM preview is grouped below its own title')
assert.equal(anchored[0].nameConfidence >= 70, true, 'title confidence comes from title glyphs, not avatar or timestamp')

console.log('ocr snapshot: 16 assertions passed')
