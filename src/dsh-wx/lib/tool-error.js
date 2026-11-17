import { wrapTool } from '../../dsh-fish/lib/tool-result.js'

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
    this.modelText = modelText
    this.rawDetail = detail
  }
}

/** 微信工具的可审计预期失败。message 给模型，detail 只给台账。 */
export function wxFailure(code, message, detail = '') {
  assertCode(code)
  if (typeof message !== 'string') throw new TypeError('wxFailure message must be a string')
  const out = { ok: false, code, message }
  const raw = String(detail ?? '')
  if (raw) out.detail = raw
  return out
}

/** 只转换显式预期错误；普通异常继续抛给宿主。 */
export function wxFailureFrom(error) {
  if (!(error instanceof WxToolError)) return null
  return wxFailure(error.code, error.modelText, error.rawDetail)
}

function normalizeFailure(result) {
  const code = String(result?.code ?? '')
  const message = String(result?.message ?? '')
  assertCode(code)
  if (typeof result?.message !== 'string') throw new TypeError('wx failure message must be a string')
  const detail = String(result?.detail ?? '')
  const out = { ...result, ok: false, code, message }
  if (detail) out.detail = detail
  else delete out.detail
  return out
}

function envelopeExecute(execute) {
  return async (...args) => {
    try {
      const result = await execute(...args)
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('wx tool must return an object envelope')
      }
      if (result.ok === false) return normalizeFailure(result)
      if (result.ok !== true) throw new TypeError('wx tool envelope must contain boolean ok')
      return result
    } catch (error) {
      const failure = wxFailureFrom(error)
      if (failure) return failure
      throw error
    }
  }
}

/** 成功结果补上模型文本；ok:false 原样交回，不再执行成功投影。 */
export function wxWithText(result, textOf) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('wx tool result must be an object envelope')
  }
  if (result.ok === false) return normalizeFailure(result)
  if (result.ok !== true) throw new TypeError('wx tool result must contain boolean ok')
  const text = textOf(result)
  return { ...result, text: String(text ?? '') }
}

export function wxOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      code: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['ok'],
    additionalProperties: true,
  }
}

function defaultProject(result) {
  if (result?.ok === false) return { text: String(result.message ?? '') }
  return { text: String(result?.text ?? '') }
}

/**
 * 微信全部工具的唯一注册入口：
 *   - envelopes=true：所有工具返回对象信封，预期错误由 WxToolError 转 ok:false；
 *   - envelopes=false：回滚为旧字符串执行，并把 ok:false 重新抛成 WxToolError。
 * 两者都只接管 WxToolError；普通异常保持错误路径，由 wrapTool 或宿主如实上报。
 */
export function wrapWxTool(def, { envelopes = true, core } = {}) {
  const base = def ?? {}
  const execute = envelopeExecute(base.execute)
  if (envelopes) {
    return wrapTool({
      ...base,
      output: { ...(base.output ?? {}), schema: wxOutputSchema() },
      project: typeof base.project === 'function' ? base.project : defaultProject,
      execute,
    }, { core })
  }

  return {
    ...base,
    execute: async (...args) => {
      const result = await execute(...args)
      if (result.ok === false) {
        throw new WxToolError(result.code, result.message, result.detail ?? '')
      }
      return String(result.text ?? '')
    },
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
