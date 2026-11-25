import assert from 'node:assert/strict'
import { chatsJson } from './lib/chats-json.mjs'

const rows = [
  { name: '内部赤石群', nameConfidence: 84, unread: 0, mention: true, preview: 'cat...' },
  { name: 'cat不到flag的cat', nameConfidence: 93, unread: 0, mention: false, preview: '你能看到测试吗' },
  { name: 'File Transfer', nameConfidence: 96, unread: 0, mention: false },
  { name: '©', nameConfidence: 99, unread: 0, mention: true },
  { name: '微信', nameConfidence: 90, unread: 0 },
]

const result = chatsJson(JSON.stringify({ ok: true, reliable: true, rows }))
assert.equal(result.ok, true)
// © 是 \p{Emoji}，按共享的 hasNameCharacter 判定保留；纯符号的 `?` 仍会被拒。
assert.deepEqual(result.chats.map((chat) => chat.name), ['内部赤石群', 'cat不到flag的cat', 'File Transfer', '©'])
assert.equal(result.chats[0].mention, true)
assert.equal(result.chats[1].preview, '你能看到测试吗')
assert.equal(result.current, '', 'OCR must not guess the current conversation')
assert.equal(result.source, 'ocr', 'snapshot rows are labelled as OCR candidates')
assert.equal(chatsJson(JSON.stringify({ ok: true, reliable: false, rows })).ok, false)
assert.equal(chatsJson('').source, 'tree', 'non-snapshot input is the accessibility-tree branch')

console.log('chats JSON: 8 assertions passed')
