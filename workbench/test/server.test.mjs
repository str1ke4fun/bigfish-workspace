import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, statSync, rmSync, symlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'fish-workbench-'))
const home = join(tmp, 'home')
const data = join(tmp, 'data')

let web
let entry
let workbench
let port
let upstreamWrites = 0

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
  web = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-test=local; Path=/; HttpOnly' })
      return res.end()
    }
    if (url.pathname === '/dsh-fish/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, phase: 'awake-idle', label: '在吃大白饭', today: { wakes: 1 } }))
    }
    if (url.pathname === '/dsh-fish/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, config: { growthDays: 7 } }))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
      upstreamWrites += 1
      let body = null
      try { body = JSON.parse(text) } catch { body = text.slice(0, 40) }
      if (body && body.fail === true) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'UPSTREAM_BOOM' }))
      }
      if (body && body.businessFalse === true) {
        // 上游的「业务拒绝」是 200 + ok:false；BFF 不该把它改写成 HTTP 错误。
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, code: 'NOPE', why: '上游业务拒绝' }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, path: url.pathname, body }))
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

test('通过符号链接启动也算入口（systemd 的 /opt/fish/workbench 用法）', async () => {
  const dir = mkdtempSync(join(tmp, 'link-'))
  const link = join(dir, 'server.mjs')
  symlinkSync(new URL('../server.mjs', import.meta.url), link)
  const child = spawn(process.execPath, [link], {
    env: {
      ...process.env,
      WORKBENCH_PORT: '0',
      WORKBENCH_HOME: home,
      WORKBENCH_DATA: join(dir, 'data'),
      WORKBENCH_DISABLE_WATCH: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const started = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000)
    child.stdout.on('data', (c) => {
      out += c
      if (out.includes('工作台: http')) { clearTimeout(t); resolve(true) }
    })
    child.stderr.on('data', (c) => { out += c })
    child.on('exit', () => { clearTimeout(t); resolve(false) })
  })
  child.kill()
  assert.equal(started, true, `符号链接启动没有监听：${out}`)
})

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

test('未登记路径 404；P1 只放只读方法，写方法 405', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/fish/nope`)).status, 404)
  const post = await fetch(`http://127.0.0.1:${port}/api/fish/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(post.status, 405)
})

test('P1 放行只读 GET：config 能穿过阶段门控到达上游', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/fish/config`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.config.growthDays, 7)
})

test('有副作用的 GET 拒绝跨站触发', async () => {
  for (const path of [
    '/api/fish/comment',
    '/api/fish/comment-body?bvid=BV1xx411c7mD&rpid=1',
    '/api/fish/selfcheck?net=1',
    '/api/fish/inbox',
    '/api/fish/paths',
    '/api/fish/sheet/BV1xx411c7mD',
    '/api/fish/update?ms=6000',
  ]) {
    const cross = await rawRequest(path, {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example', accept: 'application/json' },
    })
    assert.equal(cross.status, 403, path)
  }
})

test('/api/status.log 只读最近动作，不触发检查', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/status.log`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.ok(Array.isArray(body.rows))
  assert.ok(body.rows.length <= 20)
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

test('P2 写请求经 BFF 到达上游，确认字面量原样传递', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/fish/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'reset' }),
  })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.path, '/dsh-fish/reset')
  assert.deepEqual(body.body, { confirm: 'reset' })
})

test('P2 写请求拒绝跨站，且不发上游', async () => {
  const before = upstreamWrites
  const cross = await rawRequest('/api/fish/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: '{}',
  })
  assert.equal(cross.status, 403)
  assert.equal(upstreamWrites, before)
})

test('P2 方法白名单：未登记方法 405', async () => {
  const cases = [
    ['say', 'DELETE'], ['decide', 'PUT'], ['reset', 'GET'],
    ['notify', 'PUT'], ['inbox', 'PUT'], ['wake', 'GET'], ['owner', 'DELETE'],
    ['log/clear', 'GET'], ['backup/restore', 'GET'], ['risk', 'DELETE'], ['wx/scan', 'GET'],
  ]
  for (const [path, method] of cases) {
    const r = await fetch(`http://127.0.0.1:${port}/api/fish/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    })
    assert.equal(r.status, 405, `${method} ${path}`)
  }
})

test('P2 上游 200 + business ok:false 原样透传，不改成 HTTP 错误', async () => {
  for (const path of ['notify', 'inbox', 'decide', 'wake', 'owner', 'log/clear', 'risk', 'wx/scan']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/fish/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessFalse: true }),
    })
    assert.equal(r.status, 200, path)
    const body = await r.json()
    assert.equal(body.ok, false, path)
    assert.equal(body.why, '上游业务拒绝', path)
  }
})

test('P2 body 上限按路由生效', async () => {
  // /say 的上限是 12MB：300KB 能过，说明没有退回默认 256KB。
  const say = await fetch(`http://127.0.0.1:${port}/api/fish/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  })
  assert.equal(say.status, 200)

  // /import 收在 200_000 字节（上游 readBody 的上限）：190KB 能过，超一点就 413，
  // 不让上游先 destroy 连接、把超长交接单变成 502。
  const ok190 = await fetch(`http://127.0.0.1:${port}/api/fish/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(190 * 1024) }),
  })
  assert.equal(ok190.status, 200)

  const before = upstreamWrites
  const big = await fetch(`http://127.0.0.1:${port}/api/fish/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(196 * 1024) }),
  })
  assert.equal(big.status, 413)
  assert.match(await big.text(), /BODY_TOO_LARGE/)
  assert.equal(upstreamWrites, before)

  // /avatar 上限 4MB。
  const avatar = await fetch(`http://127.0.0.1:${port}/api/fish/avatar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'x'.repeat(4_100_000) }),
  })
  assert.equal(avatar.status, 413)
})

test('P2 上游错误原样透传', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/fish/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail: true }),
  })
  assert.equal(r.status, 500)
  assert.equal((await r.json()).error, 'UPSTREAM_BOOM')
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
