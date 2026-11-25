/**
 * directory.js —— 会话目录：跨页枚举侧栏、稳定 chatId、全名解析
 *
 * 为什么不能只看侧栏当前页：
 *   窗口一次只显示八九行，新会话或很久没打开的群永远进不了认知；
 *   侧栏顺序又会随新消息变，靠「第几行」记住一个群一定会错。
 *   这里把每次看到的名字合并进 ~/.dsh-wx/directory.json，chatId 一旦分配就不换。
 *
 * 三条规则：
 *   1. 名字是名字：只从会话行第一行取，别处的字不可能是会话名。
 *   2. 截断名只能看、不能发。`nameConfidence` 是 exact / resolved 才允许作为发送目标；
 *      truncated / ambiguous 一律不猜。
 *   3. chatId 稳定：同一个群即使后来补齐全名，也用第一次分配的 id，不改台账的账本名。
 *
 * 目录是派生索引，不是消息真相；台账才是。目录写坏了可以从侧栏重扫，不会丢消息。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isIgnoredChat } from './capture.js'
import { chatIdFor } from './ledger.js'
import { chatIdSeed, cleanTruncated, displayName, foldedKey, graphemeLength, nameKey, sanitizeName, skeleton } from './name.js'
import { parsePreviewSender } from './speaker.js'

export const DIRECTORY_VERSION = 1
export const DEFAULT_DIRECTORY = '/home/str1k3/.dsh-wx/directory.json'
export const MAX_ALIASES = 12

const str = (v) => String(v ?? '').trim()
const norm = displayName
const nowIso = (now) => new Date(Number(now()) || Date.now()).toISOString()
const TRUNCATED = /(?:\.{2,}|…)\s*$/u

/** 侧栏 / OCR 里常见的截断尾巴，去掉后再做唯一前缀匹配。 */
export function stripEllipsis(name) {
  return str(name).replace(/\s*(?:\.{2,}|…)\s*$/u, '').trim()
}
export const looksTruncated = (name) => TRUNCATED.test(str(name))

/** 历史临时 id：种子只做 trim + 压空白，保证已有 c_tmp_* 不漂移。 */
const tempIdFor = (name) => 'c_tmp_' + createHash('sha256').update(chatIdSeed(name)).digest('hex').slice(0, 10)
const isTempChatId = (chatId) => str(chatId).startsWith('c_tmp_')

/**
 * 在权威名字（允许名单 / 已知全名）里找一个唯一前缀。
 * 找不到或撞名返回空；这里不做「包含」匹配。
 * 前缀比较走折叠键和字素计数，避免把旗帜/ZWJ 序列切成半个代理。
 */
export function uniquePrefix(name, names = []) {
  const base = cleanTruncated(stripEllipsis(name))
  if (!base || graphemeLength(base) < 2) return ''
  const list = [...new Set((names ?? []).map(displayName).filter(Boolean))]
  const exact = list.find((n) => nameKey(n) === nameKey(name))
  if (exact) return exact
  if (!looksTruncated(name)) return ''
  const baseFold = foldedKey(base)
  const hits = list.filter((n) => foldedKey(n).startsWith(baseFold))
  return hits.length === 1 ? hits[0] : ''
}

function blankEntry(name, at) {
  return {
    chatId: '',
    displayName: name,
    fullName: '',
    aliases: [],
    kind: 'unknown',
    nameConfidence: 'truncated',
    resolvedBy: '',
    firstSeenAt: at,
    lastSeenAt: at,
    lastPreview: '',
    lastSender: null,
    unread: 0,
    lastNonZeroUnread: 0,
    lastNonZeroAt: '',
    pinned: false,
    position: 0,
  }
}

