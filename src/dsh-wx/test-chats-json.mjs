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
assert.deepEqual(result.chats.map((chat) => chat.name), ['内部赤石群', 'cat不到flag的cat', 'File Transfer'])
assert.equal(result.chats[0].mention, true)
assert.equal(result.chats[1].preview, '你能看到测试吗')
assert.equal(result.current, '', 'OCR must not guess the current conversation')
assert.equal(chatsJson(JSON.stringify({ ok: true, reliable: false, rows })).ok, false)

console.log('chats JSON: 6 assertions passed')
