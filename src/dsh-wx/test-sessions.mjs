// 多会话池：node test-sessions.mjs
// 只测映射（chatId ↔ sessionId），不创建宿主会话。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionPool } from './lib/sessions.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const file = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-sess-')), 'sessions.json')
const T = Date.UTC(2026, 10, 3, 4, 0, 0)

console.log('分配')
t('主会话认领第一个群；同一群不会占 worker 名额', () => {
  const p = createSessionPool({ file: file(), maxSessions: 2, now: () => T })
  assert.equal(p.sessionFor('c1'), '')
  p.assignMain('c1', 's-main', '测试群A')
  assert.equal(p.sessionFor('c1'), 's-main')
  assert.equal(p.list().length, 0)
  assert.equal(p.stats().workers, 0)
})
t('第二个群进 worker；满了回落（调用方用主会话）', () => {
  const p = createSessionPool({ file: file(), maxSessions: 2, now: () => T })
  p.assignMain('c1', 's-main', '测试群A')
  assert.equal(p.assign('c2', 's-w2', '测试群B').ok, true)
  assert.equal(p.sessionFor('c2'), 's-w2')
  const full = p.assign('c3', 's-w3', '测试群C')
  assert.equal(full.ok, false)
  assert.equal(full.full, true)
  assert.equal(p.sessionFor('c3'), '')
})
t('一个会话只负责一个群；反查也对得上', () => {
  const p = createSessionPool({ file: file(), maxSessions: 3, now: () => T })
  p.assignMain('c1', 's-main', '测试群A')
  p.assign('c2', 's-w2', '测试群B')
  assert.equal(p.chatOf('s-main'), 'c1')
  assert.equal(p.chatOf('s-w2'), 'c2')
  assert.equal(p.chatOf('s-nope'), '')
  assert.deepEqual(p.sessionIds().sort(), ['s-main', 's-w2'])
})
t('maxSessions=1 时没有 worker 名额', () => {
  const p = createSessionPool({ file: file(), maxSessions: 1, now: () => T })
  p.assignMain('c1', 's-main')
  assert.equal(p.assign('c2', 's-w2').full, true)
})

console.log('持久化')
t('写盘 0600；重开实例映射还在', () => {
  const f = file()
  const p = createSessionPool({ file: f, maxSessions: 3, now: () => T })
  p.assignMain('c1', 's-main', '测试群A')
  p.assign('c2', 's-w2', '测试群B')
  assert.equal(statSync(f).mode & 0o777, 0o600)
  const again = createSessionPool({ file: f, maxSessions: 3, now: () => T })
  assert.equal(again.sessionFor('c1'), 's-main')
  assert.equal(again.sessionFor('c2'), 's-w2')
  assert.equal(again.stats().mainChatName, '测试群A')
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).v, 1)
})
t('文件坏了按空池处理；remove 只清一个群', () => {
  const f = file()
  const p = createSessionPool({ file: f, maxSessions: 3, now: () => T })
  p.assignMain('c1', 's-main', '测试群A')
  p.assign('c2', 's-w2', '测试群B')
  p.remove('c2')
  assert.equal(p.sessionFor('c2'), '')
  assert.equal(p.sessionFor('c1'), 's-main')
})
t('reset 只清映射，不碰宿主会话', () => {
  const p = createSessionPool({ file: file(), maxSessions: 3, now: () => T })
  p.assignMain('c1', 's-main')
  p.assign('c2', 's-w2')
  p.reset()
  assert.equal(p.sessionFor('c1'), '')
  assert.equal(p.stats().sessions, 0)
})

console.log(`\n${n} 项通过`)