function readEntries(file, log) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const chats = Array.isArray(raw?.chats) ? raw.chats : []
    return chats
      .filter((c) => c && typeof c === 'object' && str(c.chatId))
      .map((c) => {
        // 只清不可见字符，不剥省略号、不去 VS/ZWJ/肤色/keycap。
        const shown = sanitizeName(String(c.displayName ?? ''))
        const full = sanitizeName(String(c.fullName ?? ''))
        const fallback = shown || full || str(c.chatId)
        return {
          ...blankEntry(fallback, str(c.firstSeenAt) || nowIso(Date.now)),
          ...c,
          displayName: shown || fallback,
          fullName: full,
          aliases: Array.isArray(c.aliases)
            ? c.aliases.map((a) => sanitizeName(String(a ?? ''))).filter(Boolean).slice(0, MAX_ALIASES)
            : [],
        }
      })
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.('会话目录读不出来，按空目录处理：' + String(err?.message ?? err).slice(0, 120))
    return []
  }
}

/** 条目上可用于比较的名字（去重后）。 */
const entryNames = (e) => [...new Set([e.displayName, e.fullName, ...(e.aliases ?? [])].map(displayName).filter(Boolean))]

/**
 * @param {object} [opts]
 * @param {string} [opts.file]
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createDirectory({ file = DEFAULT_DIRECTORY, now = Date.now, log } = {}) {
  let entries = readEntries(file, log)
  let dirty = false

  const emitNameMatch = (from, entry, tier) => {
    if (typeof log !== 'function' || !entry) return
    // 只给调试日志，不进模型文案。
    log('name-match ' + JSON.stringify({
      from: String(from ?? ''),
      to: entry.displayName || entry.fullName || '',
      tier,
      chatId: entry.chatId,
    }))
  }

  /** 唯一命中时再区分「规范名精确相等」和「只是折叠相等」。 */
  const classifyUnique = (probe, entry, tier) => {
    const canon = [entry.displayName, entry.fullName].filter(Boolean)
    const pk = nameKey(probe)
    if (canon.some((n) => nameKey(n) === pk)) return { status: 'exact', tier: 'exact' }
    if (canon.some((n) => foldedKey(n) === foldedKey(probe))) return { status: 'folded', tier: 'folded' }
    return { status: tier === 'skeleton' ? 'resolved' : tier, tier }
  }

  /**
   * 条目级名字匹配。
   *
   * 折叠键先分组：同一 foldedKey 命中多个条目直接 ambiguous，即使其中一个
   * 与输入精确相等也不挑。只有折叠唯一时才按 tiers 顺序分 exact/folded/skeleton。
   * 前缀匹配按字素计数，较短一方至少 2 个字素，避免单个 emoji 吸走整组。
   */
  const lookup = (name, opts = {}) => {
    const tiers = Array.isArray(opts.tiers) && opts.tiers.length ? opts.tiers : ['exact', 'folded']
    const clean = displayName(name)
    if (!clean) return { status: 'unknown', matches: [], entry: null, tier: '' }
    const truncatedInput = looksTruncated(name)
    const prefix = opts.prefix === true || truncatedInput
    const probe = truncatedInput ? (cleanTruncated(stripEllipsis(clean)) || clean) : clean
    if (!probe) return { status: 'unknown', matches: [], entry: null, tier: '' }
    const pool = entries
      .map((e) => ({ e, names: entryNames(e) }))
      .filter((x) => x.names.length)

    if (tiers.includes('folded')) {
      const fk = foldedKey(probe)
      const clashes = pool.filter(({ names }) => names.some((n) => foldedKey(n) === fk)).map((x) => x.e)
      if (clashes.length > 1) return { status: 'ambiguous', matches: clashes, entry: null, tier: 'folded' }
    }

    for (const tier of tiers) {
      const keyFn = tier === 'exact' ? nameKey : tier === 'folded' ? foldedKey : tier === 'skeleton' ? skeleton : null
      if (!keyFn) throw new Error(`unknown name tier: ${tier}`)
      // 精确层保留原始输入（含省略号），这样存过的截断写法本身仍是强证据；
      // 更宽的层才用清理过尾巴的 probe 做前缀比较。
      const tierProbe = tier === 'exact' ? clean : probe
      const key = keyFn(tierProbe)
      // 纯 emoji 名字的骨架为空；空键不能拿来前缀匹配，否则会吸走整组。
      if (!key) continue
      const hits = []
      for (const { e, names } of pool) {
        const hit = names.find((n) => {
          const nk = keyFn(n)
          if (nk === key) return true
          if (!prefix) return false
          if (!nk.startsWith(key) && !key.startsWith(nk)) return false
          return Math.min(graphemeLength(nk), graphemeLength(key)) >= 2
        })
        if (hit) hits.push(e)
      }
      if (hits.length === 1) {
        const classified = classifyUnique(tierProbe, hits[0], tier)
        return { status: classified.status, matches: hits, entry: hits[0], tier: classified.tier }
      }
      if (hits.length > 1) return { status: 'ambiguous', matches: hits, entry: null, tier }
    }

    return { status: 'unknown', matches: [], entry: null, tier: '' }
  }

  const findMatches = (name) => lookup(name, { tiers: ['exact', 'folded'] }).matches
  const findByName = (name) => {
    const r = lookup(name, { tiers: ['exact', 'folded'] })
    return r.status === 'ambiguous' ? null : r.entry
  }

  /**
   * 加载时扫描折叠撞名：排除临时条目，不覆盖 duplicate-name 的自愈标记。
   * 只标 ambiguous，不删除、不合并。
   */
  const markFoldedCollisions = () => {
    const groups = new Map()
    for (const e of entries) {
      if (isTempChatId(e.chatId)) continue
      for (const key of new Set(entryNames(e).map(foldedKey).filter(Boolean))) {
        const list = groups.get(key) ?? []
        list.push(e)
        groups.set(key, list)
      }
    }
    let changed = false
    for (const list of groups.values()) {
      const unique = [...new Set(list)]
      if (unique.length < 2) continue
      for (const e of unique) {
        if (e.resolvedBy === 'duplicate-name') continue
        if (e.nameConfidence === 'ambiguous' && e.resolvedBy === 'folded-collision') continue
        e.nameConfidence = 'ambiguous'
        e.resolvedBy = 'folded-collision'
        changed = true
      }
    }
    if (changed) dirty = true
  }
  markFoldedCollisions()

  const markAmbiguous = (list, why = 'name-collision') => {
    let changed = false
    for (const e of new Set(list)) {
      if (e.nameConfidence === 'ambiguous') continue
      e.nameConfidence = 'ambiguous'
      e.resolvedBy = why
      changed = true
    }
    if (changed) dirty = true
  }
  const byId = () => new Map(entries.map((e) => [e.chatId, e]))

  function save() {
    if (!dirty) return { ok: true, skipped: true }
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({
        version: DIRECTORY_VERSION,
        updatedAt: nowIso(now),
        chats: entries,
      }, null, 2), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      dirty = false
      return { ok: true }
    } catch (err) {
      log?.('会话目录写不进去：' + String(err?.message ?? err).slice(0, 160))
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
  }

  /**
   * 合并一页侧栏。返回这一页里新增/更新的条目。
   *
   * @param {object} req
   * @param {Array<object>} req.chats 侧栏行 {name, unread, mention, draft, pinned, preview, time, box}
   * @param {string} [req.current] 当前会话（全名）
   * @param {string} [req.source] tree / ocr
   * @param {string[]} [req.knownNames] 权威全名（允许名单等）
   * @param {string[]} [req.directNames] 私聊名单
   * @param {string[]} [req.ignoreChats] 服务号会话；不再写它们的预览内容
   * @param {boolean} [req.reconcile] 这一次是完整扫描：只出现一次的名字可以洗掉重复名临时记录
   */
  function merge({
    chats = [], current = '', source = 'tree', knownNames = [], directNames = [], ignoreChats = [],
    reconcile = false,
  } = {}) {
    const at = nowIso(now)
    // 树不可用时 OCR 只负责名字：预览/发送者/未读/置顶都是屏幕上可能串行的东西，
    // 交给树或目录扫描确认后再写。
    const namesOnly = source === 'ocr'
    const authoritative = [
      ...(knownNames ?? []).map(str).filter(Boolean),
      ...entries.map((e) => e.fullName).filter(Boolean),
    ]
    const direct = new Set((directNames ?? []).map(norm).filter(Boolean))
    const touched = []
    const inputCounts = new Map()
    for (const row of chats) {
      const name = norm(row?.name)
      if (name) inputCounts.set(name, (inputCounts.get(name) ?? 0) + 1)
    }
    const seenInput = new Map()

    // 完整扫描只看到一个名字：说明侧栏里并没有两个同名会话。
    // 之前按「同名不是身份」留下的临时记录（c_tmp_*）是扫描接缝的产物，
    // 不清掉就会永远撞名。只清「一个稳定条目 + 若干临时重复条目」这种形状；
    // 两个稳定条目同名，或只有临时条目时，一律继续保持 fail closed。
    if (reconcile) {
      for (const [name, count] of inputCounts) {
        if (count !== 1) continue
        const matches = findMatches(name)
        if (matches.length < 2) continue
        const stable = matches.filter((e) => !isTempChatId(e.chatId))
        const temps = matches.filter((e) => isTempChatId(e.chatId) && e.resolvedBy === 'duplicate-name')
        if (stable.length !== 1 || temps.length === 0) continue
        entries = entries.filter((e) => !temps.includes(e))
        dirty = true
      }
    }

    const upsert = (rawName, row = {}) => {
      const name = norm(rawName)
      if (!name) return null
      const occurrence = seenInput.get(name) ?? 0
      seenInput.set(name, occurrence + 1)
      if ((inputCounts.get(name) ?? 0) > 1) {
        // 同名行没有第二个稳定身份可用；用可重放的临时 id 留下两条 ambiguous 记录，
        // 发送和 idFor 都会因为一对多而拒绝。
        const existing = findMatches(name)
        markAmbiguous(existing, 'duplicate-name')
        touched.push(...existing)
        const tempId = tempIdFor(`${name}#${occurrence}`)
        let dup = byId().get(tempId)
        if (!dup) {
          dup = blankEntry(name, at)
          dup.chatId = tempId
          entries.push(dup)
        }
        dup.displayName = name
        dup.fullName = name
        dup.nameConfidence = 'ambiguous'
        dup.resolvedBy = 'duplicate-name'
        dup.lastSeenAt = at
        dirty = true
        touched.push(dup)
        return dup
      }
      const ignored = isIgnoredChat(name, ignoreChats)
      const truncated = looksTruncated(name)
      const resolvedFull = truncated ? uniquePrefix(name, authoritative) : ''
      const fullName = truncated ? resolvedFull : name

      const nameMatches = findMatches(name)
      const fullNameMatches = fullName && nameKey(fullName) !== nameKey(name) ? findMatches(fullName) : []
      const matches = [...new Set([...nameMatches, ...fullNameMatches])]
      if (matches.length > 1) {
        markAmbiguous(matches)
        touched.push(...matches)
        return null
      }
      let e = matches[0] ?? null
      if (!e) {
        // 用全名派生 id；截断名用临时 id，解析后保留这个 id（台账不能换账本名）。
        // 种子用原始观察名（trim + 压空白）：NFC 清洗不能移动已有 id。
        const idSeed = truncated ? resolvedFull : str(rawName)
        e = blankEntry(fullName || name, at)
        e.chatId = idSeed ? chatIdFor(chatIdSeed(idSeed)) : tempIdFor(rawName)
        if (!byId().has(e.chatId)) entries.push(e)
        else e = byId().get(e.chatId)
      }

      // 折叠命中保留已存规范名，新写法进 aliases；
      // 只有已存截断名、这次观察到非截断全名时才提升。
      const storedTruncated = looksTruncated(e.displayName) || e.nameConfidence === 'truncated'
      const promoteTo = storedTruncated ? (truncated ? resolvedFull : name) : ''
      if (promoteTo) {
        const seen = new Set(e.aliases ?? [])
        for (const old of [e.displayName, e.fullName]) {
          if (old && nameKey(old) !== nameKey(promoteTo)) seen.add(old)
        }
        e.aliases = [...seen].filter(Boolean).slice(-MAX_ALIASES)
        e.displayName = promoteTo
        e.fullName = promoteTo
        e.nameConfidence = truncated ? 'resolved' : 'exact'
        e.resolvedBy = truncated ? 'known-name-prefix' : (str(row.resolvedBy) || e.resolvedBy || 'sidebar')
      } else {
        const seen = new Set(e.aliases ?? [])
        const known = new Set([e.displayName, e.fullName, ...seen].filter(Boolean).map(nameKey))
        for (const observed of [name, fullName]) {
          if (!observed || known.has(nameKey(observed))) continue
          seen.add(observed)
          known.add(nameKey(observed))
        }
        if (!e.displayName) e.displayName = fullName || name
        if (!e.fullName && fullName) e.fullName = fullName
        e.aliases = [...seen].filter(Boolean).slice(-MAX_ALIASES)
        if (truncated) {
          e.nameConfidence = e.fullName ? 'resolved' : 'truncated'
          e.resolvedBy = resolvedFull && e.fullName === resolvedFull
            ? 'known-name-prefix'
            : (e.fullName ? (e.resolvedBy || '') : '')
        } else {
          e.nameConfidence = 'exact'
          e.resolvedBy = str(row.resolvedBy) || e.resolvedBy || 'sidebar'
        }
      }
      if (direct.has(norm(name)) || direct.has(norm(e.fullName))) e.kind = 'dm'
      else if (row.kind) e.kind = str(row.kind)
      else if (!namesOnly && row.preview && /\S[:：]\s*\S/.test(String(row.preview))) e.kind = 'group'
      e.lastSeenAt = at
      if (!e.firstSeenAt) e.firstSeenAt = at
      if (!namesOnly && row.preview !== undefined) {
        // 服务号只更新元数据，不把预览正文写进目录。
        if (!ignored) e.lastPreview = String(row.preview ?? '').slice(0, 240)
        e.lastSender = parsePreviewSender(row.preview).sender ?? e.lastSender ?? null
      }
      if (!namesOnly && row.unread !== undefined) {
        const u = Math.max(0, Number(row.unread) || 0)
        e.unread = u
        if (u > 0) { e.lastNonZeroUnread = u; e.lastNonZeroAt = at }
      }
      if (!namesOnly && row.pinned !== undefined) e.pinned = row.pinned === true
      if (!namesOnly && Number.isFinite(Number(row.position))) e.position = Number(row.position)
      const names = [e.displayName, e.fullName, ...(e.aliases ?? [])].map(norm).filter(Boolean)
      const collisions = [...new Set(names.flatMap((n) => findMatches(n)).filter((x) => x !== e))]
      if (collisions.length) {
        markAmbiguous([e, ...collisions], 'name-or-alias-reuse')
        touched.push(e, ...collisions)
        return null
      }
      dirty = true
      touched.push(e)
      return e
    }

    chats.forEach((row, i) => {
      if (row?.name) upsert(row.name, { ...row, position: i, resolvedBy: source })
    })
    if (current) {
      const e = upsert(current, { resolvedBy: 'current-chat-header', kind: direct.has(norm(current)) ? 'dm' : undefined })
      if (e) e.lastSeenAt = at
    }
    // 当前会话是全名时，把它当作权威，供下一次合并解析截断行。
    const fulls = entries.map((e) => e.fullName).filter(Boolean)
    if (fulls.length) {
      for (const e of entries) {
        if (e.nameConfidence === 'truncated' && !e.fullName) {
          const hit = uniquePrefix(e.displayName, fulls)
          if (hit) {
            e.aliases = [...new Set([...(e.aliases ?? []), e.displayName])].slice(-MAX_ALIASES)
            e.fullName = hit
            e.displayName = hit
            e.nameConfidence = 'resolved'
            e.resolvedBy = 'known-name-prefix'
            dirty = true
          }
        }
      }
    }
    save()
    return { ok: true, touched: touched.map(cloneEntry), count: entries.length }
  }

  const cloneEntry = (e) => ({ ...e, aliases: [...(e.aliases ?? [])] })

  /** 稳定 chatId：目录里认识这个名字就用目录的；否则按原始名字种子派生（不入目录）。 */
  function idFor(name) {
    const r = lookup(name, { tiers: ['exact', 'folded'] })
    if (r.status === 'ambiguous') return ''
    if (r.entry) return r.entry.nameConfidence === 'ambiguous' ? '' : r.entry.chatId
    const n = norm(name)
    return n ? chatIdFor(chatIdSeed(name)) : ''
  }

  /**
   * 目录级名字解析：返回命中状态、命中条目与规范名。
   * 截断名默认启用字素前缀；唯一命中记 resolved，没有唯一命中记 truncated。
   */
  function lookupName(name, opts = {}) {
    const r = lookup(name, opts)
    let status = r.status
    if (status !== 'ambiguous') {
      if (r.entry) status = looksTruncated(name) ? 'resolved' : r.status
      else status = looksTruncated(name) ? 'truncated' : 'unknown'
    }
    if (r.entry && (r.tier === 'folded' || r.tier === 'skeleton')) emitNameMatch(name, r.entry, r.tier)
    return {
      status,
      matches: r.matches.map(cloneEntry),
      match: r.entry ? cloneEntry(r.entry) : null,
      chatId: r.entry ? str(r.entry.chatId) : '',
      displayName: r.entry ? displayName(r.entry.displayName || r.entry.fullName || '') : '',
    }
  }

  /** 会话身份键：能唯一解析时是目录 chatId；unknown 非空名按原始种子派生；其余为空。 */
  function stateKey(name) {
    const r = lookup(name, { tiers: ['exact', 'folded'] })
    if (r.entry) return str(r.entry.chatId)
    if (r.status === 'ambiguous') return ''
    const n = norm(name)
    return n ? chatIdFor(chatIdSeed(name)) : ''
  }

  /** 两个名字是否指同一个会话：两边都解析出非空身份且相同。 */
  function sameEntry(a, b) {
    const ka = stateKey(a)
    const kb = stateKey(b)
    return Boolean(ka) && ka === kb
  }

  /** 查询发送身份：同名一对多、截断、ambiguous 都 fail closed。 */
  function sendableLookup(name) {
    const r = lookup(name, { tiers: ['exact', 'folded'] })
    if (r.status === 'ambiguous') return { status: 'ambiguous', target: null }
    if (!r.entry) return { status: looksTruncated(name) ? 'truncated' : 'unknown', target: null }
    const e = r.entry
    if (e.nameConfidence !== 'exact' && e.nameConfidence !== 'resolved') {
      return { status: e.nameConfidence || 'ambiguous', target: null }
    }
    const chatName = e.fullName || e.displayName || ''
    return {
      status: e.nameConfidence,
      target: chatName && e.chatId ? { chatName, chatId: e.chatId } : null,
    }
  }

  /** 能作为发送目标的全名：只有 exact / resolved。截断名、歧义名返回空。 */
  function sendableName(name) {
    return sendableLookup(name).target?.chatName || ''
  }

  /** exact / resolved 名字的发送目标：规范名 + 稳定 chatId；其余不猜。 */
  function sendableTarget(name) {
    return sendableLookup(name).target
  }

  /** 截断名 → 全名（只做已知名字的唯一前缀；不做包含）。 */
  function resolveName(name) {
    const e = findByName(name)
    if (e?.fullName) return e.fullName
    const known = entries.map((x) => x.fullName).filter(Boolean)
    return uniquePrefix(name, known) || str(name)
  }

  function entry(name) {
    const e = findByName(name)
    return e ? cloneEntry(e) : null
  }

  function all() {
    return [...entries].sort((a, b) => (a.position - b.position) || a.displayName.localeCompare(b.displayName, 'zh'))
  }

  function snapshot() {
    return { version: DIRECTORY_VERSION, updatedAt: nowIso(now), chats: all() }
  }

  function stats() {
    const list = entries
    return {
      total: list.length,
      exact: list.filter((e) => e.nameConfidence === 'exact').length,
      resolved: list.filter((e) => e.nameConfidence === 'resolved').length,
      truncated: list.filter((e) => e.nameConfidence === 'truncated').length,
      ambiguous: list.filter((e) => e.nameConfidence === 'ambiguous').length,
      unread: list.filter((e) => e.unread > 0).length,
    }
  }

  function reset() {
    entries = []
    dirty = true
    save()
  }

  return {
    file, merge, lookupName, stateKey, sameEntry, idFor,
    sendableLookup, sendableName, sendableTarget, resolveName, entry, all, snapshot, stats, save, reset,
  }
}

