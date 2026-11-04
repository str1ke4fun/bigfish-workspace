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
import { parsePreviewSender } from './speaker.js'

export const DIRECTORY_VERSION = 1
export const DEFAULT_DIRECTORY = '/home/str1k3/.dsh-wx/directory.json'
export const MAX_ALIASES = 12

const str = (v) => String(v ?? '').trim()
const norm = (v) => str(v).replace(/\s+/g, ' ')
const nowIso = (now) => new Date(Number(now()) || Date.now()).toISOString()
const TRUNCATED = /(?:\.{2,}|…)\s*$/u

/** 侧栏 / OCR 里常见的截断尾巴，去掉后再做唯一前缀匹配。 */
export function stripEllipsis(name) {
  return str(name).replace(/\s*(?:\.{2,}|…)\s*$/u, '').trim()
}
export const looksTruncated = (name) => TRUNCATED.test(str(name))

const tempIdFor = (name) => 'c_tmp_' + createHash('sha256').update(norm(name)).digest('hex').slice(0, 10)

/**
 * 在权威名字（允许名单 / 已知全名）里找一个唯一前缀。
 * 找不到或撞名返回空；这里不做「包含」匹配。
 */
export function uniquePrefix(name, names = []) {
  const base = stripEllipsis(name)
  if (base.length < 2) return ''
  const list = [...new Set((names ?? []).map(norm).filter(Boolean))]
  const exact = list.find((n) => n === norm(name))
  if (exact) return exact
  if (!looksTruncated(name)) return ''
  const hits = list.filter((n) => n.startsWith(base))
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
      .map((c) => ({
        ...blankEntry(str(c.displayName || c.fullName || c.chatId), str(c.firstSeenAt) || nowIso(Date.now)),
        ...c,
        aliases: Array.isArray(c.aliases) ? c.aliases.map(str).filter(Boolean).slice(0, MAX_ALIASES) : [],
      }))
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.('会话目录读不出来，按空目录处理：' + String(err?.message ?? err).slice(0, 120))
    return []
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file]
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createDirectory({ file = DEFAULT_DIRECTORY, now = Date.now, log } = {}) {
  let entries = readEntries(file, log)
  let dirty = false

  const findByName = (name) => {
    const n = norm(name)
    if (!n) return null
    return entries.find((e) => norm(e.fullName) === n || norm(e.displayName) === n ||
      (e.aliases ?? []).some((a) => norm(a) === n)) ?? null
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
   */
  function merge({
    chats = [], current = '', source = 'tree', knownNames = [], directNames = [], ignoreChats = [],
  } = {}) {
    const at = nowIso(now)
    const authoritative = [
      ...(knownNames ?? []).map(str).filter(Boolean),
      ...entries.map((e) => e.fullName).filter(Boolean),
    ]
    const direct = new Set((directNames ?? []).map(norm).filter(Boolean))
    const touched = []

    const upsert = (rawName, row = {}) => {
      const name = norm(rawName)
      if (!name) return null
      const ignored = isIgnoredChat(name, ignoreChats)
      const clean = stripEllipsis(name)
      const truncated = looksTruncated(name)
      const resolvedFull = uniquePrefix(name, authoritative)
      const confidence = truncated ? (resolvedFull ? 'resolved' : 'truncated') : 'exact'
      const fullName = !truncated ? name : resolvedFull
      const displayName = fullName || name

      let e = findByName(name) || (fullName ? findByName(fullName) : null)
      if (!e) {
        // 用全名派生 id；截断名用临时 id，解析后保留这个 id（台账不能换账本名）。
        e = blankEntry(displayName, at)
        e.chatId = fullName ? chatIdFor(fullName) : tempIdFor(name)
        if (!byId().has(e.chatId)) entries.push(e)
        else e = byId().get(e.chatId)
      }
      const seen = new Set(e.aliases ?? [])
      if (name !== displayName) seen.add(name)
      if (e.displayName && e.displayName !== displayName) seen.add(e.displayName)
      if (fullName && e.fullName && e.fullName !== fullName) seen.add(e.fullName)
      e.aliases = [...seen].filter(Boolean).slice(-MAX_ALIASES)
      e.displayName = displayName
      e.fullName = fullName || e.fullName
      e.nameConfidence = e.fullName && confidence === 'truncated' ? 'resolved' : confidence
      e.resolvedBy = e.fullName
        ? (fullName && fullName !== name ? 'known-name-prefix' : row.resolvedBy || e.resolvedBy || 'sidebar')
        : ''
      if (direct.has(norm(name)) || direct.has(norm(e.fullName))) e.kind = 'dm'
      else if (row.kind) e.kind = str(row.kind)
      else if (row.preview && /\S[:：]\s*\S/.test(String(row.preview))) e.kind = 'group'
      e.lastSeenAt = at
      if (!e.firstSeenAt) e.firstSeenAt = at
      if (row.preview !== undefined) {
        // 服务号只更新元数据，不把预览正文写进目录。
        if (!ignored) e.lastPreview = String(row.preview ?? '').slice(0, 240)
        e.lastSender = parsePreviewSender(row.preview).sender ?? e.lastSender ?? null
      }
      if (row.unread !== undefined) {
        const u = Math.max(0, Number(row.unread) || 0)
        e.unread = u
        if (u > 0) { e.lastNonZeroUnread = u; e.lastNonZeroAt = at }
      }
      if (row.pinned !== undefined) e.pinned = row.pinned === true
      if (Number.isFinite(Number(row.position))) e.position = Number(row.position)
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

  /** 稳定 chatId：目录里认识这个名字就用目录的；否则按全名派生（不入目录）。 */
  function idFor(name) {
    const e = findByName(name)
    if (e) return e.chatId
    const n = norm(name)
    return n ? chatIdFor(n) : ''
  }

  /** 能作为发送目标的全名：只有 exact / resolved。截断名、歧义名返回空。 */
  function sendableName(name) {
    const e = findByName(name)
    if (!e) return ''
    if (e.nameConfidence !== 'exact' && e.nameConfidence !== 'resolved') return ''
    return e.fullName || e.displayName || ''
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
    file, merge, idFor, sendableName, resolveName, entry, all, snapshot, stats, save, reset,
  }
}

const sameName = (a, b) => norm(a) === norm(b)

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

  const seen = new Map() // norm(name) -> chat
  const collect = (page, index) => {
    for (const c of pageChats(page)) {
      const key = norm(c.name)
      if (!key) continue
      const prev = seen.get(key)
      // 同一行重复出现时保留信息更多的那份（有未读/预览/坐标）。
      if (!prev || (!prev.preview && c.preview) || (Number(c.unread) > Number(prev.unread))) seen.set(key, c)
    }
    onPage?.(page, index)
  }
  collect(first, 0)

  let sig = pageChats(first).map((c) => norm(c.name)).join('‖')
  let pages = 1
  let scrolled = 0
  let reason = 'max-pages'
  const anchor = first.parsed.chats.at(-1)?.box
  if (!anchor) return { ok: false, why: '侧栏没有可用坐标', pages: 1, chats: [...seen.values()] }

  while (pages < Math.max(1, Number(maxPages) || 8)) {
    await scroll({ x: anchor.cx, y: anchor.cy, direction: 'down', times: 5 })
    await sleep(450)
    const page = await read()
    if (!page?.parsed?.ok) { reason = 'tree-lost'; break }
    const rows = pageChats(page)
    if (rows.some((c) => c.draft)) { reason = 'draft'; break }
    const nextSig = rows.map((c) => norm(c.name)).join('‖')
    const fresh = rows.filter((c) => !seen.has(norm(c.name))).length
    collect(page, pages)
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
    chats: [...seen.values()],
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
      return n === name || (base.length >= 2 && (n.startsWith(base) || name.startsWith(stripEllipsis(n))))
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
