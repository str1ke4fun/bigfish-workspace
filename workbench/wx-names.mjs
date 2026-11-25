/**
 * 工作台的名字工具：乱码判定、名单规范化、状态键。
 *
 * 名字语义以 dsh-wx 的 lib/name.js 为准。工作台默认直接引用仓库里的那份
 * （测试和同仓开发走这条）；生产启动时 server.mjs 调 `loadNameModule`，
 * 从 wx.sh 同目录（或 WX_LIB）加载部署版本的 name.js，避免工作台和插件
 * 各自理解一套名字。部署版加载失败时保留仓库副本并记日志；再失败才退回
 * 本地 `trim + 压空白` 的弱实现。
 *
 * 零依赖：只用 node 内置模块。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as repoName from '../src/dsh-wx/lib/name.js'

/** 兜底：name.js 完全不可用时，只做 trim + 压空白。 */
const LOCAL_FALLBACK = {
  displayName: (value) => String(value ?? '').trim().replace(/\s+/g, ' '),
  sanitizeName: (value) => String(value ?? ''),
  graphemeLength: (value) => {
    const s = String(value ?? '')
    try {
      const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' })
      let n = 0
      for (const _ of seg.segment(s)) n++
      return n
    } catch {
      return Array.from(s).length
    }
  },
  matchOne: (input, candidates, opts = {}) => {
    // 没有 name.js 时无法折叠变体选择符，只能做精确（trim 后）比较。
    const norm = LOCAL_FALLBACK.displayName
    const want = norm(input)
    const list = (Array.isArray(candidates) ? candidates : []).map(norm).filter(Boolean)
    const hits = list.filter((c) => c === want)
    if (hits.length === 1) return { status: 'exact', match: hits[0], matches: hits }
    if (hits.length > 1) return { status: 'ambiguous', match: null, matches: hits }
    return { status: 'unknown', match: null, matches: [] }
  },
}

const REQUIRED = ['displayName', 'graphemeLength', 'matchOne', 'sanitizeName']

/** 当前正在用的 name 实现；静态默认是仓库副本。 */
let impl = adopt(repoName) ?? LOCAL_FALLBACK
let implSource = implementSource(repoName) ? 'repo' : 'fallback'

function implementSource(mod) {
  return mod && REQUIRED.every((key) => typeof mod[key] === 'function') ? 'repo' : ''
}

function adopt(mod) {
  if (!implementSource(mod)) return null
  return {
    displayName: mod.displayName,
    sanitizeName: mod.sanitizeName,
    graphemeLength: mod.graphemeLength,
    matchOne: mod.matchOne,
  }
}

/** 当前实现来源：deployment / repo / fallback。调试和自检用。 */
export function nameModuleSource() {
  return implSource
}

/**
 * 换成另一份 name.js 实现。返回是否成功；失败时保留原实现并记日志。
 * 供启动流程和测试注入。
 */
export function useNameModule(mod, { source = 'deployment', log } = {}) {
  const next = adopt(mod)
  if (!next) {
    log?.('工作台拿到的 name.js 形状不对，继续用现有实现')
    return false
  }
  impl = next
  implSource = source
  return true
}

/**
 * 从部署目录加载 name.js。
 *
 * @param {object} [opts]
 * @param {string} [opts.wxLib] 部署的 dsh-wx/lib 目录，或直接是 name.js 文件
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 * @returns {Promise<boolean>}
 */
export async function loadNameModule({ wxLib, log } = {}) {
  const dir = String(wxLib ?? '').trim()
  if (!dir) return false
  const file = dir.endsWith('.js') ? dir : join(dir, 'name.js')
  try {
    const mod = await import(pathToFileURL(file).href)
    const ok = useNameModule(mod, { source: 'deployment', log })
    if (!ok) log?.('部署的 name.js 不可用，改用仓库副本：' + file)
    return ok
  } catch (err) {
    log?.('工作台读不到部署的 name.js，改用仓库副本：' + String(err?.message ?? err).slice(0, 120))
    return false
  }
}

// ---------- 乱码判定 ----------

const NAME_CHARACTER = /[\p{L}\p{N}\p{Emoji}]/u