const sameName = (a, b) => norm(a) === norm(b)
/** 两行有可比的预览/时间且一致，才算「同一行」的强证据。 */
const sameScanRow = (a, b) => {
  if (!sameName(a?.name, b?.name)) return false
  const ap = norm(a?.preview)
  const bp = norm(b?.preview)
  if (ap && bp) return ap === bp
  const at = norm(a?.time)
  const bt = norm(b?.time)
  if (at && bt) return at === bt
  // 同名不是身份。接缝两侧没有可比的预览/时间时保留两行，交给目录按撞名 fail closed。
  return false
}

/**
 * 侧栏跨页枚举。只读：只滚侧栏，不点开会话、不改变当前会话。
 *
 * @param {object} req
 * @param {() => Promise<{ok:boolean, parsed?:object}>} req.read 读一页（应带当前会话与 chats）
 * @param {(opts:{x:number,y:number,direction:'up'|'down',times:number})=>Promise<any>} req.scroll
 * @param {(ms:number)=>Promise<void>} [req.sleep]
 * @param {number} [req.maxPages]
 * @param {(page:object, index:number)=>void} [req.onPage]
 */
export async function scanSidebar({
  read, scroll, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPages = 8, onPage,
} = {}) {
  const first = await read()
  if (!first?.parsed?.ok || !Array.isArray(first.parsed.chats) || first.parsed.chats.length === 0) {
    return { ok: false, why: '侧栏读不到', pages: 0, chats: [] }
  }
  const pageChats = (p) => (p?.parsed?.chats ?? []).filter((c) => str(c?.name))
  if (pageChats(first).some((c) => c.draft)) {
    return { ok: false, why: '有会话带草稿，先不滚动', pages: 0, chats: [] }
  }

  const collected = []
  let previousRows = []
  const collect = (page, index, { samePage = false } = {}) => {
    const rows = pageChats(page)
    let overlap = 0
    if (index > 0) {
      if (samePage) {
        // 滚到底时列表不再移动：这一页就是刚才那一页，逐行对照更新，绝不能再收一遍。
        overlap = Math.min(previousRows.length, rows.length)
      } else if (previousRows.length && rows.length) {
        const max = Math.min(previousRows.length, rows.length)
        for (let n = max; n > 0; n--) {
          const tail = previousRows.slice(-n)
          if (!tail.every((row, i) => sameName(row?.name, rows[i]?.name))) continue
          // 两行以上按名字连续对上，足以认定是滚动接缝上的同一段。
          // 只有单行重叠时名字不算身份：还必须预览/时间也一致，
          // 否则相邻的两个同名会话会被吃掉一个。
          const strong = n === 1 ? sameScanRow(tail[0], rows[0]) : true
          if (strong) {
            overlap = n
            break
          }
        }
      }
    }
    if (index === 0) {
      collected.push(...rows)
    } else {
      // 重叠页只更新上一页已有行；重叠区之外即使撞名也是另一行，不能按名字吃掉。
      for (let i = 0; i < overlap; i++) {
        const prev = previousRows[previousRows.length - overlap + i]
        if ((!prev.preview && rows[i].preview) || Number(rows[i].unread) > Number(prev.unread)) {
          Object.assign(prev, rows[i])
        }
      }
      collected.push(...rows.slice(overlap))
    }
    previousRows = rows
    onPage?.(page, index)
    return { overlap, fresh: index === 0 ? rows.length : Math.max(0, rows.length - overlap) }
  }
  collect(first, 0)

  let sig = pageChats(first).map((c) => norm(c.name)).join('‖')
  let pages = 1
  let scrolled = 0
  let reason = 'max-pages'
  const anchor = first.parsed.chats.at(-1)?.box
  if (!anchor) return { ok: false, why: '侧栏没有可用坐标', pages: 1, chats: collected }

  while (pages < Math.max(1, Number(maxPages) || 8)) {
    await scroll({ x: anchor.cx, y: anchor.cy, direction: 'down', times: 5 })
    await sleep(450)
    const page = await read()
    if (!page?.parsed?.ok) { reason = 'tree-lost'; break }
    const rows = pageChats(page)
    if (rows.some((c) => c.draft)) { reason = 'draft'; break }
    const nextSig = rows.map((c) => norm(c.name)).join('‖')
    const { fresh } = collect(page, pages, { samePage: nextSig === sig })
    pages += 1
    scrolled += 1
    if (nextSig === sig || fresh === 0) { reason = 'bottom'; break }
    sig = nextSig
  }

  // 回到顶部：向上滚同样页数。滚过头也不会改变当前会话，只是列表位置。
  for (let i = 0; i < scrolled; i++) {
    await scroll({ x: anchor.cx, y: anchor.cy, direction: 'up', times: 5 })
    await sleep(220)
  }
  return {
    ok: true,
    pages,
    scrolled,
    reason,
    complete: reason === 'bottom',
    chats: collected,
  }
}

