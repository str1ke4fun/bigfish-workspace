// 状态键改 chatId 与一次性迁移：合成数据，不读 ~/.dsh-wx。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isChatIdKey, migrateMentions, migrateProactive, migrateRecent } from '../lib/state-key.js'
import { migrateStateFiles } from '../lib/index.js'
import { grant, canSpeak } from '../lib/mention.js'
import { quotaFor, consume, remaining } from '../lib/proactive.js'

const DIRS = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-state-migrate-'))
  DIRS.push(dir)
  return dir
}
after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }) })

test('mentions 旧名字键迁到 chatId，撞键取最大时间戳', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : 'c_' + n)
  assert.deepEqual(migrateMentions({ '❤️读书群': 10, '❤读书群': 20 }, keyOf), { c_heart: 20 })
})

test('proactive 旧名字键迁到 chatId，撞键取较大计数', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateProactive({ day: '2026-11-25', used: { A: 2, B: 5 } }, keyOf).used, { c_heart: 5 })
})

test('recent 旧数组迁到 chatId，按 key 去重取最大 at', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateRecent([{ chat: 'A', at: 1 }, { chat: 'B', at: 9 }], keyOf), [{ chatId: 'c_heart', chat: 'B', at: 9 }])
})

test('mention 两种 VS 写法共享同一个 @ 窗口', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : '')
  const state = grant({}, '❤️读书群', 1000, keyOf)
  assert.deepEqual(canSpeak(state, '❤读书群', 1000, 3, keyOf), { ok: true, leftMs: 180000 })
})

test('proactive 的 used 以 chatId 记账，额度按名字折叠查', () => {
  const policy = { proactivePerDay: 0, proactiveChats: { '❤️读书群': 2 }, hardBreaker: 50 }
  assert.equal(quotaFor(policy, 'c_heart', '❤读书群'), 2)
  const state = { ok: true, day: '2026-11-25', used: {} }
  const next = consume(policy, state, 'c_heart', '2026-11-25', '❤读书群')
  assert.deepEqual(next.state.used, { c_heart: 1 })
  assert.equal(remaining(policy, next.state, 'c_heart', '2026-11-25', '❤读书群'), 1)
})

test('chatId 形状识别认稳定 id 和 c_tmp_ 临时 id', () => {
  assert.equal(isChatIdKey('c_0123456789ab'), true)
  assert.equal(isChatIdKey(' c_0123456789ab '), true)
  assert.equal(isChatIdKey('c_tmp_0123456789'), true)
  assert.equal(isChatIdKey('c_tmp_012345678'), false)
  assert.equal(isChatIdKey('c_heart'), false)
  assert.equal(isChatIdKey('❤️读书群'), false)
  assert.equal(isChatIdKey(''), false)
})

// ---- 迁移 I/O：只碰临时目录 ----

test('迁移 I/O：旧名字键写回 chatId，留 0600 备份；再跑一次不重复哈希', () => {
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  const files = { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') }
  const legacy = { '❤️读书群': 10, '别群': 20 }
  writeFileSync(file, JSON.stringify(legacy))
  const logs = []
  const keyOf = (n) => (n === '❤️读书群' ? 'c_0123456789ab' : 'c_ba9876543210')
  const first = migrateStateFiles({ keyOf, files, log: (m) => logs.push(m) })

  assert.equal(first[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { c_0123456789ab: 10, c_ba9876543210: 20 })
  const backup = file + '.v1.bak'
  assert.equal(existsSync(backup), true)
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), legacy, '备份必须是旧内容')
  assert.equal(statSync(backup).mode & 0o777, 0o600)
  assert.equal(existsSync(file + '.migrated'), true)
  assert.match(logs.join('\n'), /改用 chatId 键/)

  const afterFirst = readFileSync(file, 'utf8')
  let keyOfCalls = 0
  const second = migrateStateFiles({
    keyOf: () => { keyOfCalls += 1; return 'c_deadbeef0000' },
    files,
    log: () => {},
  })
  assert.equal(second[0].status, 'already-chat-id')
  assert.equal(keyOfCalls, 0, '已是 chatId 的文件不能再走 keyOf')
  assert.equal(readFileSync(file, 'utf8'), afterFirst)
})

