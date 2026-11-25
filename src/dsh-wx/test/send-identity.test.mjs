import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDirectory } from '../lib/directory.js'
import { canSendWithPolicy, findAllowedChat } from '../lib/reminder.js'
import { allowedCurrent, sameName, targetMatches } from '../lib/tree.js'
import { createSendGate } from '../lib/send-gate.js'
import { chatIdFor } from '../lib/ledger.js'
import { chatIdSeed } from '../lib/name.js'

const T = Date.UTC(2026, 10, 25, 4, 0, 0)
const temp = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-send-id-')), 'directory.json')
const seeded = (chats) => {
  const file = temp()
  writeFileSync(file, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return createDirectory({ file, now: () => T, log: () => {} })
}

test('名单与目标只差 VS16 时仍能匹配', () => {
  const p = { enabled: true, allowChats: ['❤️读书群'], noMentionChats: [] }
  assert.equal(findAllowedChat(p, '❤读书群'), '❤️读书群')
  assert.deepEqual(canSendWithPolicy(p, '❤读书群'), { ok: true, chat: '❤️读书群' })
})

test('名单内部折叠撞名时拒绝', () => {
  const p = { enabled: true, allowChats: ['❤️读书群', '❤读书群'], noMentionChats: [] }
  const r = canSendWithPolicy(p, '❤读书群')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WX_CHAT_AMBIGUOUS')
})

test('免 @ 名单与允许名单之间折叠撞名也拒绝', () => {
  const p = { enabled: true, allowChats: ['❤️读书群'], noMentionChats: ['❤读书群'] }
  const r = canSendWithPolicy(p, '❤️读书群')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WX_CHAT_AMBIGUOUS')
})

test('targetMatches 比 chatId，不比字符串', () => {
  const dir = seeded([{
    chatId: 'c_heart', displayName: '❤️读书群', fullName: '❤️读书群',
    nameConfidence: 'exact',
  }])
  const targetId = dir.idFor('❤️读书群')
  const lookup = (name) => dir.lookupName(name, { tiers: ['exact', 'folded'] })
  assert.equal(targetMatches('❤读书群', targetId, { lookupName: lookup }), true)
  assert.equal(targetMatches('别的群', targetId, { lookupName: lookup }), false)
})

test('未知会话也能用 chatIdSeed 派生同一个 id', () => {
  const targetId = chatIdFor(chatIdSeed('🌊周末海边🏖️'))
  const lookup = () => ({ status: 'unknown', chatId: '', match: null, matches: [] })
  assert.equal(targetMatches('🌊周末海边🏖️', targetId, { lookupName: lookup }), true)
})

test('当前会话在目录里撞名时 targetMatches 一律 false', () => {
  const targetId = chatIdFor(chatIdSeed('撞名群'))
  const lookup = () => ({ status: 'ambiguous', chatId: '', match: null, matches: [] })
  assert.equal(targetMatches('撞名群', targetId, { lookupName: lookup }), false)
})

test('发送闸注入 targetMatches 时按 chatId 核对当前会话', async () => {
  const policy = {
    enabled: true,
    allowChats: ['策略名'],
    noMentionChats: [],
    requireMention: false,
    mentionWindowMinutes: 3,
    proactivePerDay: 0,
    proactiveChats: {},
  }
  const gate = createSendGate({
    policy: () => policy,
    hostBlocksSend: () => false,
    look: async () => ({ parsed: { ok: true, current: '界面显示名', chats: [], messages: [] } }),
    isStale: () => false,
    staleDetail: () => '',
    allowedCurrent,
    sameName,
    lookupName: () => ({ status: 'unknown', chatId: '', match: null, matches: [] }),
    targetMatches: (current, chatId) => current === '界面显示名' && chatId === 'c_target',
    canSpeak: () => ({ ok: true }),
    readMentions: () => ({}),
    loadState: () => ({ ok: true, day: '2026-11-25', used: {} }),
    decideProactive: () => ({ ok: true, proactive: false, left: 0 }),
    consumeProactive: () => ({ state: {}, left: 0 }),
    saveState: () => true,
    logInbound: () => {},
    now: () => T,
  })
  const result = await gate({ target: { chat: '策略名', canonicalChat: '另一写法', chatId: 'c_target' } })
  assert.equal(result.chat, '策略名')
})
