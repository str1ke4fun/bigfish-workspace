/**
 * routes.test.mjs —— `/dsh-bili/*` 的路由层：信任栅栏、状态码、二进制响应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBiliService } from '../lib/service.js'
import { registerBiliObserve } from '../lib/observe.js'
import { setCore } from '../lib/core.js'
import { fakeCore } from './helpers.mjs'

async function harness({ connection = { requestRejection: () => null } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-routes-'))
  const { core } = fakeCore({ events: [], config: {} })
  core.toolLedger = null // 这个文件要验 /ledger 的「服务不在」分支
  setCore(core)
  const routes = new Map()
  const ctx = {
    get(key) {
      if (key === 'connection') return connection
      return undefined
    },
    webServer: {
      register(def) {
        routes.set(def.path, def.handler)
        return () => routes.delete(def.path)
      },
    },
  }
  // 不联网：view 返回没有 pic，封面/评论正文都走「拿不到」分支。
  const service = createBiliService({
    root,
    makeClient: () => ({ view: async () => ({ ok: false, data: {} }), replyDetail: async () => ({ ok: false }) }),
  })
  const obs = registerBiliObserve(ctx, { service })
  return { root, routes, obs, close: () => { obs.dispose(); setCore(null) } }
}

function call(handler, { url = '/dsh-bili/status', method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : [])
    req.url = url
    req.method = method
    let status = 0
    let headers = {}
    const chunks = []
    const res = {
      writableEnded: false,
      writeHead(code, h) { status = code; headers = h || {} },
      end(buf) {
        if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
        this.writableEnded = true
        resolve({ status, headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') })
      },
    }
    try { handler(req, res) } catch (err) { reject(err) }
  })
}

test('没挂 connection 服务：一律 503，不放行', async () => {
  const h = await harness({ connection: null })
  try {
    const r = await call(h.routes.get('/dsh-bili/status'))
    assert.equal(r.status, 503)
  } finally { h.close() }
})

test('信任栅栏拒绝跨站请求', async () => {
  const h = await harness({ connection: { requestRejection: () => ({ status: 403, message: 'bad origin' }) } })
  try {
    const r = await call(h.routes.get('/dsh-bili/status'))
    assert.equal(r.status, 403)
    assert.match(r.text, /bad origin/)
  } finally { h.close() }
})

test('/status 返回 JSON；/history 参数夹紧', async () => {
  const h = await harness()
  try {
    const st = await call(h.routes.get('/dsh-bili/status'))
    assert.equal(st.status, 200)
    assert.equal(JSON.parse(st.text).installed, true)
    const hi = await call(h.routes.get('/dsh-bili/history'), { url: '/dsh-bili/history?days=9999' })
    assert.equal(JSON.parse(hi.text).days, 180)
  } finally { h.close() }
})

test('POST /risk 读 JSON body；非法 body 当没传', async () => {
  const h = await harness()
  try {
    const ok = await call(h.routes.get('/dsh-bili/risk'), { method: 'POST', body: '{"clear":true}' })
    assert.equal(JSON.parse(ok.text).cleared, true)
    const bad = await call(h.routes.get('/dsh-bili/risk'), { method: 'POST', body: 'not json' })
    assert.equal(JSON.parse(bad.text).cleared, false)
  } finally { h.close() }
})

test('缺图 / 缺抽帧图：404 且是 JSON', async () => {
  const h = await harness()
  try {
    const cover = await call(h.routes.get('/dsh-bili/cover'), { url: '/dsh-bili/cover/BV1xx411c7mD' })
    assert.equal(cover.status, 404)
    assert.equal(JSON.parse(cover.text).error, 'no cover')
    const sheet = await call(h.routes.get('/dsh-bili/sheet'), { url: '/dsh-bili/sheet/not-a-bv' })
    assert.equal(sheet.status, 404)
    assert.equal(JSON.parse(sheet.text).error, 'no sheet')
  } finally { h.close() }
})

test('/ledger 没有台账服务时给 NO_LEDGER，而不是 500', async () => {
  const h = await harness()
  try {
    const r = await call(h.routes.get('/dsh-bili/ledger'))
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.text).ok, false)
    assert.equal(JSON.parse(r.text).code, 'NO_LEDGER')
  } finally { h.close() }
})