/** 合并多页时的去重：截断名和全名指向同一个会话时，保留全名。 */
export function mergeScanned(chats = []) {
  const out = []
  for (const chat of chats) {
    const name = norm(chat?.name)
    if (!name) continue
    const base = stripEllipsis(name)
    const hit = out.find((c) => {
      const n = norm(c.name)
      if (n === name) return false
      if (!looksTruncated(c.name) && !looksTruncated(name)) return false
      return base.length >= 2 && (n.startsWith(base) || name.startsWith(stripEllipsis(n)))
    })
    if (!hit) { out.push({ ...chat, name }); continue }
    const hitTrunc = looksTruncated(hit.name)
    const thisTrunc = looksTruncated(name)
    if (hitTrunc && !thisTrunc) Object.assign(hit, chat, { name })
    else if (!hitTrunc && thisTrunc) { /* 保留已有的全名 */ }
    else if (Number(chat.unread) > Number(hit.unread)) hit.unread = chat.unread
    if (!hit.preview && chat.preview) hit.preview = chat.preview
  }
  return out
}

/** 目录文件是否存在（自检/工作台用）。 */
export const directoryExists = (file = DEFAULT_DIRECTORY) => existsSync(file)

/** 测试用：确保目录父路径存在。 */
export const ensureDirectoryParent = (file = DEFAULT_DIRECTORY) => mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
