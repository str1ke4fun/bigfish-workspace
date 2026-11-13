import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createFishBff } from '../fish/bff.mjs'

async function listen(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}

function bodyOf(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** 8710 的替身：token 换 cookie、401/403、JSON/二进制、响应头。 */
async function mockWeb() {
  const state = {
    handshakes: 0,
    validCookie: '',
    requests: [],
    force401: 0,
    force403: 0,
    delay401Ms: 0,
    tokenSeen: [],
  }
  const app = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push({ method: req.method, url: req.url, headers: req.headers })
    if (url.pathname === '/') {
      const token = url.searchParams.get('token')
      if (!token) { res.writeHead(401); return res.end('no') }
      state.tokenSeen.push(token)
      state.handshakes += 1
      state.validCookie = `dsh-auth-test=g${state.handshakes}`
      res.writeHead(303, {
        'set-cookie': `${state.validCookie}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        location: '/',
      })
      return res.end()
    }
    if (!req.headers.cookie || req.headers.cookie !== state.validCookie) {
      if (state.delay401Ms) await new Promise((r) => setTimeout(r, state.delay401Ms))
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }))
    }
    if (url.pathname === '/dsh-fish/state' && state.force401 > 0) {
      state.force401 -= 1
      if (state.delay401Ms) await new Promise((r) => setTimeout(r, state.delay401Ms))
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }))
    }
    if (url.pathname === '/dsh-bili/risk' && state.force403 > 0) {
      state.force403 -= 1
      res.writeHead(403, { 'content-type': 'application/json', 'set-cookie': 'nope=1', location: '/evil' })
      return res.end(JSON.stringify({ ok: false, code: 'RISK', why: '风控中' }))
    }
    if (url.pathname === '/dsh-bili/cover/BV1xx411c7mD') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': '4',
        'cache-control': 'max-age=60',
        'set-cookie': 'leak=1',
        location: '/somewhere',
      })
      return res.end(Buffer.from([1, 2, 3, 4]))
    }
    if (url.pathname === '/dsh-fish/log/export') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="fish.log"',
      })
      return res.end('line1\nline2\n')
    }
    if (url.pathname === '/dsh-fish/config' && req.method === 'POST') {
      const body = await bodyOf(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, size: body.length, type: req.headers['content-type'] }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: url.pathname, query: url.search }))
  })
  return { ...app, state }
}

async function mockEntry(webOrigin, { status = 302, token = 'secret-token-123' } = {}) {
  return listen((req, res) => {
    if (status === 503) { res.writeHead(503); return res.end('not ready') }
    res.writeHead(status, { location: `${webOrigin}/?token=${encodeURIComponent(token)}` })
    res.end()
  })
}

async function startBff(entryOrigin, webOrigin, phases = ['P0', 'P1', 'P2']) {
  const bff = createFishBff({ entryOrigin, webOrigin, phases, version: 'test' })
  const app = await listen((req, res) => bff.handle(req, res, new URL(req.url, 'http://x')))
  return { ...app, bff }
}

async function fixture(opts = {}) {
  const web = await mockWeb()
  const entry = await mockEntry(web.origin, opts.entry)
  const bff = await startBff(entry.origin, web.origin, opts.phases)
  return {
    web, entry, bff,
    async close() {
      await bff.close()
      await entry.close()
      await web.close()
    },
  }
}

test('GET /api/fish/status 走握手并过滤请求头', async () => {
  const f = await fixture()
  try {
    const r = await fetch(`${f.bff.origin}/api/fish/status`, {
      headers: {
        accept: 'application/json',
        origin: 'http://127.0.0.1:8788',
        referer: 'http://127.0.0.1:8788/',
        'sec-fetch-site': 'same-origin',
        cookie: 'client=should-not-leak',
      },
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, path: '/dsh-fish/status', query: '' })

    const up = f.web.state.requests.find((x) => x.url.startsWith('/dsh-fish/status'))
    assert.ok(up)
    assert.equal(up.headers.cookie, f.web.state.validCookie)
    assert.equal(up.headers.host, `127.0.0.1:${f.web.port}`)
    assert.equal(up.headers['user-agent'], 'fish-workbench/test')
    assert.equal(up.headers.accept, 'application/json')
    assert.equal(up.headers.origin, undefined)
    assert.equal(up.headers.referer, undefined)
    assert.equal(up.headers['sec-fetch-site'], undefined)
    assert.equal(up.headers.cookie.includes('client='), false)
  } finally { await f.close() }
})

test('上游 401 时单飞重认证一次并重放', async () => {
  const f = await fixture()
  try {
    // 先建立会话（g1）。
    assert.equal((await fetch(`${f.bff.origin}/api/fish/status`)).status, 200)
    assert.equal(f.web.state.handshakes, 1)

    // 模拟 cookie 过期：两条并发请求各拿一次 401，然后共享一次重认证。
    f.web.state.validCookie = 'dsh-auth-test=expired'
    f.web.state.delay401Ms = 80

    const [a, b] = await Promise.all([
      fetch(`${f.bff.origin}/api/fish/state`),
      fetch(`${f.bff.origin}/api/fish/state`),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    // 初始 1 次 + 过期后 1 次共享握手。
    assert.equal(f.web.state.handshakes, 2)
  } finally { await f.close() }
})

test('业务 403 重认证后仍 403 时原样透传，不误判认证失败', async () => {
  const f = await fixture()
  try {
    f.web.state.force403 = 2
    const r = await fetch(`${f.bff.origin}/api/fish/risk`)
    assert.equal(r.status, 403)
    const body = await r.json()
    assert.equal(body.code, 'RISK')
    assert.equal(body.why, '风控中')
    // 一进一出各一次，加一次重认证。
    assert.equal(f.web.state.handshakes, 2)
  } finally { await f.close() }
})

test('8711 未就绪返回 503 AUTH_UNAVAILABLE，且不泄露 token', async () => {
  const f = await fixture({ entry: { status: 503 } })
  try {
    const r = await fetch(`${f.bff.origin}/api/fish/status`)
    assert.equal(r.status, 503)
    const text = await r.text()
    assert.match(text, /AUTH_UNAVAILABLE/)
    assert.equal(text.includes('secret-token'), false)
  } finally { await f.close() }
})

test('8710 不可达返回 502 UPSTREAM_UNAVAILABLE', async () => {
  const dead = await listen(() => {})
  const deadOrigin = dead.origin
  await dead.close()
  const entry = await mockEntry(deadOrigin)
  const bff = await startBff(entry.origin, deadOrigin)
  try {
    const r = await fetch(`${bff.origin}/api/fish/status`)
    assert.equal(r.status, 502)
    assert.match(await r.text(), /UPSTREAM_UNAVAILABLE/)
  } finally {
    await bff.close()
    await entry.close()
  }
})

test('未登记路径 404，未登记方法 405', async () => {
  const f = await fixture()
  try {
    assert.equal((await fetch(`${f.bff.origin}/api/fish/nope`)).status, 404)
    assert.equal((await fetch(`${f.bff.origin}/api/fish/status`, { method: 'DELETE' })).status, 405)
  } finally { await f.close() }
})

test('当前阶段未开放的路径当作不存在', async () => {
  const web = await mockWeb()
  const entry = await mockEntry(web.origin)
  const bff = await startBff(entry.origin, web.origin, ['P0'])
  try {
    assert.equal((await fetch(`${bff.origin}/api/fish/config`)).status, 404)
    assert.equal((await fetch(`${bff.origin}/api/fish/status`)).status, 200)
  } finally {
    await bff.close()
    await entry.close()
    await web.close()
  }
})

test('P2 未开启时写方法 405，只读方法仍可用', async () => {
  const f = await fixture({ phases: ['P0', 'P1'] })
  try {
    const post = await fetch(`${f.bff.origin}/api/fish/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 405)
    assert.equal((await fetch(`${f.bff.origin}/api/fish/config`)).status, 200)
    // 只在 P2 出现的路由在 P1 当作不存在。
    const reset = await fetch(`${f.bff.origin}/api/fish/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(reset.status, 404)
  } finally { await f.close() }
})

test('请求体超限返回 413，不转发上游', async () => {
  const f = await fixture()
  try {
    const before = f.web.state.requests.length
    const r = await fetch(`${f.bff.origin}/api/fish/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(70 * 1024),
    })
    assert.equal(r.status, 413)
    assert.match(await r.text(), /BODY_TOO_LARGE/)
    assert.equal(f.web.state.requests.length, before)
  } finally { await f.close() }
})

