import assert from 'node:assert/strict'
import { ocrSnapshot, mentionHits, ocrMentionHits } from './lib/index.js'

const scan = ocrSnapshot({
  ok: true,
  reliable: true,
  bounds: { x: 10, y: 20, width: 400, height: 800 },
  rows: [
    { lines: ['项目群', '[2]', '[You were mentioned]', '张三: @大肥鱼 看下'], confidence: 88, nameConfidence: 90 },
    { lines: ['普通群', '[5]', '王五: 今晚吃饭吗'] },
    { lines: ['识别模糊的会话'] },
  ],
  messages: [{ text: '当前画面里的消息文字', confidence: 84, box: { x: 20, y: 30, w: 180, h: 24 } }],
})

assert.equal(scan.current, '', 'OCR 不能擅自推断当前会话')
assert.equal(scan.currentVerified, false)
assert.equal(scan.messages[0].text, '当前画面里的消息文字', 'OCR 正文必须交给文本模型读取')
assert.equal(scan.messages[0].verified, false, 'OCR 消息不伪装成已验证归属')
assert.deepEqual(scan.chats.map((x) => x.name), ['项目群', '普通群'])
assert.equal(scan.chats[0].mention, true)
assert.equal(scan.chats[0].unread, 2)
assert.equal(scan.chats[0].source, 'ocr')
assert.equal(scan.chats[2], undefined)

const badgeWithoutCount = ocrSnapshot({
  ok: true,
  rows: [{ name: '内部赤石群', lines: ['内部赤石群', '[You were mentioned]', '1359'], unread: 0, mention: true, preview: '', confidence: 80, nameConfidence: 62 }],
})
assert.deepEqual(mentionHits(badgeWithoutCount, ['D33P533K'], [], []).map((x) => x.chat), ['内部赤石群'],
  'explicit @ badge is enough even when OCR misses the numeric unread count')
assert.deepEqual(ocrMentionHits(badgeWithoutCount).map((x) => x.chat), ['内部赤石群'],
  'tree recovery wakes only for a confidently recognized explicit @ badge')

const noisyBadge = ocrSnapshot({
  ok: true,
  rows: [{ name: 'os', lines: ['os', '[You were mentioned]'], unread: 0, mention: true, confidence: 70, nameConfidence: 38 }],
})
assert.equal(mentionHits(noisyBadge, [], [], []).length, 0, 'low-confidence OCR name cannot wake an agent in the wrong chat')
assert.equal(ocrMentionHits(noisyBadge).length, 0, 'low-confidence OCR name cannot wake the recovered ear')
const symbolName = ocrSnapshot({
  ok: true,
  rows: [{ name: '©', lines: ['©', '[You were mentioned]', 'new message'], confidence: 82, nameConfidence: 73 }],
})
assert.equal(ocrMentionHits(symbolName).length, 0, 'symbol-shaped OCR names are rejected even with high confidence')
assert.deepEqual(mentionHits(scan, ['大肥鱼'], [], ['项目群', '普通群']).map((x) => x.chat), ['项目群'])

const triggerOnly = ocrSnapshot({
  ok: true,
  rows: [{ lines: ['项目群', '[2]', '张三: @大肥鱼 看下'] }],
})
assert.equal(mentionHits(triggerOnly, ['大肥鱼'], [], ['项目群']).length, 0,
  'OCR preview mention without explicit badge does not authorize a wakeup')
assert.equal(ocrMentionHits(triggerOnly).length, 0,
  'OCR preview text alone cannot wake the recovered ear')

const directMessage = ocrSnapshot({
  ok: true,
  rows: [{ name: 'cat不到flag的cat', lines: ['cat不到flag的cat', '[2]', '测试新消息'], confidence: 90, nameConfidence: 90 }],
})
assert.equal(ocrMentionHits(directMessage).length, 0,
  'OCR recovery does not bypass the direct-message allow list')

const flat = ocrSnapshot({ ok: true, text: ['项目群', '张三: @大肥鱼'] })
assert.equal(flat.chats.length, 0, 'flat whole-window OCR is not treated as chat rows')

console.log('ocr adapter: 12 assertions passed')
