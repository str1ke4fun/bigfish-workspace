/**
 * tool-ledger.js —— 工具调用完整台账
 *
 * 这是事件流之外的**审计旁路**，不是她的记忆：
 *   - 不进 events.jsonl，不参与 deriveSelf / her_recall；
 *   - 每次工具调用一行，按 UTC 日期追加到 <root>/tool-ledger/YYYY-MM-DD.jsonl；
 *   - 大结果先脱敏再落 <root>/tool-ledger/artifacts/<id>.json，台账只留 sha256 指针。
 *
 * 三条硬约束：
 *   1. 只读观察 `tools/result`，绝不改写工具结果；监听器与写入都自己 try/catch。
 *   2. 任何写失败只让 status().failed +1、record() 返回 null，绝不抛进工具路径。
 *   3. cookie / token / sk- 这类凭据在 args、value、content、modelText 里都会被替换成
 *      `[redacted]`，不能借台账漏到磁盘。
 *
 * 同一进程内用一条 Promise 队列串行追加，避免两个工具同时写把一行劈开。
 */

import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { paths } from './store.js'

const REDACTED = '[redacted]'
const LEDGER_VERSION = 1
const PROJECTION_VERSION = 1
const DEFAULT_MAX_INLINE_BYTES = 32768

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

function asWarn(log) {
  if (typeof log === 'function') return log
  if (typeof log?.warn === 'function') return (...args) => log.warn(...args)
  return undefined
}

