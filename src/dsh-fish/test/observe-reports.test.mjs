/**
 * observe-reports.test.mjs —— /reports 在 B 站拆包（A2）之后还能自己读事件流
 *
 * A2 把 B 站模块搬去 dsh-bili，observe.js 里却还留着一个 `itemsFromEvents(...)`
 * 调用（原来从 browse.js import）。模块还在、只是没人 import，所以静态检查
 * 看不出问题；真去点「日报」时才炸 ReferenceError: itemsFromEvents is not defined。
 * 这里从 HTTP 路由层走一遍，保证报告页不靠 B 站插件也能出。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { appendEvent } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'

function fakeCtx() {
  const routes = []
  const cfg = { connection: null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function callRoute(routes, path, method, body) {
  const pathname = path.split('?')[0]
  const def = routes.find((d) => d.path === '/dsh-fish' + pathname)
  if (!def) throw new Error(`没注册这条路由：${pathname}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = '/dsh-fish' + path
  req.headers = { 'content-type': 'application/json' }
  let out = null
  const res = {
    statusCode: 0,
    ended: false,
    setHeader() {},
    writeHead(n) { this.statusCode = n },
    end(t) { this.ended = true; try { out = JSON.parse(String(t)) } catch { out = String(t) } },
  }
  return def.handler(req, res).then(() => ({ status: res.statusCode, body: out }))
}

test('/reports 读得到当天的 browse 记账，不依赖 B 站插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-rep-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })

    const dk = dateKey()
    await appendEvent(
      { type: 'meta', text: `browse:${dk} ${JSON.stringify([{ bvid: 'BV1x', title: '一个视频', up: '某人', duration: 60 }])}` },
      { day: 1, stage: 1, source: 'timer' },
      root,
    )

    const r = await callRoute(ctx.routes, `/reports?date=${dk}`, 'GET')
    assert.equal(r.status, 200)
    assert.equal(r.body.date, dk)
    assert.match(String(r.body.md), /一个视频/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