test('迁移 I/O：keyOf 给出 c_tmp_ 临时 id 时也按身份键处理，不重复哈希', () => {
  const TEMP_ID = 'c_tmp_0123456789'
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  const files = { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') }
  writeFileSync(file, JSON.stringify({ '待补全群...': 4 }))
  const first = migrateStateFiles({ keyOf: () => TEMP_ID, files, log: () => {} })
  assert.equal(first[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { [TEMP_ID]: 4 })

  let keyOfCalls = 0
  const second = migrateStateFiles({
    keyOf: () => { keyOfCalls += 1; return 'c_deadbeef0000' },
    files,
    log: () => {},
  })
  assert.equal(second[0].status, 'already-chat-id')
  assert.equal(keyOfCalls, 0, 'c_tmp_ 键不能被当成名字再哈希')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { [TEMP_ID]: 4 })
  // 纯函数本身也保持幂等。
  assert.deepEqual(
    migrateMentions({ [TEMP_ID]: 4 }, () => 'c_deadbeef0000'),
    { [TEMP_ID]: 4 },
  )
})

test('迁移 I/O：已是 chatId 键且没有标记也跳过；有标记但键变回名字仍会迁移', () => {
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  const files = { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') }
  writeFileSync(file, JSON.stringify({ c_0123456789ab: 1 }))
  const first = migrateStateFiles({ keyOf: () => 'c_ba9876543210', files, log: () => {} })
  assert.equal(first[0].status, 'already-chat-id')
  assert.equal(existsSync(file + '.v1.bak'), false, '跳过时不该产生备份')

  // 标记存在，但文件又被写成名字键：标记不能压制迁移。
  writeFileSync(file + '.migrated', '{}')
  writeFileSync(file, JSON.stringify({ 旧群: 5 }))
  const second = migrateStateFiles({ keyOf: () => 'c_ba9876543210', files, log: () => {} })
  assert.equal(second[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { c_ba9876543210: 5 })
})

test('迁移 I/O：旧文件不存在时不留标记，之后出现的旧文件仍会迁移', () => {
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  const files = { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') }
  const first = migrateStateFiles({ keyOf: () => 'c_0123456789ab', files, log: () => {} })
  assert.equal(first[0].status, 'missing')
  assert.equal(existsSync(file + '.migrated'), false)
  assert.equal(existsSync(file + '.v1.bak'), false)

  writeFileSync(file, JSON.stringify({ 后来群: 7 }))
  const second = migrateStateFiles({ keyOf: () => 'c_0123456789ab', files, log: () => {} })
  assert.equal(second[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { c_0123456789ab: 7 })
})

test('迁移 I/O：备份写不下去时原文件不动，失败写日志且下次可重试', () => {
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  const files = { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') }
  const original = JSON.stringify({ 旧群: 3 })
  writeFileSync(file, original)
  // 备份临时路径被目录占住 → writeFileSync 必然失败。
  mkdirSync(file + '.v1.bak.tmp')
  const logs = []
  const first = migrateStateFiles({ keyOf: () => 'c_0123456789ab', files, log: (m) => logs.push(m) })
  assert.equal(first[0].status, 'backup-failed')
  assert.equal(readFileSync(file, 'utf8'), original, '备份失败不能改源文件')
  assert.equal(existsSync(file + '.migrated'), false)
  assert.match(logs.join('\n'), /备份写不下去/)

  // 障碍移除后，同一个源文件能再次迁移。
  rmSync(file + '.v1.bak.tmp', { recursive: true, force: true })
  const second = migrateStateFiles({ keyOf: () => 'c_0123456789ab', files, log: () => {} })
  assert.equal(second[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { c_0123456789ab: 3 })
})

test('迁移 I/O：stateKey 为空的条目跳过，并在日志里报告丢弃数量', () => {
  const dir = tempDir()
  const file = join(dir, 'mentions.json')
  writeFileSync(file, JSON.stringify({ 好群: 3, 撞名群: 9 }))
  const logs = []
  const out = migrateStateFiles({
    keyOf: (n) => (n === '撞名群' ? '' : 'c_0123456789ab'),
    files: { mentions: file, proactive: join(dir, 'proactive.json'), recent: join(dir, 'recent-chats.json') },
    log: (m) => logs.push(m),
  })
  assert.equal(out[0].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { c_0123456789ab: 3 })
  assert.match(logs.join('\n'), /1 个条目因为没有稳定会话身份.*丢弃/)
})

test('迁移 I/O：proactive 与 recent 旧形状也按 chatId 写回', () => {
  const dir = tempDir()
  const proactive = join(dir, 'proactive.json')
  const recent = join(dir, 'recent-chats.json')
  writeFileSync(proactive, JSON.stringify({ day: '2026-11-25', used: { '❤️读书群': 2 } }))
  writeFileSync(recent, JSON.stringify([{ chat: '❤️读书群', at: 9 }]))
  const out = migrateStateFiles({
    keyOf: () => 'c_0123456789ab',
    files: { mentions: join(dir, 'mentions.json'), proactive, recent },
    log: () => {},
  })
  assert.equal(out[1].status, 'migrated')
  assert.equal(out[2].status, 'migrated')
  assert.deepEqual(JSON.parse(readFileSync(proactive, 'utf8')).used, { c_0123456789ab: 2 })
  assert.deepEqual(JSON.parse(readFileSync(recent, 'utf8')), [
    { chatId: 'c_0123456789ab', chat: '❤️读书群', at: 9 },
  ])
})
