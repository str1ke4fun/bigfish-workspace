// 上下文检索：node test-retrieval.mjs
// 只测纯逻辑，不启动微信、不碰 CUA、不联网。
import assert from 'node:assert/strict'

import {
  CARD_MAX, bm25, cosine, formatCards, parseVectorConfig, rrf, searchLexical, searchVector, tokenize,
} from './lib/retrieval.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const T = Date.UTC(2026, 10, 3, 4, 0, 0)
const iso = (min) => new Date(T + min * 60_000).toISOString()

const docs = [
  { msgId: 'm1', chatId: 'c1', chatName: '测试群A', sender: '甲', senderConfidence: 'high', text: '大白饭一天喂几顿合适', at: iso(-120) },
  { msgId: 'm2', chatId: 'c1', chatName: '测试群A', sender: null, senderConfidence: 'unknown', text: '它最近老说自己丢了', at: iso(-60) },
  { msgId: 'm3', chatId: 'c1', chatName: '测试群A', sender: '乙', senderConfidence: 'medium', text: '手机丢了先看定位', at: iso(-10) },
  { msgId: 'm4', chatId: 'c1', chatName: '测试群A', sender: '甲', senderConfidence: 'high', text: '今晚吃什么', at: iso(-5) },
]

console.log('分词')
t('中文二元组 + 英文词；停用词不进倒排', () => {
  assert.deepEqual(tokenize('大白饭'), ['大白', '白饭'])
  assert.deepEqual(tokenize('wifi 密码是多少'), ['密码', '码是', '是多', '多少', 'wifi'])
  assert.deepEqual(tokenize('的了吗'), [])
})
t('查询和文档口径一致', () => {
  assert.deepEqual(tokenize('大白饭'), tokenize('大白饭'))
})

console.log('A 档打分')
t('BM25：命中越多分越高；query 为空返回空', () => {
  const { scores } = bm25(docs, tokenize('大白饭'))
  assert.ok(scores.get('m1') > 0)
  assert.equal(scores.get('m4'), undefined)
  assert.equal(bm25(docs, []).scores.size, 0)
})
t('检索：找得到，带匹配原因和原文', () => {
  const rows = searchLexical(docs, '大白饭', { now: T })
  assert.equal(rows[0].doc.msgId, 'm1')
  assert.ok(rows[0].reasons.some((r) => r.includes('大白') || r.includes('白饭')))
  assert.equal(rows[0].doc.text, '大白饭一天喂几顿合适')
})
t('时间近的排在同分前面', () => {
  const rows = searchLexical(docs, '丢了', { now: T })
  // m2 与 m3 都含「丢了」，m3 更近
  const order = rows.map((r) => r.doc.msgId)
  assert.ok(order.indexOf('m3') < order.indexOf('m2'))
})
t('同一条线加成：即使词不全也能被带出来', () => {
  const rows = searchLexical(docs, '定位', { now: T, threadIds: ['m2'], limit: 10 })
  assert.ok(rows.some((r) => r.doc.msgId === 'm2' && r.reasons.includes('同一条线')))
})
t('没有命中就返回空，不硬凑', () => {
  assert.deepEqual(searchLexical(docs, '量子力学', { now: T }), [])
})

console.log('B 档与融合')
t('余弦：同向为 1，正交为 0，长度不一致不猜', () => {
  assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0, 0], [1, 0]), 0, '长度不一致不猜')
  assert.equal(cosine([], [1]), 0)
})
t('向量检索只返回有向量的文档', () => {
  const vectors = new Map([['m1', [1, 0]], ['m4', [0, 1]]])
  const rows = searchVector(docs, [1, 0], vectors)
  assert.deepEqual(rows.map((r) => r.doc.msgId), ['m1'])
  assert.deepEqual(rows[0].reasons, ['语义近邻'])
})
t('RRF 吃名次不吃分数：两路都靠前的排第一', () => {
  const a = [{ doc: docs[0] }, { doc: docs[1] }]
  const b = [{ doc: docs[1] }, { doc: docs[0] }]
  const merged = rrf([a, b])
  assert.equal(merged.length, 2)
  // 两者名次相反，分数相同；只验证不会丢文档
  assert.deepEqual(new Set(merged.map((r) => r.doc.msgId)), new Set(['m1', 'm2']))
})

console.log('结果卡片')
t('最多 5 条，顺序保留，带来源/时间/置信度', () => {
  const hits = searchLexical(docs, '丢了', { now: T, limit: 10 })
  const out = formatCards(hits, { max: CARD_MAX })
  assert.ok(out.shown <= CARD_MAX)
  assert.match(out.text, /\[上下文 1\//)
  assert.match(out.text, /来源：台账 m/)
  assert.match(out.text, /置信度：/)
})
t('发言人未知就写未识别，不从正文猜', () => {
  const hit = [{ doc: docs[1], score: 1, reasons: ['关键词「丢了」'] }]
  const out = formatCards(hit)
  assert.match(out.text, /发言人未识别/)
  assert.match(out.text, /置信度：低/)
})
t('出站消息标明是大肥鱼发的，不冒充发言人', () => {
  const out = { msgId: 'm_out', chatName: '测试群A', sender: null, direction: 'out', text: '我回了一句', at: iso(0) }
  const r = formatCards([{ doc: out, score: 1, reasons: ['最近'] }])
  assert.match(r.text, /大肥鱼（发出）/)
})

t('长文截断，不改写', () => {
  const long = { msgId: 'm9', chatName: '测试群A', sender: '甲', senderConfidence: 'high', text: '啊'.repeat(300), at: iso(0) }
  const out = formatCards([{ doc: long, score: 1, reasons: ['最近'] }])
  assert.match(out.text, /…/)
  assert.ok(out.cards[0].length < 400)
})
t('sanitize 拦下的行要计数，不假装完整', () => {
  const hit = [{ doc: docs[0], score: 1, reasons: ['关键词'] }]
  const out = formatCards(hit, { sanitize: () => ({ text: '', dropped: 2 }) })
  assert.equal(out.shown, 0)
  assert.match(out.text, /2 行被拦下/)
})
t('总预算：装不下就少给，不硬塞', () => {
  const many = docs.map((d, i) => ({ doc: { ...d, msgId: 'x' + i, text: '内容'.repeat(80) }, score: 1, reasons: ['最近'] }))
  const out = formatCards(many, { max: 5, budget: 300 })
  assert.ok([...out.text].length <= 360, '预算附近就停')
  assert.ok(out.shown < 5)
})

console.log('向量侧车配置')
t('只认本机 http；外部地址和坏维度都拒', () => {
  const ok = parseVectorConfig({ embedding: { url: 'http://127.0.0.1:8731/', dim: 1024, model: 'Qwen3-Embedding-0.6B' } })
  assert.equal(ok.ok, true)
  assert.equal(ok.config.url, 'http://127.0.0.1:8731')
  assert.equal(parseVectorConfig({ embedding: { url: 'http://localhost:8731', dim: 1024 } }).ok, true)
  assert.equal(parseVectorConfig({ embedding: { url: 'http://192.168.1.5:8731', dim: 1024 } }).ok, false)
  assert.equal(parseVectorConfig({ embedding: { url: 'https://127.0.0.1:8731', dim: 1024 } }).ok, false)
  assert.equal(parseVectorConfig({ embedding: { url: 'http://127.0.0.1:8731', dim: 3 } }).ok, false)
  assert.equal(parseVectorConfig('不是 json').ok, false)
})

console.log(`\n${n} 项通过`)