/** content（块数组）→ 模型实际读到的纯文本。 */
function modelTextOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function errorTextOf(result) {
  const err = result?.error
  if (err == null) return null
  if (typeof err === 'string') return err
  if (typeof err?.message === 'string' && err.message) return err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

/**
 * 创建工具台账。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 数据根（默认 paths().root）
 * @param {{ looksLikeSecret: (text: string) => { hit: boolean, why?: string } }} [opts.guard]
 * @param {Function} [opts.log] 失败日志（宿主 logger.warn 或普通函数）
 * @param {() => number} [opts.now] 时钟，测试可注入
 * @param {number} [opts.maxInlineBytes] value 超过多少字节落 artifact
 * @param {(agent: any) => string|null} [opts.surfaceOf] 面板判定（record 未显式传 surface 时用）
 */
export function createToolLedger({
  root = paths().root,
  guard,
  log,
  now = Date.now,
  maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
  surfaceOf,
} = {}) {
  const p = paths(root)
  const warn = asWarn(log)
  const maxBytes = Number.isFinite(maxInlineBytes) && maxInlineBytes > 0 ? maxInlineBytes : DEFAULT_MAX_INLINE_BYTES

  const state = { ok: true, written: 0, failed: 0, lastError: null, artifacts: 0 }

  // 同一进程内的追加队列：失败不毒化后续写入。
  let tail = Promise.resolve()

  function markFailed(err) {
    state.failed++
    state.ok = false
    state.lastError = String(err?.message ?? err).slice(0, 300)
    try { warn?.(`[dsh-fish] 工具台账写入失败：${state.lastError}`) } catch { /* ignore */ }
  }

  function secretHit(text) {
    try { return guard?.looksLikeSecret?.(text)?.hit === true } catch { return false }
  }

  /**
   * 递归脱敏并返回可 JSON 化的副本。命中任何字符串凭据 → 整串换成 [redacted]。
   * @param {any} value
   * @param {{ redacted: boolean }} redactState
   * @param {WeakSet<object>} seen 防循环引用
   */
  function redact(value, redactState, seen) {
    if (typeof value === 'string') {
      if (secretHit(value)) {
        redactState.redacted = true
        return REDACTED
      }
      return value
    }
    if (value instanceof Error) return redact(String(value.message ?? value), redactState, seen)
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map((item) => redact(item, redactState, seen))
    if (value && typeof value === 'object') {
      if (seen.has(value)) return null // 循环引用：丢掉这一支，别让整次写入失败
      seen.add(value)
      const out = {}
      for (const key of Object.keys(value)) out[key] = redact(value[key], redactState, seen)
      return out
    }
    return value
  }

  function sanitize(value, redactState) {
    return redact(value, redactState, new WeakSet())
  }

  function surfaceFor(exec, extra) {
    let surface
    try {
      surface = extra?.surface ?? (typeof surfaceOf === 'function' ? surfaceOf(exec?.agent) : null)
    } catch {
      surface = null
    }
    return typeof surface === 'string' && surface !== '' ? surface : null
  }

  function durationFor(extra) {
    if (Number.isFinite(extra?.durationMs)) return Math.max(0, extra.durationMs)
    if (Number.isFinite(extra?.startedAt)) {
      const delta = now() - extra.startedAt
      if (Number.isFinite(delta) && delta >= 0) return delta
    }
    return 0
  }

  /** 纯函数：把一次调用整理成台账记录（尚未落盘）。 */
  function buildEntry(exec, result, extra) {
    const id = `tc_${randomUUID()}`
    const ts = new Date(now()).toISOString()
    const redactState = { redacted: false }

    const args = sanitize(exec?.arguments ?? {}, redactState)
    const rawValue = result?.value ?? null
    const value = sanitize(rawValue, redactState)
    const content = sanitize(result?.content ?? [], redactState)
    const modelText = sanitize(modelTextOf(content), redactState)

    const isError = result?.isError === true
    const ok = !isError && rawValue?.ok !== false
    const code = rawValue?.code ?? result?.error?.info?.code ?? ''
    const error = isError ? errorTextOf(result) : null

    const handles = sanitize(rawValue?.handles ?? [], redactState)
    const refs = sanitize(rawValue?.refs ?? {}, redactState)
    const effects = sanitize(rawValue?.effects ?? null, redactState)

    // 大字段：先脱敏，再算 sha256（对脱敏后的字节），原始值绝不落盘。
    const valueJson = JSON.stringify(value)
    let entryValue = value
    let artifact = null
    if (typeof valueJson === 'string' && Buffer.byteLength(valueJson, 'utf8') > maxBytes) {
      const bytes = Buffer.byteLength(valueJson, 'utf8')
      const sha256 = sha256Hex(valueJson)
      const artifactPath = join(p.toolLedgerArtifacts, `${id}.json`)
      artifact = { path: artifactPath, json: valueJson, bytes, sha256 }
      entryValue = { artifact: artifactPath, bytes, sha256 }
    }

    const entry = {
      v: LEDGER_VERSION,
      id,
      ts,
      surface: surfaceFor(exec, extra),
      sessionId: String(exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? ''),
      tool: String(exec?.name ?? ''),
      args,
      argsHash: `sha256:${sha256Hex(JSON.stringify(args))}`,
      redacted: redactState.redacted,
      ok,
      code,
      durationMs: durationFor(extra),
      value: entryValue,
      content,
      modelText,
      handles,
      refs,
      effects,
      error,
      projectionVersion: PROJECTION_VERSION,
    }

    if (artifact) {
      entry.artifact = artifact.path
      entry.bytes = artifact.bytes
      entry.sha256 = artifact.sha256
    }

    return { entry, artifact }
  }

  async function persist(entry, artifact) {
    if (artifact) {
      await fs.mkdir(p.toolLedgerArtifacts, { recursive: true, mode: 0o700 })
      await fs.chmod(p.toolLedgerArtifacts, 0o700).catch(() => {})
      await fs.writeFile(artifact.path, artifact.json, { encoding: 'utf8', mode: 0o600 })
      await fs.chmod(artifact.path, 0o600).catch(() => {})
    }

    await fs.mkdir(p.toolLedgerDir, { recursive: true, mode: 0o700 })
    const file = join(p.toolLedgerDir, `${entry.ts.slice(0, 10)}.jsonl`)
    const line = JSON.stringify(entry) + '\n'
    const handle = await fs.open(file, 'a', 0o600)
    try {
      await handle.chmod(0o600).catch(() => {})
      await handle.write(line)
    } finally {
      await handle.close()
    }
  }

  function enqueue(task) {
    const run = tail.then(task)
    // 队列本身永远保持 fulfilled：一次写失败不能堵死后面的调用。
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 记一次工具调用；永不抛出。写失败返回 null，并让 status().failed +1。
   * @returns {Promise<object|null>}
   */
  function record(exec, result, extra = {}) {
    let built
    try {
      built = buildEntry(exec, result, extra)
    } catch (err) {
      markFailed(err)
      return Promise.resolve(null)
    }

    return enqueue(async () => {
      await persist(built.entry, built.artifact)
      state.written++
      if (built.artifact) state.artifacts++
      return built.entry
    }).then(
      (entry) => entry,
      (err) => {
        markFailed(err)
        return null
      },
    )
  }

  /**
   * 监听宿主的 `tools/result`（结果快照，不是 waterfall）。
   * 监听器整体 try/catch：台账问题绝不改写工具结果。
   */
  function register(ctx) {
    if (typeof ctx?.on !== 'function') return () => {}
    const listener = (exec, result) => {
      try {
        void record(exec, result, {})
      } catch (err) {
        markFailed(err)
      }
    }
    try {
      const off = ctx.on('tools/result', listener)
      return typeof off === 'function' ? off : () => {}
    } catch (err) {
      markFailed(err)
      return () => {}
    }
  }

  function status() {
    return { ...state }
  }

  return { register, record, status }
}
