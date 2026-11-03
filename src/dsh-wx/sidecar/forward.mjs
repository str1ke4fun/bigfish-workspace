#!/usr/bin/env node
/**
 * forward.mjs —— WSL localhost → Windows 向量侧车的零依赖转发
 *
 * 为什么需要它：
 *   dsh-wx 只允许 embedding.url 指向本机（127.0.0.1 / localhost）。
 *   WSL2 没有 mirrored networking 时访问不到 Windows 的 localhost，
 *   但能通过默认网关访问 Windows。这个小转发器把这层拓扑差藏起来：
 *   插件照常连 127.0.0.1:8731，转发器再连 Windows 侧 18731。
 *
 * 用法：
 *   DSH_EMBED_TARGET=http://172.31.208.1:18731 node forward.mjs
 *   默认监听 127.0.0.1:8731；只转发 GET /health 与 POST /embed。
 */

import http from 'node:http'

const PORT = Math.max(1, Number(process.env.DSH_EMBED_PORT) || 8731)
const HOST = process.env.DSH_EMBED_HOST || '127.0.0.1'
const TARGET = new URL(process.env.DSH_EMBED_TARGET || 'http://172.31.208.1:18731')
const TIMEOUT_MS = Math.max(1000, Number(process.env.DSH_EMBED_TIMEOUT_MS) || 20_000)
const ALLOWED = new Set(['/embed', '/health'])

const log = (msg) => console.log('[embed-forward] ' + msg)

const server = http.createServer((req, res) => {
  const path = String(req.url || '').split('?')[0]
  if (!ALLOWED.has(path)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
    return
  }
  const upstream = http.request({
    host: TARGET.hostname,
    port: TARGET.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TARGET.host },
    timeout: TIMEOUT_MS,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (err) => {
    log('上游不可用：' + String(err?.message ?? err))
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }))
    } else {
      res.destroy()
    }
  })
  req.pipe(upstream)
})

server.listen(PORT, HOST, () => log(`127.0.0.1:${PORT} → ${TARGET.origin}（只转发 /embed、/health）`))

const bye = () => server.close(() => process.exit(0))
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
