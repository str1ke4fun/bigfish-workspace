const PREFIX = 'WXTOOL|'
const VALID_CODE = /^[A-Z0-9_]+$/
const RAW_PREFIX = 'r1.'

function assertCode(code) {
  if (typeof code !== 'string' || !VALID_CODE.test(code)) {
    throw new TypeError('WxToolError code must match A-Z0-9_')
  }
}

export class WxToolError extends Error {
  constructor(code, modelText, rawDetail = '') {
    assertCode(code)
    if (typeof modelText !== 'string') throw new TypeError('WxToolError modelText must be a string')
    const detail = String(rawDetail ?? '')
    super(`${PREFIX}${code}|${RAW_PREFIX}${Buffer.from(detail, 'utf8').toString('base64url')}|${modelText}`)
    this.name = 'WxToolError'
    this.code = code
    this.rawDetail = detail
  }
}

function decodeRawDetail(segment) {
  if (typeof segment !== 'string' || !segment.startsWith(RAW_PREFIX)) return null
  const encoded = segment.slice(RAW_PREFIX.length)
  try {
    const text = Buffer.from(encoded, 'base64url').toString('utf8')
    return Buffer.from(text, 'utf8').toString('base64url') === encoded ? text : null
  } catch {
    return null
  }
}

export function parseWxToolError(message) {
  const text = typeof message === 'string' ? message : ''
  if (!text.startsWith(PREFIX)) return null
  const first = text.indexOf('|', PREFIX.length)
  if (first < 0) return null
  const code = text.slice(PREFIX.length, first)
  if (!VALID_CODE.test(code)) return null
  const remainder = text.slice(first + 1)
  const second = remainder.indexOf('|')
  if (second >= 0) {
    const rawDetail = decodeRawDetail(remainder.slice(0, second))
    if (rawDetail !== null) {
      return {
        code,
        modelText: remainder.slice(second + 1),
        rawDetail,
      }
    }
  }
  return {
    code,
    modelText: remainder,
    rawDetail: '',
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
