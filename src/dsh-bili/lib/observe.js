/**
 * observe.js —— `/dsh-bili/*` 只读路由（设计 §6 A2）
 *
 * core 的 `/dsh-fish/*` 同名路由在 A2 之后只做代理，真正的实现是这里与服务层。
 * 路由全部 fail-closed：拿不到 connection 服务就 503，不放行。
 *
 * 前缀由 apply() 传入，默认 `/dsh-bili`；工作台 BFF 按这条前缀转发。
 */
const DEFAULT_PREFIX = '/dsh-bili'

function safeGet(ctx, key) {
  try { return ctx.get?.(key) ?? ctx[key] } catch { return null }
}

function send(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(b)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function media(res, buf, contentType, cacheControl = 'private, max-age=86400') {
  if (res.writableEnded) return
  res.writeHead(200, { 'content-type': contentType, 'content-length': buf.length, 'cache-control': cacheControl })
  res.end(buf)
}

/**
 * @param {object} ctx
 * @param {{ prefix?: string, service: object, log?: Function }} opts
 */
export function registerBiliObserve(ctx, { prefix = DEFAULT_PREFIX, service, log } = {}) {
  const disposers = []

  function guarded(handler) {
    return async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (!conn) return send(res, 503, { error: 'connection service unavailable' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      } catch {
        return send(res, 503, { error: 'trust check failed' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        log?.(`/dsh-bili 路由出错：${String(err?.message ?? err).slice(0, 160)}`)
        send(res, err?.statusCode ?? 500, { error: String(err?.message ?? err).slice(0, 240) })
      }
    }
  }

  const routes = [
    ['/status', async (req, res) => send(res, 200, await service.status())],
    ['/browse', async (req, res) => send(res, 200, await service.browse())],
    ['/history', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      send(res, 200, await service.history({ days: url.searchParams.get('days') }))
    }],
    ['/footprint', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      send(res, 200, await service.footprint({
        days: url.searchParams.get('days'),
        limit: url.searchParams.get('limit'),
      }))
    }],
    ['/comment-body', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const r = await service.commentBody({
        bvid: url.searchParams.get('bvid'),
        rpid: url.searchParams.get('rpid'),
      })
      if (!r.ok) return send(res, r.status ?? 500, { error: r.error })
      send(res, 200, { ok: true, ...r.data })
    }],
    ['/comment', async (req, res) => send(res, 200, await service.commentStatus())],
    ['/risk', async (req, res) => {
      if (req.method === 'POST') {
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { body = {} }
        return send(res, 200, await service.risk({ clear: Boolean(body?.clear) }))
      }
      send(res, 200, await service.risk())
    }],
    ['/outings', async (req, res) => send(res, 200, await service.outings())],
    ['/ledger', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      send(res, 200, await service.ledger({
        date: String(url.searchParams.get('date') ?? ''),
        session: String(url.searchParams.get('session') ?? ''),
        tool: String(url.searchParams.get('tool') ?? ''),
        limit: url.searchParams.get('limit'),
      }))
    }],
    ['/material', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10))
      send(res, 200, await service.recentMaterial(limit))
    }],
    ['/cover', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-bili\/cover\/(BV[0-9A-Za-z]{10})/)
      if (!m) return send(res, 404, { error: 'no cover' })
      const r = await service.cover(m[1])
      if (!r) return send(res, 404, { error: 'no cover' })
      media(res, r.buf, r.contentType)
    }],
    ['/sheet', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-bili\/sheet\/(BV[0-9A-Za-z]{10})/)
      if (!m) return send(res, 404, { error: 'no sheet' })
      const r = await service.sheet(m[1])
      if (!r) return send(res, 404, { error: 'no sheet' })
      media(res, r.buf, r.contentType, 'private, max-age=600')
    }],
  ]

  const webServer = safeGet(ctx, 'webServer')
  if (!webServer?.register) {
    // 宿主没有 webServer（测试里的假 ctx 常见）：路由不注册，服务仍可 provide。
    return { dispose() {} }
  }

  for (const [p, h] of routes) {
    try {
      const d = webServer.register({ kind: 'prefix', path: prefix + p, handler: guarded(h) })
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (err) {
      log?.(`路由注册失败 ${p}：${String(err?.message ?? err).slice(0, 120)}`)
    }
  }

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
