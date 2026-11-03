/**
 * vector.js —— 可选的本地向量侧车（B 档）
 *
 * 只做三件事：
 *   1. 读 ~/.dsh-wx/context.json，只认本机 http 地址（见 parseVectorConfig）；
 *   2. 调本地侧车的 /embed，把当前会话的消息做成向量；
 *   3. 余弦排序，返回和 A 档同样形状的结果，交给 RRF 融合。
 *
 * 这里不下载模型、不起服务、不读外部凭据。侧车没起或超时就返回 null，
 * 调用方静默退回 A 档；失败后 10 分钟不再试，避免每个查询都等一遍超时。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { cosine, parseVectorConfig } from './retrieval.js'

export const DEFAULT_CONFIG = '/home/str1k3/.dsh-wx/context.json'
export const DEFAULT_CACHE_DIR = '/home/str1k3/.dsh-wx/vectors'
export const REQUEST_TIMEOUT_MS = 1500
export const BREAKER_MS = 10 * 60_000
export const CONFIG_TTL_MS = 60_000
export const BATCH = 32
export const MAX_DOCS = 300

const hashOf = (text) => createHash('sha256').update(String(text ?? '')).digest('hex')

const vectorOf = (row) => {
  if (Array.isArray(row)) return row
  if (Array.isArray(row?.embedding)) return row.embedding
  return null
}

/** 兼容 {embeddings:[[...]]} 和 OpenAI 风格的 {data:[{embedding:[...]}]}。 */
export function embeddingsOf(body) {
  if (Array.isArray(body?.embeddings)) return body.embeddings.map(vectorOf).filter(Boolean)
  if (Array.isArray(body?.data)) return body.data.map(vectorOf).filter(Boolean)
  return []
}

/**
 * @param {object} [opts]
 * @param {string} [opts.configFile]
 * @param {string} [opts.cacheDir]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createVectorProvider({
  configFile = DEFAULT_CONFIG,
  cacheDir = DEFAULT_CACHE_DIR,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log,
} = {}) {
  let config = null
  let configReadAt = 0
  let configBroken = false
  let breakerUntil = 0
  let breakerLogged = false
  const cache = new Map() // chatId -> Map<hash(text), vector>
  const warned = new Set()

  const warnOnce = (key, msg) => {
    if (warned.has(key)) return
    warned.add(key)
    log?.(msg)
  }

  function readConfig() {
    if (now() - configReadAt < CONFIG_TTL_MS) return config
    configReadAt = now()
    let raw
    try {
      raw = readFileSync(configFile, 'utf8')
    } catch {
      config = null
      if (!configBroken) {
        configBroken = true
        warnOnce('missing', '没找到 ' + configFile + '，只用 A 档检索')
      }
      return config
    }
    const parsed = parseVectorConfig(raw)
    if (!parsed.ok) {
      config = null
      warnOnce('bad', '向量侧车配置不可用（' + parsed.why + '），只用 A 档检索')
      return config
    }
    config = parsed.config
    if (configBroken) warnOnce('recovered', '向量侧车配置已恢复')
    configBroken = false
    return config
  }

  function loadCache(chatId) {
    if (cache.has(chatId)) return cache.get(chatId)
    const file = join(cacheDir, chatId + '.json')
    let map = new Map()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(raw?.vectors ?? {})) {
        if (Array.isArray(v) && v.length) map.set(k, v)
      }
    } catch { /* 没缓存就从零开始 */ }
    cache.set(chatId, map)
    return map
  }

  function saveCache(chatId, map) {
    try {
      const file = join(cacheDir, chatId + '.json')
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const vectors = {}
      for (const [k, v] of map) vectors[k] = v
      writeFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), vectors }), { mode: 0o600 })
    } catch (err) {
      warnOnce('save:' + chatId, '向量缓存写不下（不影响本次检索）: ' + String(err?.message ?? err).slice(0, 80))
    }
  }

  async function embed(texts) {
    const cfg = readConfig()
    if (!cfg) return null
    const body = JSON.stringify({ model: cfg.model || 'default', input: texts })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Number(cfg.timeoutMs) || REQUEST_TIMEOUT_MS)
    try {
      const res = await fetchImpl(cfg.url + '/embed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
      if (!res?.ok) throw new Error('HTTP ' + String(res?.status ?? '?'))
      const out = embeddingsOf(await res.json())
      if (out.length !== texts.length) throw new Error('侧车返回的向量条数不对')
      for (const v of out) {
        if (!Array.isArray(v) || v.length !== cfg.dim) throw new Error('向量维度不是 ' + cfg.dim)
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  }

  /** 侧车失败：开闸 10 分钟，期间直接退回 A 档。 */
  function trip(err) {
    breakerUntil = now() + BREAKER_MS
    if (!breakerLogged) {
      breakerLogged = true
      log?.('向量侧车不可用，10 分钟内只用 A 档：' + String(err?.message ?? err).slice(0, 120))
    }
  }

  /**
   * @returns {Promise<Array<{doc:object,score:number,reasons:string[]}>|null>}
   *   null 表示「这一档现在不可用」，不是「没有结果」。
   */
  async function provider({ query = '', docs = [], task } = {}) {
    const cfg = readConfig()
    if (!cfg || now() < breakerUntil) return null
    if (!Array.isArray(docs) || !docs.length) return null
    if (typeof fetchImpl !== 'function') return null

    // 只给最近的一段做向量：全量嵌入会让第一次查询等太久，也没有必要。
    const list = docs.slice(-MAX_DOCS).filter((d) => d?.msgId && d.text)
    if (!list.length) return null
    // 模型或维度换了，旧缓存不能再用：键里带上这两项。
    const keyOf = (text) => hashOf(`${cfg.model}\u001f${cfg.dim}\u001f${String(text ?? '')}`)
    const chatId = String(task?.chatId ?? list[0]?.chatId ?? 'unknown')
    const map = loadCache(chatId)
    const missing = list.filter((d) => {
      const v = map.get(keyOf(d.text))
      return !v || v.length !== cfg.dim
    })
    const added = []

    try {
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH)
        const vecs = await embed(batch.map((d) => String(d.text)))
        if (!vecs) return null
        batch.forEach((d, j) => {
          const key = keyOf(d.text)
          map.set(key, vecs[j])
          added.push(key)
        })
      }
      const qv = (await embed([String(query)]))?.[0]
      if (!qv) return null
      const rows = []
      for (const doc of list) {
        const v = map.get(keyOf(doc.text))
        if (!v) continue
        const score = cosine(qv, v)
        if (score > 0) rows.push({ doc, score, matched: [], reasons: ['语义近邻'] })
      }
      rows.sort((a, b) => b.score - a.score)
      return rows.slice(0, 20)
    } catch (err) {
      trip(err)
      return null
    } finally {
      if (added.length) saveCache(chatId, map)
    }
  }

  return { provider, readConfig, configFile, cacheDir }
}

/** 供自检/配置界面用：配置文件存在与否。 */
export const hasVectorConfig = (file = DEFAULT_CONFIG) => existsSync(file)
