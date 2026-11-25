/**
 * mcp-stdio.js —— 最小 MCP stdio 客户端
 *
 * 只做我们需要的四件事：initialize / tools/list / tools/call / 服务器请求应答。
 * 不引入 MCP SDK，保持 dsh-fish 零依赖。协议是 newline-delimited JSON-RPC 2.0。
 *
 * 边界：
 *   - 请求按 id 配对；超时/子进程退出会拒绝所有 pending；
 *   - stdout 按行切；单行超过 maxLineBytes 视为协议错误；
 *   - 服务器请求只应答 ping / resources/list / prompts/list / roots/list，其它 -32601；
 *   - dispose 先关 stdin（驱动在 stdin EOF 时自行退出），再 kill 兜底。
 */

import { spawn as nodeSpawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'

export function createMcpStdioClient({
  command,
  args = [],
  cwd,
  env = {},
  spawn = nodeSpawn,
  requestTimeoutMs = 30_000,
  maxLineBytes = 32 * 1024 * 1024,
  onExit = () => {},
  log = () => {},
} = {}) {
  let closed = false
  let exited = false
  let nextId = 1
  let buffer = ''
  const pending = new Map()

  let child
  try {
    child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    closed = true
    throw err
  }

  function failAll(error) {
    if (closed) return
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function failProtocol(message) {
    const err = Object.assign(new Error(message), { code: 'MCP_PROTOCOL' })
    failAll(err)
    try { child.stdin?.end?.() } catch { /* ignore */ }
    try { child.kill?.('SIGTERM') } catch { /* ignore */ }
  }

  function write(message) {
    if (closed) throw Object.assign(new Error('MCP client is closed'), { code: 'MCP_CLOSED' })
    const line = `${JSON.stringify(message)}\n`
    try {
      child.stdin?.write?.(line)
    } catch (err) {
      failAll(err)
      throw err
    }
  }

  function dispatch(message) {
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const err = Object.assign(new Error(message.error.message || 'MCP error'), {
          code: message.error.code,
          data: message.error.data,
        })
        entry.reject(err)
      } else {
        entry.resolve(message.result)
      }
      return
    }
    // 服务器 -> 客户端请求：最小应答，避免驱动阻塞。
    if (typeof message.method === 'string' && message.id !== undefined) {
      const reply = { jsonrpc: '2.0', id: message.id }
      switch (message.method) {
        case 'ping': reply.result = {}; break
        case 'resources/list': reply.result = { resources: [] }; break
        case 'prompts/list': reply.result = { prompts: [] }; break
        case 'roots/list': reply.result = { roots: [] }; break
        default: reply.error = { code: -32601, message: 'method not found' }
      }
      try { write(reply) } catch { /* ignore */ }
    }
  }

  function onData(chunk) {
    if (closed) return
    buffer += String(chunk)
    if (buffer.length > maxLineBytes) {
      failProtocol(`MCP line too large (> ${maxLineBytes})`)
      return
    }
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch {
        log(`[mcp-stdio] 跳过非 JSON 行：${line.slice(0, 120)}`)
        continue
      }
      dispatch(message)
    }
  }

  child.stdout?.setEncoding?.('utf8')
  child.stderr?.setEncoding?.('utf8')
  child.stdout?.on?.('data', onData)
  child.stderr?.on?.('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) log(`[mcp-stdio] stderr: ${text.slice(0, 300)}`)
  })
  child.on?.('error', (err) => {
    if (exited) return
    exited = true
    failAll(err)
    try { onExit?.(err) } catch { /* ignore */ }
  })
  child.on?.('exit', (code, signal) => {
    if (exited) return
    exited = true
    const err = Object.assign(new Error(`MCP child exited (code=${code}, signal=${signal})`), { code: 'MCP_EXITED' })
    failAll(err)
    try { onExit?.(err) } catch { /* ignore */ }
  })

  function request(method, params, timeoutMs = requestTimeoutMs) {
    if (closed) return Promise.reject(Object.assign(new Error('MCP client is closed'), { code: 'MCP_CLOSED' }))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error(`MCP timeout after ${timeoutMs}ms: ${method}`), { code: 'MCP_TIMEOUT' }))
      }, Math.max(1, Number(timeoutMs) || requestTimeoutMs))
      if (typeof timer?.unref === 'function') timer.unref()
      pending.set(id, { resolve, reject, timer })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  function notify(method, params) {
    write({ jsonrpc: '2.0', method, params })
  }

  async function initialize({ clientInfo = { name: 'dsh-fish-host-cua', version: '' } } = {}) {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    }, 30_000)
    notify('notifications/initialized')
    return result
  }

  async function listTools() {
    const result = await request('tools/list', {}, 30_000)
    return Array.isArray(result?.tools) ? result.tools : []
  }

  function callTool(name, args = {}, { timeoutMs = requestTimeoutMs } = {}) {
    return request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, timeoutMs)
  }

  function dispose() {
    if (closed) {
      try { child.stdin?.end?.() } catch { /* ignore */ }
      try { child.kill?.('SIGTERM') } catch { /* ignore */ }
      return
    }
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error('MCP client disposed'), { code: 'MCP_DISPOSED' }))
    }
    pending.clear()
    try { child.stdin?.end?.() } catch { /* ignore */ }
    try { child.kill?.('SIGTERM') } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { child.kill?.('SIGKILL') } catch { /* ignore */ }
    }, 2000)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    initialize,
    listTools,
    callTool,
    dispose,
    get closed() { return closed },
    get pid() { return Number(child?.pid) || 0 },
  }
}
