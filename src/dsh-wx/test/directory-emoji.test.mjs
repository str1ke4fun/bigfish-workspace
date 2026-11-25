// 目录身份与折叠合并：node --test test/directory-emoji.test.mjs
// 只测合成数据，不读 ~/.dsh-wx，不启动微信。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDirectory } from '../lib/directory.js'

const T = Date.UTC(2026, 10, 25, 4, 0, 0)
const temp = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-emoji-dir-')), 'directory.json')
const seeded = (chats) => {
  const file = temp()
  writeFileSync(file, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return createDirectory({ file, now: () => T, log: () => {} })
}

test('VS 变体合并到同一个 chatId，规范名保留第一次见到的写法', () => {
  const dir = seeded([{
    chatId: 'c_heart', displayName: '❤️读书群', fullName: '❤️读书群',
    nameConfidence: 'exact', firstSeenAt: new Date(T).toISOString(),
  }])
  dir.merge({ chats: [{ name: '❤读书群', preview: '' }], knownNames: ['❤️读书群'] })
  const hit = dir.lookupName('❤读书群')
  assert.equal(hit.status, 'folded')
  assert.equal(hit.chatId, 'c_heart')
  assert.equal(hit.displayName, '❤️读书群')
  assert.equal(dir.stateKey('❤读书群'), 'c_heart')
  assert.equal(dir.sameEntry('❤️读书群', '❤读书群'), true)
})

test('两个不同 emoji 群不会被折叠合并', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '👨‍👩‍👧群' }, { name: '👨‍👩‍👦群' }] })
  assert.notEqual(dir.idFor('👨‍👩‍👧群'), dir.idFor('👨‍👩‍👦群'))
})

test('折叠撞名 fail closed，stateKey 为空', () => {
  const dir = seeded([
    { chatId: 'c_a', displayName: '❤️读书群', fullName: '❤️读书群', nameConfidence: 'exact' },
    { chatId: 'c_b', displayName: '❤读书群', fullName: '❤读书群', nameConfidence: 'exact' },
  ])
  const hit = dir.lookupName('❤读书群')
  assert.equal(hit.status, 'ambiguous')
  assert.equal(hit.chatId, '')
  assert.equal(dir.stateKey('❤️读书群'), '')
  assert.equal(dir.sendableTarget('❤读书群'), null)
})

test('纯旗帜群名能建条目并拿到稳定 chatId', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '🇨🇳群', preview: '' }] })
  const id1 = dir.idFor('🇨🇳群')
  assert.match(id1, /^c_/)
  dir.merge({ chats: [{ name: '🇨🇳群', preview: '' }] })
  assert.equal(dir.idFor('🇨🇳群'), id1)
})

test('截断 emoji 名解析成全名，不留下半个代理', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '🌊周末海边🏖️' }], knownNames: ['🌊周末海边🏖️'] })
  dir.merge({ chats: [{ name: '🌊周末海...' }] })
  assert.equal(dir.lookupName('🌊周末海...').displayName, '🌊周末海边🏖️')
  assert.equal(JSON.stringify(dir.all()).includes('\uD83D'), false)
})

test('加载时折叠撞名不覆盖 duplicate-name 临时条目的自愈', () => {
  const dir = seeded([
    { chatId: 'c_real', displayName: '撞名群', fullName: '撞名群', nameConfidence: 'exact' },
    { chatId: 'c_tmp_x', displayName: '撞名群', fullName: '撞名群', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
  ])
  assert.equal(dir.entry('撞名群'), null)
  assert.equal(dir.stateKey('撞名群'), '')
})
