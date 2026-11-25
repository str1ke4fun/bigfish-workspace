import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMcpStdioClient } from '../lib/mcp-stdio.js'

function fakeSpawn() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  child.writes = []
  child.stdin = {
    write: (s) => child.writes.push(JSON.parse(String(s).trim())),
    end: () => { child.stdinEnded = true },
  }
  child.kill = (sig) => { child.killed = sig }
  return { child, spawn: () => child }
}

test('initialize 后发 initialized 通知', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.initialize({ clientInfo: { name: 't', version: '0' } })
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'cua' } } }) + '\n')
  assert.equal((await p).serverInfo.name, 'cua')
  assert.equal(child.writes.at(-1).method, 'notifications/initialized')
})

test('callTool 按 id 配对，支持分片与多行', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.callTool('list_windows', {}, { timeoutMs: 1000 })
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\n'
  child.stdout.emit('data', line.slice(0, 10))
  child.stdout.emit('data', line.slice(10))
  const r = await p
  assert.equal(r.content[0].text, 'ok')
})

test('服务器请求 ping 被应答，未知方法回 -32601', async () => {
  const { child, spawn } = fakeSpawn()
  createMcpStdioClient({ command: 'x', spawn })
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n')
  assert.deepEqual(child.writes.at(-1), { jsonrpc: '2.0', id: 99, result: {} })
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'nope' }) + '\n')
  assert.equal(child.writes.at(-1).error.code, -32601)
})

test('子进程退出会拒绝 pending 并关闭', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.callTool('x', {}, { timeoutMs: 5000 })
  child.emit('exit', 1, null)
  await assert.rejects(p, /exited/)
  assert.equal(c.closed, true)
})

test('超时会拒绝', async () => {
  const { spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  await assert.rejects(c.callTool('x', {}, { timeoutMs: 10 }), /timeout/)
})

test('dispose 关闭 stdin 并 kill', () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  c.dispose()
  assert.equal(c.closed, true)
  assert.equal(child.stdinEnded, true)
  assert.equal(child.killed, 'SIGTERM')
})