test('写请求保留客户端 Content-Type / Accept，并透传上游错误', async () => {
  const f = await fixture()
  try {
    const r = await fetch(`${f.bff.origin}/api/fish/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.fish+json', accept: 'application/json' },
      body: '{"growthDays":30}',
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, size: 17, type: 'application/vnd.fish+json' })
    const up = f.web.state.requests.find((x) => x.url === '/dsh-fish/config')
    assert.equal(up.headers.accept, 'application/json')
  } finally { await f.close() }
})

test('二进制与下载透传类型、长度、缓存和文件名，剥离 Set-Cookie/Location', async () => {
  const f = await fixture()
  try {
    const cover = await fetch(`${f.bff.origin}/api/fish/cover/BV1xx411c7mD`)
    assert.equal(cover.status, 200)
    assert.equal(cover.headers.get('content-type'), 'image/png')
    assert.equal(cover.headers.get('content-length'), '4')
    assert.equal(cover.headers.get('cache-control'), 'max-age=60')
    assert.equal(cover.headers.get('set-cookie'), null)
    assert.equal(cover.headers.get('location'), null)
    assert.deepEqual([...new Uint8Array(await cover.arrayBuffer())], [1, 2, 3, 4])

    const log = await fetch(`${f.bff.origin}/api/fish/log/export`)
    assert.equal(log.status, 200)
    assert.match(log.headers.get('content-disposition'), /fish\.log/)
    assert.equal(await log.text(), 'line1\nline2\n')
  } finally { await f.close() }
})

test('query 原样带给上游', async () => {
  const f = await fixture()
  try {
    const r = await fetch(`${f.bff.origin}/api/fish/events?type=wake&limit=5`)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).query, '?type=wake&limit=5')
  } finally { await f.close() }
})

test('有副作用的 GET 拒绝跨站触发，且不发上游', async () => {
  const f = await fixture()
  try {
    const before = f.web.state.requests.length
    const r = await fetch(`${f.bff.origin}/api/fish/comment?waiting=1`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(r.status, 403)
    assert.match(await r.text(), /CROSS_SITE/)
    assert.equal(f.web.state.requests.length, before)
  } finally { await f.close() }
})
