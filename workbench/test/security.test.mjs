import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { hostAllowed, originAllowed, resolveStatic } from '../server.mjs'

const ROOT = resolve('/tmp/fish-workbench-root')

test('Host 必须是本机 8788 的精确 authority', () => {
  assert.equal(hostAllowed('127.0.0.1:8788', 8788), true)
  assert.equal(hostAllowed('localhost:8788', 8788), true)
  assert.equal(hostAllowed('127.0.0.1:8789', 8788), false)
  assert.equal(hostAllowed('127.0.0.1', 8788), false)
  assert.equal(hostAllowed('127.0.0.1:8788.evil.example', 8788), false)
  assert.equal(hostAllowed('evil.example:8788', 8788), false)
  assert.equal(hostAllowed(undefined, 8788), false)
})

test('写请求 Origin 为空或同源，其他一律拒绝', () => {
  assert.equal(originAllowed(undefined, 8788), true)
  assert.equal(originAllowed('http://127.0.0.1:8788', 8788), true)
  assert.equal(originAllowed('http://localhost:8788', 8788), true)
  assert.equal(originAllowed('http://127.0.0.1:8788.evil', 8788), false)
  assert.equal(originAllowed('https://127.0.0.1:8788', 8788), false)
  assert.equal(originAllowed('http://evil.example', 8788), false)
})

test('静态文件不允许穿越、编码斜杠、反斜杠和绝对路径', () => {
  assert.equal(resolveStatic('/', ROOT), resolve(ROOT, 'index.html'))
  assert.equal(resolveStatic('/index.html', ROOT), resolve(ROOT, 'index.html'))
  assert.equal(resolveStatic('/assets/app.js', ROOT), resolve(ROOT, 'assets/app.js'))

  for (const bad of [
    '/server.mjs',
    '/etc/passwd',
    '/assets/../server.mjs',
    '/assets/%2e%2e/server.mjs',
    '/assets/..%2fserver.mjs',
    '/assets/..%5cserver.mjs',
    '/assets/app.js%00',
    '/assets/sub/../../server.mjs',
    '/assets/\\server.mjs',
  ]) {
    assert.equal(resolveStatic(bad, ROOT), null, bad)
  }
})

test('静态解析结果始终留在 root 内', () => {
  for (const p of ['/', '/index.html', '/assets/app.js', '/assets/nested/x.svg']) {
    const got = resolveStatic(p, ROOT)
    if (got) assert.equal(got.startsWith(ROOT), true, p)
  }
})
