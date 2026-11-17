const PREFIX = 'WXTOOL|'
const VALID_CODE = /^[A-Z0-9_]+$/

function assertCode(code) {
  if (typeof code !== 'string' || !VALID_CODE.test(code)) {
    throw new TypeError('WxToolError code must match A-Z0-9_')
  }
}

export class WxToolError extends Error {
  constructor(code, modelText) {
    assertCode(code)
    if (typeof modelText !== 'string') throw new TypeError('WxToolError modelText must be a string')
    super(`${PREFIX}${code}|${modelText}`)
    this.name = 'WxToolError'
    this.code = code
  }
}

export function parseWxToolError(message) {
  const text = typeof message === 'string' ? message : ''
  if (!text.startsWith(PREFIX)) return null
  const first = text.indexOf('|', PREFIX.length)
  if (first < 0) return null
  const code = text.slice(PREFIX.length, first)
  if (!VALID_CODE.test(code)) return null
  return {
    code,
    modelText: text.slice(first + 1),
  }
}

function asWarn(log) {
  if (typeof log === 'function') return log
  if (typeof log?.warn === 'function') return (...args) => log.warn(...args)
  return undefined
}

export function registerWxToolErrorAdapter(ctx, { log } = {}) {
  if (typeof ctx?.on !== 'function') return () => {}
  const warn = asWarn(log)

  const listener = (exec, result, next) => {
    let decision
    try {
      if (result?.isError !== true || !String(exec?.name ?? '').startsWith('wx_')) {
        decision = null
      } else {
        const message = result?.error?.message ?? result?.error
        const parsed = parseWxToolError(message)
        decision = parsed
          ? { kind: 'accept', content: [{ type: 'text', text: parsed.modelText }] }
          : null
      }
    } catch (err) {
      try { warn?.(`[dsh-wx] 工具错误投影失败，保留原结果：${String(err?.message ?? err).slice(0, 160)}`) } catch { /* ignore */ }
      decision = null
    }
    if (decision) return decision
    return typeof next === 'function' ? next() : undefined
  }

  try {
    const off = ctx.on('tools/post-execute', listener)
    return typeof off === 'function' ? off : () => {}
  } catch (err) {
    try { warn?.(`[dsh-wx] 工具错误投影监听没挂上：${String(err?.message ?? err).slice(0, 160)}`) } catch { /* ignore */ }
    return () => {}
  }
}