/** 有没有孤立代理（成对代理会被按码点跳过）。 */
function hasLoneSurrogate(value) {
  const s = String(value ?? '')
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * 名字是否明显是编码坏掉的产物。
 *
 * - U+FFFD：坏。
 * - 孤立代理：坏。
 * - `?` ≥2 且占字素 ≥50%，并且整串没有任何字母/数字/emoji：坏。
 *   合法 emoji、单个 `?`、`什么??` 这类正常问句都不会命中。
 */
export function looksGarbled(name) {
  const s = String(name ?? '')
  if (!s) return false
  if (s.includes('�')) return true
  if (hasLoneSurrogate(s)) return true
  const q = (s.match(/\?/g) || []).length
  if (q < 2) return false
  if (NAME_CHARACTER.test(s)) return false
  const total = impl.graphemeLength(s)
  return total > 0 && q / total >= 0.5
}

// ---------- 名单规范化 ----------

/**
 * 逐条校验保存名单。
 *
 * 坏条目（乱码、空名、同一名单里折叠撞名）按条返回，绝不静默丢弃；
 * 精确重复只保留一条（没有丢信息）。调用方拿到 `bad` 时整份拒绝保存。
 *
 * @param {string[]} list
 * @returns {{ kept: string[], bad: Array<{name: string, why: string}> }}
 */
export function sanitizePolicyList(list) {
  const kept = []
  const bad = []
  if (!Array.isArray(list)) return { kept, bad }
  const seen = new Set()
  for (const raw of list) {
    const name = String(raw ?? '').trim()
    if (!name) {
      bad.push({ name: '', why: '空名字' })
      continue
    }
    if (seen.has(name)) continue
    if (looksGarbled(name)) {
      bad.push({ name, why: '名字里有乱码（U+FFFD、孤立代理或连续问号）' })
      continue
    }
    const hit = impl.matchOne(name, kept, { tiers: ['folded'] })
    if (hit.status === 'folded' || hit.status === 'ambiguous') {
      bad.push({ name, why: `和「${hit.match || hit.matches?.[0] || '名单里另一个名字'}」折叠后撞名` })
      continue
    }
    seen.add(name)
    kept.push(name)
  }
  return { kept, bad }
}

/** 去掉确认被截断的尾巴（只认省略号，工作台不需要更激进的清理）。 */
function stripTruncated(value) {
  return impl.displayName(String(value ?? '').replace(/\s*(?:\.{2,}|…)\s*$/u, ''))
}

const REWRITABLE = new Set(['exact', 'resolved'])

/**
 * 在目录条目里解析一个名单名。
 *
 * - exact / folded：唯一命中且条目 nameConfidence 是 exact/resolved 才改写。
 * - ambiguous：命中的条目自己标了 ambiguous，或折叠键撞到多个条目。
 * - truncated：命中的是截断条目（不做改写，交给调用方拒绝）。
 * - unknown：目录里没见过，原样返回。
 *
 * @param {string} name
 * @param {object[]} entries directory.json 的 chats
 * @returns {{ status: string, name: string, nameConfidence: string, chatId: string }}
 */
function resolvePolicyName(name, entries) {
  const clean = impl.displayName(name)
  const unknown = { status: 'unknown', name: clean, nameConfidence: 'unknown', chatId: '' }
  if (!clean) return { ...unknown, name: '' }
  const list = Array.isArray(entries) ? entries : []
  const pairs = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const names = [...new Set([
      entry.displayName,
      entry.fullName,
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    ].map((v) => impl.displayName(v)).filter(Boolean))]
    for (const n of names) pairs.push({ entry, name: n })
  }
  const candidates = [...new Set(pairs.map((p) => p.name))]
  const hit = impl.matchOne(clean, candidates, { tiers: ['exact', 'folded'] })
  if (hit.status === 'ambiguous') {
    return { status: 'ambiguous', name: clean, nameConfidence: 'ambiguous', chatId: '' }
  }
  if (hit.status === 'exact' || hit.status === 'folded') {
    // 两个字面相同的名字也可能属于两个条目（撞名）；不能因为候选去重就只认第一个。
    const owners = [...new Set(pairs.filter((p) => p.name === hit.match).map((p) => p.entry))]
    if (owners.length > 1) {
      return { status: 'ambiguous', name: clean, nameConfidence: 'ambiguous', chatId: '' }
    }
    const owner = owners[0]
    const confidence = String(owner?.nameConfidence ?? '').trim()
    const chatId = String(owner?.chatId ?? '').trim()
    if (REWRITABLE.has(confidence)) {
      return {
        status: hit.status,
        name: impl.displayName(owner.displayName || owner.fullName || hit.match),
        nameConfidence: confidence,
        chatId,
      }
    }
    return {
      status: confidence === 'ambiguous' ? 'ambiguous' : (confidence || 'unknown'),
      name: clean,
      nameConfidence: confidence || 'unknown',
      chatId,
    }
  }
  // 精确/折叠都没命中：截断条目允许用「去省略号后的唯一前缀」指认，
  // 但它仍然不能作为可发送的规范名，只报 truncated。
  const truncatedHits = []
  for (const pair of pairs) {
    if (String(pair.entry?.nameConfidence ?? '') !== 'truncated') continue
    const base = stripTruncated(pair.name)
    if (!base) continue
    const r = impl.matchOne(clean, [base], { tiers: ['exact', 'folded'], prefix: true })
    if (r.status === 'exact' || r.status === 'folded') truncatedHits.push(pair.entry)
  }
  const uniqueTruncated = [...new Set(truncatedHits)]
  if (uniqueTruncated.length > 1) {
    return { status: 'ambiguous', name: clean, nameConfidence: 'ambiguous', chatId: '' }
  }
  if (uniqueTruncated.length === 1) {
    return {
      status: 'truncated',
      name: clean,
      nameConfidence: 'truncated',
      chatId: String(uniqueTruncated[0].chatId ?? '').trim(),
    }
  }
  return unknown
}

/**
 * 名单名 → 目录规范名。只有 exact/folded 命中且条目 exact/resolved 才改写；
 * truncated/ambiguous 报状态但不改写；unknown 原样返回 trim 后的名字。
 *
 * @param {string} name
 * @param {object[]} entries
 * @returns {{ status: 'exact'|'folded'|'ambiguous'|'unknown'|'truncated', name: string }}
 */
export function canonicalizePolicyName(name, entries) {
  const r = resolvePolicyName(name, entries)
  return { status: r.status, name: r.name }
}

/**
 * 候选名在目录里的匹配信息。工作台用它给候选加 nameConfidence / matchStatus。
 *
 * @param {string} name
 * @param {object[]} entries
 * @returns {{ status: string, name: string, nameConfidence: string, chatId: string }}
 */
export function describePolicyName(name, entries) {
  return resolvePolicyName(name, entries)
}

/**
 * 在政策名单里按 exact → folded 找当前会话对应的条目。
 * 撞名/找不到返回空串（调用方 fail closed）。
 *
 * @param {string} name
 * @param {string[]} candidates
 * @returns {string}
 */
export function matchPolicyName(name, candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  if (!list) return ''
  const hit = impl.matchOne(name, list, { tiers: ['exact', 'folded'] })
  return hit.status === 'exact' || hit.status === 'folded' ? hit.match : ''
}
