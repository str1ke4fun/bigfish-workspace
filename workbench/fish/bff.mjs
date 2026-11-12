// 8788 工作台 → 8710 插件的 BFF。
//
// 这里只有三件事：
//   1. 从 8711 现取一次性 token，到 8710 换 30 天 cookie，缓存进进程内存；
//   2. 按 routes.mjs 的白名单转发，请求头只发白名单里的字段；
//   3. 401/403 时单飞重认证一次并重放，业务 403 原样透传。
//
// 不碰 ~/.dsh-fish，不做业务缓存，不把 token/cookie 写进日志或错误体。
import { Readable } from 'node:stream'
import {
  ROUTES, DEFAULT_MAX_BODY, DEFAULT_TIMEOUT_MS,
  matchRoute, methodEnabled, enabledMethods, upstreamPath,
} from './routes.mjs'

const PASSTHROUGH_HEADERS = [
  'content-type', 'content-length', 'cache-control',
  'content-disposition', 'etag', 'last-modified',
]

export class BffError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

function setCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? [raw] : []
}

function cookiePairs(headers) {
  return setCookies(headers)
    .map((line) => String(line).split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

function writeJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(buf)
}

/**
 * 读请求体并执行上限。超限时不再累积，但要把流排干，否则响应发不出去。
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(new BffError(413, 'BODY_TOO_LARGE'))
      return
    }
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) reject(new BffError(413, 'BODY_TOO_LARGE'))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => reject(err))
  })
}

export function createFishBff(options = {}) {
  const entryOrigin = String(options.entryOrigin || process.env.FISH_ENTRY_ORIGIN || 'http://127.0.0.1:8711').replace(/\/+$/, '')
  const webOrigin = String(options.webOrigin || process.env.FISH_WEB_ORIGIN || 'http://127.0.0.1:8710').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const phases = options.phases || ['P0']
  const version = options.version || process.env.WORKBENCH_VERSION || '0.1.0'
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000

  let session = null // { cookie, at }
  let inflight = null

  async function handshakeOnce() {
    if (inflight) return inflight
    inflight = (async () => {
      let entry
      try {
        entry = await fetchImpl(`${entryOrigin}/`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(handshakeTimeoutMs),
        })
      } catch {
        throw new BffError(503, 'AUTH_UNAVAILABLE')
      }
      if (entry.status === 503) throw new BffError(503, 'AUTH_UNAVAILABLE')

      const location = entry.headers.get('location')
      let token = ''
      if (location) {
        try { token = new URL(location, entryOrigin).searchParams.get('token') || '' } catch { token = '' }
      }
      if (!token) throw new BffError(503, 'AUTH_UNAVAILABLE')

      let exchanged
      try {
        exchanged = await fetchImpl(`${webOrigin}/?token=${encodeURIComponent(token)}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(handshakeTimeoutMs),
        })
      } catch {
        throw new BffError(502, 'UPSTREAM_UNAVAILABLE')
      }
      if (exchanged.status === 401) throw new BffError(401, 'AUTH_FAILED')
      if (exchanged.status >= 500) throw new BffError(502, 'UPSTREAM_UNAVAILABLE')

      const cookie = cookiePairs(exchanged.headers)
      if (!cookie) throw new BffError(401, 'AUTH_FAILED')
      session = { cookie, at: Date.now() }
      return session
    })().finally(() => { inflight = null })
    return inflight
  }

  async function cookieFor() {
    if (session) return session.cookie
    const s = await handshakeOnce()
    return s.cookie
  }

  async function reauth(seenCookie) {
    // 有人已经在我们拿到 401 之后换过 cookie：直接用新的，避免连环握手
    // 把前一个重放请求的 cookie 又作废。
    if (session && session.cookie !== seenCookie) return session.cookie
    session = null
    const s = await handshakeOnce()
    return s.cookie
  }

  async function callUpstream(route, suffix, search, method, body, cookie, accept, contentType) {
    // 只发白名单字段。浏览器的 Origin / Referer / Sec-Fetch-* / Cookie / Host
    // 一律不进来；Host 由 fetch 按 webOrigin 写成 127.0.0.1:8710。
    const headers = new Headers()
    headers.set('cookie', cookie)
    headers.set('accept', accept || '*/*')
    headers.set('user-agent', `fish-workbench/${version}`)
    if (body.length > 0) headers.set('content-type', contentType || 'application/json')
    const init = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(route.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }
    if (body.length > 0) init.body = body
    try {
      return await fetchImpl(`${webOrigin}${upstreamPath(route, suffix, search)}`, init)
    } catch {
      throw new BffError(502, 'UPSTREAM_UNAVAILABLE')
    }
  }

  async function pipeUpstream(res, upstream) {
    const headers = { 'x-content-type-options': 'nosniff' }
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) headers[name] = value
    }
    res.writeHead(upstream.status, headers)
    if (!upstream.body) return res.end()
    try {
      await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(upstream.body)
        stream.on('error', reject)
        res.on('error', reject)
        res.on('close', resolve)
        stream.pipe(res)
        stream.on('end', resolve)
      })
    } catch {
      // 响应已经开始，无法改成错误页；断掉即可，调用方会看到不完整响应。
      res.destroy()
    }
  }

  async function handle(req, res, url) {
    const prefix = '/api/fish/'
    if (!url.pathname.startsWith(prefix)) {
      writeJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    const rest = url.pathname.slice(prefix.length)
    const matched = matchRoute(rest)
    if (!matched) {
      writeJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    const { route, suffix } = matched
    const allowed = enabledMethods(route, phases)
    if (!allowed.length) {
      // 当前阶段还没开放：当作不存在，避免暴露未实现的路由。
      writeJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    if (!methodEnabled(route, req.method, phases)) {
      writeJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
      return
    }

    const method = req.method
    const isWrite = method !== 'GET' && method !== 'HEAD'
    if (!isWrite && route.sideEffect) {
      const site = String(req.headers['sec-fetch-site'] || '')
      if (site === 'cross-site') {
        writeJson(res, 403, { ok: false, error: 'CROSS_SITE' })
        return
      }
    }

    let body = Buffer.alloc(0)
    if (isWrite) {
      try {
        body = await readBody(req, route.maxBody ?? DEFAULT_MAX_BODY)
      } catch (err) {
        const status = err instanceof BffError ? err.status : 400
        const code = err instanceof BffError ? err.code : 'BAD_REQUEST'
        writeJson(res, status, { ok: false, error: code })
        return
      }
    }

    try {
      const accept = String(req.headers.accept || '*/*')
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      let cookie = await cookieFor()
      let upstream = await callUpstream(route, suffix, url.search, method, body, cookie, accept, contentType)

      if (upstream.status === 401 || upstream.status === 403) {
        try { await upstream.body?.cancel?.() } catch { /* 已经读完了 */ }
        cookie = await reauth(cookie)
        upstream = await callUpstream(route, suffix, url.search, method, body, cookie, accept, contentType)
        if (upstream.status === 401) {
          try { await upstream.body?.cancel?.() } catch { /* 同上 */ }
          writeJson(res, 401, { ok: false, error: 'AUTH_FAILED' })
          return
        }
      }

      await pipeUpstream(res, upstream)
    } catch (err) {
      if (err instanceof BffError) {
        writeJson(res, err.status, { ok: false, error: err.code })
        return
      }
      writeJson(res, 502, { ok: false, error: 'UPSTREAM_UNAVAILABLE' })
    }
  }

  return {
    handle,
    // 便于测试与后续阶段检查，不对外暴露。
    _routes: ROUTES,
    _state: () => ({ hasSession: Boolean(session), cookieAt: session?.at ?? null }),
  }
}
