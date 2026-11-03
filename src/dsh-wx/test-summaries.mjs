// L2 每日摘要：node test-summaries.mjs
// 只测确定性汇总和只追加写入；不调用模型。
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildDailySummary, participantsOf, questionsOf, summaryDocs, writeDailySummaries,
} from './lib/summaries.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-sum-'))

const doc = (text, over = {}) => ({
  msgId: 'm_' + text, chatId: 'c1', sender: '甲', kind: 'text', text,
  at: '2026-11-02T10:00:00Z', direction: 'in', ...over,
})

console.log('汇总')
t('参与者按条数排序；出站不冒充发言人', () => {
  const rows = participantsOf([
    doc('一'), doc('二'), doc('三', { sender: '乙' }), doc('四', { sender: null, direction: 'out' }),
  ])
  assert.equal(rows[0][0], '甲')
  assert.ok(rows.some(([name]) => name === '乙'))
  assert.ok(rows.some(([name]) => name === '大肥鱼'))
})
t('待跟进：最近的问句，去重，最多 3 条', () => {
  const rows = questionsOf([
    doc('吃了吗', { at: '2026-11-02T10:00:00Z' }),
    doc('吃了吗', { at: '2026-11-02T11:00:00Z' }),
    doc('明天几点出发？', { at: '2026-11-02T12:00:00Z' }),
    doc('这个多少钱', { at: '2026-11-02T13:00:00Z' }),
    doc('她问「为什么」', { at: '2026-11-02T14:00:00Z' }),
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows.at(-1), '她问「为什么」')
})
t('摘要卡是台账形状：kind=summary、可检索、带参与者/关键词/问句', () => {
  const card = buildDailySummary({
    chatId: 'c1', chatName: '测试群A', day: '2026-11-02',
    docs: [
      doc('大白饭一天喂几顿'),
      doc('大白饭一天喂两顿', { sender: '乙' }),
      doc('明天几点出发？', { sender: '乙' }),
    ],
  })
  assert.equal(card.kind, 'summary')
  assert.match(card.msgId, /^s_[0-9a-f]{16}$/)
  assert.equal(card.chatId, 'c1')
  assert.equal(card.count, 3)
  assert.match(card.text, /2026-11-02｜3 条/)
  assert.match(card.text, /参与者：/)
  assert.deepEqual(card.keywords.includes('大白'), true)
  assert.equal(card.questions.includes('明天几点出发？'), true)
  assert.equal(card.at, '2026-11-02T23:59:59.000Z')
})
t('同样的输入生成同样的 msgId（确定性）', () => {
  const docs = [doc('一'), doc('二')]
  const a = buildDailySummary({ chatId: 'c1', day: '2026-11-02', docs })
  const b = buildDailySummary({ chatId: 'c1', day: '2026-11-02', docs: [...docs] })
  assert.equal(a.msgId, b.msgId)
})

console.log('写入')
t('只写过去的天；内容没变不重复写；变了追加新版本', () => {
  const d = dir()
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  const docs = [doc('昨天的第一句'), doc('昨天的第二句')]
  const a = writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', chatName: '测试群A', docs }], now: () => now })
  assert.equal(a.written.length, 1)
  assert.equal(a.written[0].day, '2026-11-02')
  const b = writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', chatName: '测试群A', docs }], now: () => now })
  assert.equal(b.written.length, 0)
  assert.equal(b.skipped[0].why, 'unchanged')
  const c = writeDailySummaries({
    dir: d, chats: [{ chatId: 'c1', chatName: '测试群A', docs: [...docs, doc('后来补的一句')] }], now: () => now,
  })
  assert.equal(c.written.length, 1)
  assert.equal(c.written[0].revision, 2)
  const file = join(d, 'c1-2026-11-02.jsonl')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
})
t('今天默认不写；includeToday=true 才写', () => {
  const d = dir()
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  const docs = [doc('今天的话', { at: '2026-11-03T11:00:00Z' })]
  assert.equal(writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs }], now: () => now }).written.length, 0)
  assert.equal(writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs }], now: () => now, includeToday: true }).written.length, 1)
})
t('summaryDocs 每天取最后一版，按天排序', () => {
  const d = dir()
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  const day1 = [doc('一号', { at: '2026-11-01T10:00:00Z' })]
  const day2 = [doc('二号', { at: '2026-11-02T10:00:00Z' })]
  writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs: day1 }], now: () => now })
  writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs: day2 }], now: () => now })
  writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs: [...day1, doc('一号补充', { at: '2026-11-01T11:00:00Z' })] }], now: () => now })
  const rows = summaryDocs(d, 'c1')
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-01', '2026-11-02'])
  assert.equal(rows[0].revision, 2)
  assert.match(rows[0].text, /一号补充/)
})
t('坏行跳过，不影响别的天', () => {
  const d = dir()
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  writeDailySummaries({ dir: d, chats: [{ chatId: 'c1', docs: [doc('好', { at: '2026-11-02T10:00:00Z' })] }], now: () => now })
  const file = join(d, 'c1-2026-11-02.jsonl')
  appendFileSync(file, '{坏行\n')
  const rows = summaryDocs(d, 'c1', { log: () => {} })
  assert.equal(rows.length, 1)
  assert.ok(readdirSync(d).includes('c1-2026-11-02.jsonl'))
})

console.log(`\n${n} 项通过`)
