// 消息台账：node test-ledger.mjs
// 只测纯逻辑（临时目录），不启动微信、不碰 CUA。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { chatIdFor, createLedger, dedupeKeyOf, msgIdOf, normalizeText } from './lib/ledger.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-ledger-'))
const T = Date.UTC(2026, 10, 3, 4, 0, 0)

console.log('基础')
t('正文归一：压空白、去首尾、保留换行', () => {
  assert.equal(normalizeText('  a\t\tb  \n c  '), 'a b\nc')
})
t('chatId 稳定；去重键随会话、发言人、正文变', () => {
  assert.equal(chatIdFor('测试群A'), chatIdFor(' 测试群A '))
  assert.notEqual(chatIdFor('测试群A'), chatIdFor('测试群B'))
  const a = dedupeKeyOf({ chatId: 'c1', sender: '甲', text: '早' })
  assert.equal(a, dedupeKeyOf({ chatId: 'c1', sender: '甲', text: '早' }))
  assert.notEqual(a, dedupeKeyOf({ chatId: 'c2', sender: '甲', text: '早' }))
  assert.notEqual(a, dedupeKeyOf({ chatId: 'c1', sender: '乙', text: '早' }))
  assert.match(msgIdOf(a), /^m_[0-9a-f]{16}$/)
})

console.log('追加与去重')
t('同一屏重复读 → 只入账一次', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  const msgs = [
    { sender: '甲', text: '早' },
    { sender: '乙', text: '早啊' },
    { sender: '甲', text: '今天吃什么' },
  ]
  assert.equal(l.append('c1', msgs).added, 3)
  assert.equal(l.append('c1', msgs).added, 0)
  assert.equal(l.append('c1', msgs).skipped, 3)
  assert.equal(l.recent('c1', 10).length, 3)
})
t('重叠窗口：只补新的一条', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  const a = [{ sender: '甲', text: '一' }, { sender: '乙', text: '二' }]
  l.append('c1', a)
  const r = l.append('c1', [{ sender: '乙', text: '二' }, { sender: '甲', text: '三' }])
  assert.equal(r.added, 1)
  assert.equal(r.skipped, 1)
  assert.deepEqual(l.recent('c1', 10).map((x) => x.text), ['一', '二', '三'])
})
t('同一个人连说两句一样的话：邻接不同，两句都留', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  const r = l.append('c1', [
    { sender: '甲', text: '前面' },
    { sender: '甲', text: '哈哈' },
    { sender: '甲', text: '哈哈' },
  ])
  assert.equal(r.added, 3)
  assert.equal(l.recent('c1', 9).filter((x) => x.text === '哈哈').length, 2)
})
t('不同会话互不影响', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  l.append('c1', [{ sender: '甲', text: '同一句' }])
  assert.equal(l.append('c2', [{ sender: '甲', text: '同一句' }]).added, 1)
})

console.log('读')
t('window：before + limit，按时间正序', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  l.append('c1', [
    { sender: '甲', text: '一', at: '2026-11-03T01:00:00Z' },
    { sender: '甲', text: '二', at: '2026-11-03T02:00:00Z' },
    { sender: '甲', text: '三', at: '2026-11-03T03:00:00Z' },
  ])
  assert.deepEqual(l.window('c1', { before: '2026-11-03T03:00:00Z', limit: 10 }).map((x) => x.text), ['一', '二'])
  assert.deepEqual(l.window('c1', { limit: 2 }).map((x) => x.text), ['二', '三'])
})
t('跨月分文件；重开一个实例仍能读回', () => {
  const d = dir()
  const l = createLedger({ dir: d, now: () => T })
  l.append('c1', [
    { sender: '甲', text: '十月', at: '2026-10-31T12:00:00Z' },
    { sender: '甲', text: '十一月', at: '2026-11-01T12:00:00Z' },
  ])
  const files = readdirSync(d).filter((f) => f.startsWith('c1-'))
  assert.deepEqual(files.sort(), ['c1-2026-10.jsonl', 'c1-2026-11.jsonl'])
  const again = createLedger({ dir: d, now: () => T })
  assert.deepEqual(again.recent('c1', 10).map((x) => x.text), ['十月', '十一月'])
})
t('坏行跳过，其余照读', () => {
  const d = dir()
  const l = createLedger({ dir: d, now: () => T })
  l.append('c1', [{ sender: '甲', text: '好行' }])
  const file = join(d, 'c1-2026-11.jsonl')
  writeFileSync(file, readFileSync(file, 'utf8') + '{坏行\n', 'utf8')
  const again = createLedger({ dir: d, now: () => T })
  assert.equal(again.recent('c1', 10).length, 1)
})

console.log('纠正')
t('repair 改发言人，不改正文；原文行还在', () => {
  const d = dir()
  const l = createLedger({ dir: d, now: () => T })
  const r = l.append('c1', [{ sender: null, text: '这句话是谁说的' }])
  const id = r.records[0].msgId
  const fixed = l.repair('c1', { msgId: id, sender: '甲', senderConfidence: 'high', why: '树子树补上发言人' })
  assert.equal(fixed.ok, true)
  const doc = l.recent('c1', 5)[0]
  assert.equal(doc.sender, '甲')
  assert.equal(doc.senderConfidence, 'high')
  assert.equal(doc.repaired, true)
  assert.equal(doc.text, '这句话是谁说的')
  const raw = readFileSync(join(d, 'c1-2026-11.jsonl'), 'utf8')
  assert.match(raw, /"type":"repair"/)
  assert.match(raw, /这句话是谁说的/)
})
t('repair 不认识的消息 → 拒绝，不写', () => {
  const l = createLedger({ dir: dir(), now: () => T })
  const r = l.repair('c1', { msgId: 'm_0000000000000000', sender: '甲' })
  assert.equal(r.ok, false)
  assert.match(r.why, /没有/)
})

console.log(`\n${n} 项通过`)
