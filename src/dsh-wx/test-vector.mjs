// 本地向量侧车：node test-vector.mjs
// 只测纯逻辑和假 fetch，不联网、不启动侧车。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createVectorProvider, embeddingsOf } from './lib/vector.js'

let n = 0
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name) }
const dir = () => mkdtempSync(join(tmpdir(), 'dsh-wx-vector-'))
const T = Date.UTC(2026, 10, 3, 4, 0, 0)

const vec = (text) => {
  const v = Array(8).fill(0)
  if (String(text).includes('大白饭')) v[0] = 1
  else if (String(text).includes('丢了')) v[1] = 1
  else v[7] = 1
  return v
}

const fakeFetch = (calls) => async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) })
  const input = JSON.parse(opts.body).input
  return { ok: true, status: 200, json: async () => ({ embeddings: input.map(vec) }) }
}

const cfg = (d, over = {}) => {
  const file = join(d, 'context.json')
  writeFileSync(file, JSON.stringify({
    embedding: { url: 'http://127.0.0.1:8731', dim: 8, model: 'test-embed', ...over },
  }))
  return file
}

const docs = [
  { msgId: 'm1', chatId: 'c1', text: '大白饭一天喂几顿' },
  { msgId: 'm2', chatId: 'c1', text: '手机丢了先看定位' },
]

console.log('本地侧车')
await t('没有配置 → 不可用，不发请求', async () => {
  const calls = []
  const p = createVectorProvider({ configFile: join(dir(), 'none.json'), cacheDir: dir(), fetchImpl: fakeFetch(calls), now: () => T })
  assert.equal(await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } }), null)
  assert.equal(calls.length, 0)
})

await t('本机侧车：查询命中语义近邻，结果有序', async () => {
  const d = dir()
  const calls = []
  const p = createVectorProvider({ configFile: cfg(d), cacheDir: join(d, 'vectors'), fetchImpl: fakeFetch(calls), now: () => T })
  const rows = await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } })
  assert.equal(rows[0].doc.msgId, 'm1')
  assert.deepEqual(rows[0].reasons, ['语义近邻'])
  assert.equal(calls[0].body.input.length, 2)
})

await t('消息向量落缓存：第二次只嵌入查询', async () => {
  const d = dir()
  const calls = []
  const p = createVectorProvider({ configFile: cfg(d), cacheDir: join(d, 'vectors'), fetchImpl: fakeFetch(calls), now: () => T })
  await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } })
  await p.provider({ query: '丢了', docs, task: { chatId: 'c1' } })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2].body.input, ['丢了'])
})

await t('外部地址拒绝，不会发出去', async () => {
  const d = dir()
  const calls = []
  const p = createVectorProvider({
    configFile: cfg(d, { url: 'http://192.168.1.5:8731' }), cacheDir: join(d, 'vectors'),
    fetchImpl: fakeFetch(calls), now: () => T,
  })
  assert.equal(await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } }), null)
  assert.equal(calls.length, 0)
})

await t('侧车失败 → 不可用并断开 10 分钟，不拖住每个查询', async () => {
  const d = dir()
  let calls = 0
  const p = createVectorProvider({
    configFile: cfg(d), cacheDir: join(d, 'vectors'), now: () => T,
    fetchImpl: async () => { calls++; throw new Error('sidecar down') },
  })
  assert.equal(await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } }), null)
  assert.equal(await p.provider({ query: '大白饭', docs, task: { chatId: 'c1' } }), null)
  assert.equal(calls, 1)
})

await t('响应格式兼容两种写法', () => {
  assert.deepEqual(embeddingsOf({ embeddings: [[1, 2]] }), [[1, 2]])
  assert.deepEqual(embeddingsOf({ data: [{ embedding: [3, 4] }] }), [[3, 4]])
  assert.deepEqual(embeddingsOf({ nope: 1 }), [])
})

console.log(`\n${n} 项通过`)
