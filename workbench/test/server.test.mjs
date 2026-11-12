import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'fish-workbench-'))
const home = join(tmp, 'home')
const data = join(tmp, 'data')

let web
let entry
let workbench
let port

async function listen(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` }
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

before(async () => {
  web = await listen((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-test=local; Path=/; HttpOnly' })
      return res.end()
    }
    if (url.pathname === '/dsh-fish/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, phase: 'awake-idle', label: '在吃大白饭', today: { wakes: 1 } }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
  })
  entry = await listen((req, res) => {
    res.writeHead(302, { location: `${web.origin}/?token=local-token` })
    res.end()
  })

  process.env.WORKBENCH_PORT = '0'
  process.env.WORKBENCH_HOME = home
  process.env.WORKBENCH_DATA = data
  process.env.WORKBENCH_DISABLE_WATCH = '1'
  process.env.FISH_ENTRY_ORIGIN = entry.origin
  process.env.FISH_WEB_ORIGIN = web.origin

  const mod = await import('../server.mjs')
  workbench = mod.server
  await mod.start(0)
  port = workbench.address().port
})

after(async () => {
  if (workbench) await close(workbench)
  if (entry) await close(entry.server)
  if (web) await close(web.server)
  rmSync(tmp, { recursive: true, force: true })
})

function rawRequest(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('首页带 CSP / nosniff，并加载外部脚本', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /<nav class="tabs"/)
  assert.match(html, /\/assets\/app\.js/)
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
})

test('静态资源只从 assets/ 提供', async () => {
  const js = await fetch(`http://127.0.0.1:${port}/assets/app.js`)
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type'), /text\/javascript/)
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff')

  assert.equal((await fetch(`http://127.0.0.1:${port}/server.mjs`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/%2e%2e/server.mjs`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/..%2fserver.mjs`)).status, 404)
})

test('GET /api/fish/status 经 BFF 返回上游状态', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/fish/status`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.label, '在吃大白饭')
  assert.equal(body.today.wakes, 1)
})

test('未登记路径 404，未开放阶段 404', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/fish/nope`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/fish/config`)).status, 404)
})

test('运行数据落在 WORKBENCH_DATA，启动时创建 frames/', async () => {
  assert.equal(statSync(join(data, 'frames')).isDirectory(), true)
  const r = await fetch(`http://127.0.0.1:${port}/api/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, pollSeconds: 30, nagMinutes: 0, notifyRecover: false }),
  })
  assert.equal(r.status, 200)
  const saved = await r.json()
  assert.deepEqual(saved.settings, { enabled: true, pollSeconds: 30, nagMinutes: 0, notifyRecover: false })
  const onDisk = JSON.parse(readFileSync(join(data, 'watch.json'), 'utf8'))
  assert.deepEqual(onDisk, saved.settings)
})

test('伪造 Host 一律 403（DNS rebinding）', async () => {
  const r = await rawRequest('/api/fish/status', { headers: { host: 'evil.example' } })
  assert.equal(r.status, 403)
  const ok = await rawRequest('/api/fish/status', { headers: { host: `127.0.0.1:${port}` } })
  assert.equal(ok.status, 200)
})

test('跨站写请求 403，同源写请求可用', async () => {
  const cross = await fetch(`http://127.0.0.1:${port}/api/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: '{}',
  })
  assert.equal(cross.status, 403)

  const same = await fetch(`http://127.0.0.1:${port}/api/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    body: '{}',
  })
  assert.equal(same.status, 200)
})
